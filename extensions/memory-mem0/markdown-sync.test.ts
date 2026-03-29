import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { memoryMem0ConfigSchema } from "./config.js";
import type { ExtractedMemoryCandidate } from "./extract.js";
import { reconcileMarkdownToMem0, syncMarkdownToMem0 } from "./markdown-sync.js";
import type { ExistingMemoryCandidate } from "./storage.js";
import { Mem0Store } from "./storage.js";

describe("memory-mem0 markdown sync", () => {
  let tmpDir = "";
  let workspaceDir = "";
  let dbPath = "";

  const hashText = (value: string) => createHash("sha256").update(value).digest("hex");

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-mem0-sync-"));
    workspaceDir = path.join(tmpDir, "workspace");
    dbPath = path.join(tmpDir, "mem0.sqlite");
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("imports markdown once and skips unchanged files on later sync", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      [
        "# Preferences",
        "",
        "I prefer concise summaries in final responses and minimal code changes in reviews.",
      ].join("\n"),
      "utf8",
    );

    const cfg = memoryMem0ConfigSchema.parse({
      autoExtract: {
        minMessageLength: 12,
        delta: {
          maxMessagesPerRun: 10,
        },
      },
      sync: {
        markdownToMem0: true,
      },
    });
    const store = new Mem0Store(dbPath);
    const api = {
      config: {
        agents: {
          list: [{ id: "agent-sync", default: true, workspace: workspaceDir }],
          defaults: { workspace: workspaceDir },
        },
      },
      resolvePath: (input: string) => input,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    };
    const llmEngine = {
      extractCandidates: async (params: {
        deltaMessages: Array<{ index: number; text: string }>;
      }): Promise<ExtractedMemoryCandidate[]> =>
        params.deltaMessages.map((message) => ({
          memoryType: "semantic",
          text: message.text,
          sourceExcerpt: message.text,
          sourceMessageIndex: message.index,
        })),
      decideDedupAction: async (params: {
        candidate: ExtractedMemoryCandidate;
        existing: ExistingMemoryCandidate[];
      }) => {
        const existing = params.existing[0];
        if (existing) {
          return {
            action: "NONE" as const,
            targetMemoryId: existing.id,
            reason: "already-present",
          };
        }
        return {
          action: "ADD" as const,
          nextText: params.candidate.text,
          reason: "new-memory",
        };
      },
    };

    const first = await syncMarkdownToMem0({
      api,
      cfg,
      store,
      llmEngine,
      agentId: "agent-sync",
    });
    expect(first.scannedFiles).toBe(1);
    expect(first.importedFiles).toBe(1);
    expect(first.appliedWrites).toBeGreaterThan(0);
    expect(first.unchangedFiles).toBe(0);
    const hits = store.search({
      agentId: "agent-sync",
      query: "concise summaries",
      limit: 5,
      minScore: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.path === "MEMORY.md")).toBe(true);
    expect(
      store.listMarkdownSyncState({
        agentId: "agent-sync",
        workspaceDir,
      }),
    ).toHaveLength(1);

    const second = await syncMarkdownToMem0({
      api,
      cfg,
      store,
      llmEngine,
      agentId: "agent-sync",
    });
    expect(second.scannedFiles).toBe(1);
    expect(second.importedFiles).toBe(0);
    expect(second.unchangedFiles).toBe(1);
    expect(second.appliedWrites).toBe(0);

    store.close();
  });

  test("uses agents.defaults.workspace when agent id is default", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "memory.md"),
      "I prefer concise pull request summaries and minimal diff size.",
      "utf8",
    );

    const cfg = memoryMem0ConfigSchema.parse({
      sync: {
        markdownToMem0: true,
      },
    });
    const store = new Mem0Store(dbPath);
    const api = {
      config: {
        agents: {
          defaults: { workspace: workspaceDir },
        },
      },
      resolvePath: (input: string) => input,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    };
    const llmEngine = {
      extractCandidates: async (params: {
        deltaMessages: Array<{ index: number; text: string }>;
      }): Promise<ExtractedMemoryCandidate[]> =>
        params.deltaMessages.map((message) => ({
          memoryType: "semantic",
          text: message.text,
          sourceExcerpt: message.text,
          sourceMessageIndex: message.index,
        })),
      decideDedupAction: async () => ({
        action: "ADD" as const,
        reason: "new-memory",
      }),
    };

    const summary = await syncMarkdownToMem0({
      api,
      cfg,
      store,
      llmEngine,
      agentId: "default",
    });
    expect(summary.workspaceDir).toBe(workspaceDir);
    expect(summary.scannedFiles).toBe(1);
    expect(summary.importedFiles).toBe(1);

    store.close();
  });

  test("reconcileMarkdownToMem0 reports changed, moved, deleted, missing, and stale mappings", async () => {
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });

    const changedCurrentContent = "Current workspace content for MEMORY.md";
    const movedContent = "Moved content that should match by hash";
    const staleStateContent = "Stale state row file content";
    const orphanExistingContent = "Source file exists but sync state is missing";

    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), changedCurrentContent, "utf8");
    await fs.writeFile(path.join(workspaceDir, "memory", "moved-new.md"), movedContent, "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "stale-state.md"),
      staleStateContent,
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "orphan-existing.md"),
      orphanExistingContent,
      "utf8",
    );

    const cfg = memoryMem0ConfigSchema.parse({
      sync: {
        markdownToMem0: true,
      },
    });
    const store = new Mem0Store(dbPath);
    const agentId = "agent-reconcile";
    const syncedAt = Date.now() - 10_000;

    store.upsertMarkdownSyncState({
      agentId,
      workspaceDir,
      relPath: "MEMORY.md",
      contentHash: hashText("Original synced MEMORY.md content"),
      mtimeMs: syncedAt,
      importedCount: 1,
      syncedAt,
    });
    store.upsertMarkdownSyncState({
      agentId,
      workspaceDir,
      relPath: "memory/moved-old.md",
      contentHash: hashText(movedContent),
      mtimeMs: syncedAt,
      importedCount: 1,
      syncedAt,
    });
    store.upsertMarkdownSyncState({
      agentId,
      workspaceDir,
      relPath: "memory/deleted.md",
      contentHash: hashText("Deleted markdown file content"),
      mtimeMs: syncedAt,
      importedCount: 1,
      syncedAt,
    });
    store.upsertMarkdownSyncState({
      agentId,
      workspaceDir,
      relPath: "memory/stale-state.md",
      contentHash: hashText(staleStateContent),
      mtimeMs: syncedAt,
      importedCount: 2,
      syncedAt,
    });

    store.applyDecisions({
      agentId,
      sessionKey: "memory-sync:test",
      runId: "reconcile-fixture",
      decisions: [
        {
          candidate: {
            memoryType: "semantic",
            text: "Changed memory mapping fixture",
            sourceRelPath: "MEMORY.md",
            sourceExcerpt: "changed fixture",
            sourceMessageIndex: 0,
          },
          action: "ADD",
        },
        {
          candidate: {
            memoryType: "semantic",
            text: "Moved memory mapping fixture",
            sourceRelPath: "memory/moved-old.md",
            sourceExcerpt: "moved fixture",
            sourceMessageIndex: 1,
          },
          action: "ADD",
        },
        {
          candidate: {
            memoryType: "semantic",
            text: "Deleted memory mapping fixture",
            sourceRelPath: "memory/deleted.md",
            sourceExcerpt: "deleted fixture",
            sourceMessageIndex: 2,
          },
          action: "ADD",
        },
        {
          candidate: {
            memoryType: "semantic",
            text: "Orphan existing mapping fixture",
            sourceRelPath: "memory/orphan-existing.md",
            sourceExcerpt: "orphan existing fixture",
            sourceMessageIndex: 3,
          },
          action: "ADD",
        },
        {
          candidate: {
            memoryType: "semantic",
            text: "Orphan missing mapping fixture",
            sourceRelPath: "memory/orphan-missing.md",
            sourceExcerpt: "orphan missing fixture",
            sourceMessageIndex: 4,
          },
          action: "ADD",
        },
      ],
    });

    const api = {
      config: {
        agents: {
          list: [{ id: agentId, default: true, workspace: workspaceDir }],
          defaults: { workspace: workspaceDir },
        },
      },
      resolvePath: (input: string) => input,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    };

    const summary = await reconcileMarkdownToMem0({
      api,
      cfg,
      store,
      agentId,
    });

    expect(summary.workspaceDir).toBe(workspaceDir);
    expect(summary.changedFiles).toBe(1);
    expect(summary.movedFiles).toBe(1);
    expect(summary.deletedFiles).toBe(1);
    expect(summary.missingFiles).toBe(1);
    expect(summary.staleMappings).toBe(2);
    expect(summary.unresolvedMappings).toBe(6);

    const movedIssue = summary.issues.find(
      (issue) => issue.kind === "moved" && issue.relPath === "memory/moved-old.md",
    );
    expect(movedIssue?.movedToRelPath).toBe("memory/moved-new.md");

    const staleStateIssue = summary.issues.find(
      (issue) =>
        issue.kind === "stale_mapping" &&
        issue.relPath === "memory/stale-state.md" &&
        issue.staleReason === "state_without_memories",
    );
    expect(staleStateIssue).toBeDefined();

    const staleMemoryIssue = summary.issues.find(
      (issue) =>
        issue.kind === "stale_mapping" &&
        issue.relPath === "memory/orphan-existing.md" &&
        issue.staleReason === "memory_without_state",
    );
    expect(staleMemoryIssue).toBeDefined();

    store.close();
  });
});
