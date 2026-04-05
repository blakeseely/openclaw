import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type TSchema, Type } from "@sinclair/typebox";
import {
  type OpenClawPluginApi,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/memory-core";

function stringEnum<T extends readonly string[]>(values: T, description?: string): TSchema {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(description ? { description } : {}),
  });
}
import { fallbackCategoryFromType, getCategoryImportance } from "./categories.js";
import {
  DEDUP_ACTIONS,
  MEMORY_TYPES,
  type Mem0Config,
  memoryMem0ConfigSchema,
  resolveStorePathTemplate,
} from "./config.js";
import { collectDeltaMessages, looksLikePromptInjection } from "./extract.js";
import { isInternalMem0Session, Mem0LlmEngine } from "./llm.js";
import {
  reconcileMarkdownToMem0,
  resolveWorkspaceDirForAgent,
  syncMarkdownToMem0,
  type MarkdownReconcileSummary,
  type MarkdownSyncSummary,
} from "./markdown-sync.js";
import { buildRecallContext } from "./recall.js";
import { registerMemoryReviewCli } from "./review-cli.js";
import { type MemoryApplyDecision, Mem0Store } from "./storage.js";

function createRunId(prefix: string): string {
  return `${prefix}:${Date.now()}:${randomUUID().slice(0, 8)}`;
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  if (!sessionKey) {
    return "direct";
  }
  const tokens = new Set(sessionKey.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}

function scopeAllowed(cfg: Mem0Config, sessionKey?: string): boolean {
  const chatType = deriveChatTypeFromSessionKey(sessionKey);
  let allowed = cfg.scope.default === "allow";
  for (const rule of cfg.scope.rules) {
    if (rule.match.chatType && rule.match.chatType !== chatType) {
      continue;
    }
    allowed = rule.action === "allow";
    break;
  }
  return allowed;
}

function normalizeMarkdownPath(relPath: string): string | null {
  const trimmed = relPath.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("~")) {
    return null;
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    return null;
  }
  const normalized = parts.join("/");
  if (!normalized.toLowerCase().endsWith(".md")) {
    return null;
  }
  return normalized;
}

function lineWindow(text: string, from?: number, lines?: number): string {
  const allLines = text.split(/\r?\n/);
  const fromLine = Math.max(1, Math.floor(from ?? 1));
  const count = lines !== undefined ? Math.max(0, Math.floor(lines)) : allLines.length;
  const startIndex = Math.min(allLines.length, fromLine - 1);
  const endIndex = Math.min(allLines.length, startIndex + count);
  const selected = count <= 0 ? [] : allLines.slice(startIndex, endIndex);
  return selected.join("\n");
}

const memoryPlugin = {
  id: "memory-mem0",
  name: "Memory (mem0)",
  description: "mem0-style typed memory plugin with recall, capture, and human CLI review",
  kind: "memory" as const,
  configSchema: memoryMem0ConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = memoryMem0ConfigSchema.parse(api.pluginConfig ?? {});
    const stores = new Map<string, Mem0Store>();
    const lastCaptureBySession = new Map<string, number>();
    const llmEngine = new Mem0LlmEngine(api, cfg);
    const completedMarkdownSyncAgents = new Set<string>();
    const markdownSyncInFlight = new Map<string, Promise<MarkdownSyncSummary>>();
    let loggedMem0ToMarkdownWarning = false;

    const getStore = (agentIdInput?: string) => {
      const agentId = agentIdInput || "default";
      const existing = stores.get(agentId);
      if (existing) {
        return existing;
      }
      const templatedPath = resolveStorePathTemplate(cfg.store.path, agentId);
      const resolvedPath = api.resolvePath(templatedPath);
      const store = new Mem0Store(resolvedPath);
      stores.set(agentId, store);
      return store;
    };

    const maybeWarnMem0ToMarkdown = () => {
      if (!cfg.sync.mem0ToMarkdown || loggedMem0ToMarkdownWarning) {
        return;
      }
      loggedMem0ToMarkdownWarning = true;
      api.logger.warn(
        "memory-mem0: sync.mem0ToMarkdown is configured but not implemented in phase 1; ignoring.",
      );
    };

    const logSyncSummary = (summary: MarkdownSyncSummary) => {
      if (
        summary.importedFiles <= 0 &&
        summary.failedFiles <= 0 &&
        summary.appliedWrites <= 0 &&
        summary.scannedFiles <= 0
      ) {
        return;
      }
      api.logger.info(
        `memory-mem0: markdown sync agent=${summary.agentId} scanned=${summary.scannedFiles} imported=${summary.importedFiles} unchanged=${summary.unchangedFiles} failed=${summary.failedFiles} writes=${summary.appliedWrites}`,
      );
      if (summary.usedHeuristicFallback) {
        api.logger.warn(
          `memory-mem0: markdown sync used heuristic extraction fallback for agent=${summary.agentId}`,
        );
      }
    };

    const runMarkdownSync = async (
      params: {
        agentId?: string;
        force?: boolean;
      } = {},
    ): Promise<MarkdownSyncSummary | null> => {
      if (!cfg.sync.markdownToMem0) {
        maybeWarnMem0ToMarkdown();
        return null;
      }

      maybeWarnMem0ToMarkdown();
      const agentId = params.agentId || "default";
      const force = params.force === true;
      if (!force && completedMarkdownSyncAgents.has(agentId)) {
        return null;
      }
      if (!force) {
        const existing = markdownSyncInFlight.get(agentId);
        if (existing) {
          return existing;
        }
      }

      const store = getStore(agentId);
      const syncPromise = (async () => {
        const summary = await syncMarkdownToMem0({
          api,
          cfg,
          store,
          llmEngine,
          agentId,
          force,
        });
        completedMarkdownSyncAgents.add(agentId);
        logSyncSummary(summary);
        return summary;
      })();

      if (!force) {
        markdownSyncInFlight.set(agentId, syncPromise);
        syncPromise.then(
          () => {
            if (markdownSyncInFlight.get(agentId) === syncPromise) {
              markdownSyncInFlight.delete(agentId);
            }
          },
          () => {
            if (markdownSyncInFlight.get(agentId) === syncPromise) {
              markdownSyncInFlight.delete(agentId);
            }
          },
        );
      }

      return syncPromise;
    };

    const runMarkdownReconcile = async (params: {
      agentId?: string;
    }): Promise<MarkdownReconcileSummary> => {
      maybeWarnMem0ToMarkdown();
      const agentId = params.agentId || "default";
      const store = getStore(agentId);
      return reconcileMarkdownToMem0({
        api,
        cfg,
        store,
        agentId,
      });
    };

    const readWorkspaceMarkdownPath = async (params: {
      agentId: string;
      relPath: string;
      from?: number;
      lines?: number;
    }) => {
      const normalizedRelPath = normalizeMarkdownPath(params.relPath);
      if (!normalizedRelPath) {
        return { path: params.relPath, text: "" };
      }
      const workspaceDir = resolveWorkspaceDirForAgent(api, params.agentId);
      const root = path.resolve(workspaceDir);
      const target = path.resolve(root, normalizedRelPath);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        return { path: params.relPath, text: "" };
      }

      let stat: import("node:fs").Stats;
      try {
        stat = await fs.lstat(target);
      } catch {
        return { path: normalizedRelPath, text: "" };
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { path: normalizedRelPath, text: "" };
      }

      try {
        const realRoot = await fs.realpath(root);
        const realTarget = await fs.realpath(target);
        if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
          return { path: normalizedRelPath, text: "" };
        }
      } catch {
        return { path: normalizedRelPath, text: "" };
      }

      try {
        const content = await fs.readFile(target, "utf-8");
        return {
          path: normalizedRelPath,
          text: lineWindow(content, params.from, params.lines),
        };
      } catch {
        return { path: normalizedRelPath, text: "" };
      }
    };

    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId || "default";
        const store = getStore(agentId);

        const memorySearch = {
          label: "Memory Search",
          name: "memory_search",
          description:
            "Search mem0 semantic/episodic/procedural memories and return snippets with paths for follow-up memory_get reads.",
          parameters: Type.Object({
            query: Type.String({ description: "Search query" }),
            maxResults: Type.Optional(Type.Number({ description: "Max results" })),
            minScore: Type.Optional(Type.Number({ description: "Minimum score 0-1" })),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            const query = readStringParam(params, "query", { required: true });
            const maxResults = readNumberParam(params, "maxResults", { integer: true }) ?? 5;
            const minScore = readNumberParam(params, "minScore") ?? 0.08;
            try {
              await runMarkdownSync({ agentId });
            } catch (err) {
              api.logger.warn(`memory-mem0: memory_search markdown sync failed: ${String(err)}`);
            }

            const results = store.search({
              agentId,
              query,
              limit: Math.max(1, maxResults),
              minScore: Math.max(0, Math.min(1, minScore)),
            });

            return jsonResult({
              results,
              provider: "mem0",
              model: cfg.llm.model,
              fallback: null,
            });
          },
        };

        const memoryGet = {
          label: "Memory Get",
          name: "memory_get",
          description:
            "Read a memory path returned by memory_search (virtual mem0 path or imported markdown path).",
          parameters: Type.Object({
            path: Type.String({ description: "Path from memory_search results" }),
            from: Type.Optional(Type.Number({ description: "1-based start line" })),
            lines: Type.Optional(Type.Number({ description: "Number of lines to return" })),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            const relPath = readStringParam(params, "path", { required: true });
            const from = readNumberParam(params, "from", { integer: true });
            const lines = readNumberParam(params, "lines", { integer: true });
            if (!relPath.trim().startsWith("mem0/")) {
              return jsonResult(
                await readWorkspaceMarkdownPath({
                  agentId,
                  relPath,
                  from: from ?? undefined,
                  lines: lines ?? undefined,
                }),
              );
            }
            return jsonResult(
              store.readVirtualPath({
                agentId,
                relPath,
                from: from ?? undefined,
                lines: lines ?? undefined,
              }),
            );
          },
        };

        const memoryAdd = {
          label: "Memory Add",
          name: "memory_add",
          description:
            "Explicitly add a memory item into mem0 store with type-aware deduplication.",
          parameters: Type.Object({
            text: Type.String({ description: "Memory content to store" }),
            memoryType: Type.Optional(stringEnum(MEMORY_TYPES, "Memory type")),
            namespace: Type.Optional(
              stringEnum(["user_workflow", "execution_trace"] as const, "Procedural namespace"),
            ),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            const text = readStringParam(params, "text", { required: true });
            const memoryTypeRaw = readStringParam(params, "memoryType");
            const memoryType =
              memoryTypeRaw === "episodic"
                ? "episodic"
                : memoryTypeRaw === "procedural"
                  ? "procedural"
                  : "semantic";
            const namespaceRaw = readStringParam(params, "namespace");
            const namespace =
              memoryType === "procedural" && namespaceRaw === "execution_trace"
                ? "execution_trace"
                : memoryType === "procedural"
                  ? "user_workflow"
                  : undefined;

            const category = fallbackCategoryFromType(memoryType, namespace);
            const importance = getCategoryImportance(category);

            const writes = store.upsertMemories({
              agentId,
              sessionKey: ctx.sessionKey,
              runId: createRunId("tool-add"),
              dedup: cfg.dedup,
              candidates: [
                {
                  memoryType,
                  namespace,
                  text,
                  sourceExcerpt: text,
                  category,
                  importance,
                },
              ],
            });

            return jsonResult({
              writes,
              actions: [...new Set(writes.map((entry) => entry.action))],
              dedupActions: DEDUP_ACTIONS,
            });
          },
        };

        return [memorySearch, memoryGet, memoryAdd];
      },
      { names: ["memory_search", "memory_get", "memory_add"] },
    );

    api.registerCli(
      ({ program }) => {
        registerMemoryReviewCli({
          program,
          resolveStore: (agentId) => getStore(agentId || "default"),
          feedbackConfig: cfg.feedback,
          syncMarkdown: async ({ agentId, force }) =>
            runMarkdownSync({
              agentId: agentId || "default",
              force,
            }),
          reconcileMarkdown: async ({ agentId }) =>
            runMarkdownReconcile({
              agentId: agentId || "default",
            }),
        });
      },
      { commands: [] },
    );

    const tryRecallInject = async (params: {
      prompt: string;
      agentId?: string;
      sessionKey?: string;
    }): Promise<{ prependContext: string } | void> => {
      if (!cfg.recall.enabled || params.prompt.trim().length < 5) {
        return;
      }
      if (!scopeAllowed(cfg, params.sessionKey)) {
        return;
      }
      if (isInternalMem0Session(params.sessionKey)) {
        return;
      }

      await runMarkdownSync({
        agentId: params.agentId || "default",
      });
      const agentId = params.agentId || "default";
      const store = getStore(agentId);
      const built = buildRecallContext({
        store,
        cfg,
        query: params.prompt,
        agentId,
      });
      if (!built) {
        return;
      }

      store.recordRecallEvents({
        agentId,
        sessionKey: params.sessionKey,
        runId: createRunId("recall"),
        memoryIds: built.memoryIds,
      });
      return { prependContext: built.prependContext };
    };

    api.on("before_prompt_build", async (event, ctx) => {
      try {
        return await tryRecallInject({
          prompt: event.prompt,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });
      } catch (err) {
        api.logger.warn(`memory-mem0: before_prompt_build recall failed: ${String(err)}`);
      }
    });

    api.on("agent_end", async (event, ctx) => {
      const syncAgentId = ctx.agentId || "default";
      try {
        await runMarkdownSync({ agentId: syncAgentId });
      } catch (err) {
        api.logger.warn(`memory-mem0: markdown sync failed: ${String(err)}`);
      }

      if (!cfg.autoExtract.enabled || !event.success) {
        return;
      }
      if (!Array.isArray(event.messages) || event.messages.length === 0) {
        return;
      }
      if (isInternalMem0Session(ctx.sessionKey)) {
        return;
      }
      if (!scopeAllowed(cfg, ctx.sessionKey)) {
        const safeAgentId = ctx.agentId || "default";
        const safeSessionKey = ctx.sessionKey || "session";
        try {
          const store = getStore(safeAgentId);
          store.setCursor(safeAgentId, safeSessionKey, event.messages.length - 1);
        } catch {
          // best effort cursor update
        }
        return;
      }

      const agentId = ctx.agentId || "default";
      const sessionKey = ctx.sessionKey || "session";
      const sessionMapKey = `${agentId}:${sessionKey}`;
      const now = Date.now();
      const lastCaptureAt = lastCaptureBySession.get(sessionMapKey) ?? 0;
      if (cfg.autoExtract.rateLimitSeconds > 0) {
        const minNextCaptureAt = lastCaptureAt + cfg.autoExtract.rateLimitSeconds * 1000;
        if (now < minNextCaptureAt) {
          return;
        }
      }

      try {
        const store = getStore(agentId);
        const cursor = store.getCursor(agentId, sessionKey);
        const deltaMessages = collectDeltaMessages({
          messages: event.messages,
          fromIndex: cursor,
          maxMessages: cfg.autoExtract.delta.maxMessagesPerRun,
          minMessageLength: cfg.autoExtract.minMessageLength,
          triggers: cfg.autoExtract.triggers,
        });

        const fallbackLastIndex = event.messages.length - 1;
        const lastProcessedIndex =
          deltaMessages.length > 0
            ? deltaMessages[deltaMessages.length - 1].index
            : fallbackLastIndex;

        if (deltaMessages.length === 0) {
          store.setCursor(agentId, sessionKey, lastProcessedIndex);
          return;
        }

        const candidates = await llmEngine.extractCandidates({
          deltaMessages,
          memoryTypes: cfg.autoExtract.memoryTypes,
          proceduralNamespaces: cfg.autoExtract.proceduralNamespaces,
        });
        const safeCandidates = candidates.filter(
          (candidate) => !looksLikePromptInjection(candidate.text),
        );

        const decisions: MemoryApplyDecision[] = [];
        for (const candidate of safeCandidates) {
          const existing = store.listSimilarMemories({
            agentId,
            memoryType: candidate.memoryType,
            namespace: candidate.namespace,
            text: candidate.text,
            maxCandidates: cfg.dedup.maxCandidates,
          });
          const decision = await llmEngine.decideDedupAction({
            candidate,
            existing,
          });
          decisions.push({
            candidate: {
              memoryType: candidate.memoryType,
              namespace: candidate.namespace,
              text: candidate.text,
              sourceExcerpt: candidate.sourceExcerpt,
              sourceMessageIndex: candidate.sourceMessageIndex,
              category: candidate.category,
              importance: candidate.importance,
            },
            action: decision.action,
            targetMemoryId: decision.targetMemoryId,
            nextText: decision.nextText,
            reason: decision.reason,
          });
        }

        const writes = store.applyDecisionsAndAdvanceCursor({
          agentId,
          sessionKey,
          runId: createRunId("capture"),
          lastProcessedIndex,
          decisions,
        });

        lastCaptureBySession.set(sessionMapKey, now);
        const added = writes.filter((entry) => entry.action === "ADD").length;
        const updated = writes.filter((entry) => entry.action === "UPDATE").length;
        if (added > 0 || updated > 0) {
          api.logger.info(
            `memory-mem0: captured memories add=${added} update=${updated} session=${sessionKey}`,
          );
        }
      } catch (err) {
        api.logger.warn(`memory-mem0: agent_end capture failed: ${String(err)}`);
      }
    });

    api.registerService({
      id: "memory-mem0",
      start: () => {
        api.logger.info(`memory-mem0: initialized (store template: ${cfg.store.path})`);
      },
      stop: () => {
        for (const store of stores.values()) {
          try {
            store.close();
          } catch {
            // best effort close during shutdown
          }
        }
        stores.clear();
      },
    });
  },
};

export default memoryPlugin;
