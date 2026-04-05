import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import type { Mem0Config } from "./config.js";
import {
  extractMemoryCandidates,
  looksLikePromptInjection,
  normalizeForSimilarity,
  type DeltaMessage,
  type ExtractedMemoryCandidate,
} from "./extract.js";
import type { LlmDedupDecision } from "./llm.js";
import type {
  ExistingMemoryCandidate,
  MemoryApplyDecision,
  MemoryCandidateWrite,
  Mem0Store,
} from "./storage.js";

type MarkdownSyncApi = Pick<OpenClawPluginApi, "config" | "resolvePath" | "logger">;

type MarkdownSyncLlmEngine = {
  extractCandidates(params: {
    deltaMessages: DeltaMessage[];
    memoryTypes: Mem0Config["autoExtract"]["memoryTypes"];
    proceduralNamespaces: Mem0Config["autoExtract"]["proceduralNamespaces"];
  }): Promise<ExtractedMemoryCandidate[]>;
  decideDedupAction(params: {
    candidate: ExtractedMemoryCandidate;
    existing: ExistingMemoryCandidate[];
  }): Promise<LlmDedupDecision>;
};

type MarkdownFileEntry = {
  absPath: string;
  relPath: string;
  mtimeMs: number;
  hash: string;
  content: string;
};

export type MarkdownSyncSummary = {
  enabled: boolean;
  agentId: string;
  workspaceDir: string;
  scannedFiles: number;
  importedFiles: number;
  unchangedFiles: number;
  failedFiles: number;
  extractedCandidates: number;
  appliedWrites: number;
  usedHeuristicFallback: boolean;
};

export type MarkdownReconcileIssueKind =
  | "changed"
  | "moved"
  | "deleted"
  | "missing"
  | "stale_mapping";

export type MarkdownReconcileIssue = {
  kind: MarkdownReconcileIssueKind;
  relPath: string;
  memoryCount: number;
  detail: string;
  movedToRelPath?: string;
  staleReason?: "state_without_memories" | "memory_without_state";
};

export type MarkdownReconcileSummary = {
  enabled: boolean;
  agentId: string;
  workspaceDir: string;
  scannedFiles: number;
  syncStateRows: number;
  importedSourcePaths: number;
  unresolvedMappings: number;
  changedFiles: number;
  movedFiles: number;
  deletedFiles: number;
  missingFiles: number;
  staleMappings: number;
  issues: MarkdownReconcileIssue[];
};

function createSyncRunId(prefix: string): string {
  return `${prefix}:${Date.now()}:${randomUUID().slice(0, 8)}`;
}

function normalizeAgentId(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  return trimmed || "main";
}

function resolveDefaultAgentId(config: OpenClawPluginApi["config"]): string {
  const list = Array.isArray(config.agents?.list) ? config.agents.list : [];
  if (list.length === 0) {
    return "main";
  }
  const explicitDefault = list.find((entry) => entry?.default && typeof entry.id === "string");
  if (explicitDefault?.id) {
    return normalizeAgentId(explicitDefault.id);
  }
  const first = list.find((entry) => typeof entry?.id === "string");
  return normalizeAgentId(first?.id);
}

function resolveDefaultWorkspacePath(config: OpenClawPluginApi["config"]): string {
  const configured = config.agents?.defaults?.workspace?.trim();
  if (configured) {
    return configured;
  }
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return `~/.openclaw/workspace-${profile}`;
  }
  return "~/.openclaw/workspace";
}

function resolveStateDirPath(): string {
  return (
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    "~/.openclaw"
  );
}

export function resolveWorkspaceDirForAgent(api: MarkdownSyncApi, agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  const list = Array.isArray(api.config.agents?.list) ? api.config.agents.list : [];
  const explicit = list.find(
    (entry) =>
      typeof entry?.id === "string" &&
      normalizeAgentId(entry.id) === normalizedAgentId &&
      typeof entry.workspace === "string" &&
      entry.workspace.trim().length > 0,
  );
  if (explicit?.workspace) {
    return api.resolvePath(explicit.workspace);
  }

  const defaultAgentId = resolveDefaultAgentId(api.config);
  if (normalizedAgentId === "default" || normalizedAgentId === defaultAgentId) {
    return api.resolvePath(resolveDefaultWorkspacePath(api.config));
  }

  return api.resolvePath(path.join(resolveStateDirPath(), `workspace-${normalizedAgentId}`));
}

async function listMarkdownMemoryFiles(workspaceDir: string): Promise<MarkdownFileEntry[]> {
  const discovered: string[] = [];
  const rootCandidates = [
    path.join(workspaceDir, "MEMORY.md"),
    path.join(workspaceDir, "memory.md"),
  ];
  const memoryDir = path.join(workspaceDir, "memory");

  const addMarkdownFile = async (candidatePath: string) => {
    try {
      const stat = await fs.lstat(candidatePath);
      if (stat.isSymbolicLink() || !stat.isFile() || !candidatePath.endsWith(".md")) {
        return;
      }
      discovered.push(candidatePath);
    } catch {
      // ignore missing files
    }
  };

  const walkMarkdownDir = async (dirPath: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walkMarkdownDir(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        discovered.push(fullPath);
      }
    }
  };

  for (const rootFile of rootCandidates) {
    await addMarkdownFile(rootFile);
  }
  await walkMarkdownDir(memoryDir);

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const absPath of discovered) {
    let key = absPath;
    try {
      key = await fs.realpath(absPath);
    } catch {
      // best effort key
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(absPath);
  }

  const files: MarkdownFileEntry[] = [];
  for (const absPath of deduped) {
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) {
        continue;
      }
      const content = await fs.readFile(absPath, "utf-8");
      const relPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
      files.push({
        absPath,
        relPath: relPath || path.basename(absPath),
        mtimeMs: stat.mtimeMs,
        hash: createHash("sha256").update(content).digest("hex"),
        content,
      });
    } catch {
      // ignore files that become unreadable during scan
    }
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxChars) {
      out.push(text.slice(cursor).trim());
      break;
    }
    const slice = text.slice(cursor, cursor + maxChars);
    const boundary = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("; "),
      slice.lastIndexOf(", "),
    );
    const end = boundary >= Math.floor(maxChars * 0.5) ? cursor + boundary + 1 : cursor + maxChars;
    out.push(text.slice(cursor, end).trim());
    cursor = end;
  }
  return out.filter(Boolean);
}

function buildMarkdownDeltaMessages(params: {
  content: string;
  minMessageLength: number;
  maxMessageChars: number;
}): DeltaMessage[] {
  const normalized = params.content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const withoutFences: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    withoutFences.push(line);
  }

  const blocks = withoutFences.join("\n").split(/\n{2,}/);
  const messages: DeltaMessage[] = [];
  let index = 0;
  for (const block of blocks) {
    const cleaned = block
      .split("\n")
      .map((line) =>
        line
          .trim()
          .replace(/^#+\s+/, "")
          .replace(/^[-*+]\s+/, "")
          .replace(/^\d+\.\s+/, ""),
      )
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned || cleaned.length < params.minMessageLength) {
      continue;
    }
    if (looksLikePromptInjection(cleaned)) {
      continue;
    }
    for (const piece of splitLongText(cleaned, params.maxMessageChars)) {
      if (!piece || piece.length < params.minMessageLength) {
        continue;
      }
      messages.push({
        index,
        role: "user",
        text: piece,
      });
      index += 1;
    }
  }
  return messages;
}

function chunkMessages(messages: DeltaMessage[], size: number): DeltaMessage[][] {
  const out: DeltaMessage[][] = [];
  const chunkSize = Math.max(1, size);
  for (let i = 0; i < messages.length; i += chunkSize) {
    out.push(messages.slice(i, i + chunkSize));
  }
  return out;
}

function dedupeCandidates(candidates: ExtractedMemoryCandidate[]): ExtractedMemoryCandidate[] {
  const seen = new Set<string>();
  const deduped: ExtractedMemoryCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.memoryType}:${candidate.namespace ?? "none"}:${normalizeForSimilarity(candidate.text)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function toMemoryCandidateWrites(
  candidates: ExtractedMemoryCandidate[],
  sourceRelPath?: string,
): MemoryCandidateWrite[] {
  return candidates.map((candidate) => ({
    memoryType: candidate.memoryType,
    namespace: candidate.namespace,
    text: candidate.text,
    sourceRelPath,
    sourceExcerpt: candidate.sourceExcerpt,
    sourceMessageIndex: candidate.sourceMessageIndex,
  }));
}

async function extractCandidatesForFile(params: {
  llmEngine: MarkdownSyncLlmEngine;
  cfg: Mem0Config;
  messages: DeltaMessage[];
}): Promise<{ candidates: ExtractedMemoryCandidate[]; usedHeuristicFallback: boolean }> {
  const batchSize = Math.max(1, params.cfg.autoExtract.delta.maxMessagesPerRun);
  const batches = chunkMessages(params.messages, batchSize);
  const collected: ExtractedMemoryCandidate[] = [];
  let usedHeuristicFallback = false;

  for (const batch of batches) {
    try {
      const extracted = await params.llmEngine.extractCandidates({
        deltaMessages: batch,
        memoryTypes: params.cfg.autoExtract.memoryTypes,
        proceduralNamespaces: params.cfg.autoExtract.proceduralNamespaces,
      });
      collected.push(...extracted);
    } catch {
      const fallback = extractMemoryCandidates({
        messages: batch,
        memoryTypes: params.cfg.autoExtract.memoryTypes,
        proceduralNamespaces: params.cfg.autoExtract.proceduralNamespaces,
      });
      collected.push(...fallback);
      usedHeuristicFallback = true;
    }
  }

  const safe = collected.filter((candidate) => !looksLikePromptInjection(candidate.text));
  return {
    candidates: dedupeCandidates(safe),
    usedHeuristicFallback,
  };
}

async function buildLlmDecisions(params: {
  llmEngine: MarkdownSyncLlmEngine;
  store: Mem0Store;
  cfg: Mem0Config;
  agentId: string;
  sourceRelPath: string;
  candidates: ExtractedMemoryCandidate[];
}): Promise<MemoryApplyDecision[]> {
  const decisions: MemoryApplyDecision[] = [];
  for (const candidate of params.candidates) {
    const existing = params.store.listSimilarMemories({
      agentId: params.agentId,
      memoryType: candidate.memoryType,
      namespace: candidate.namespace,
      text: candidate.text,
      maxCandidates: params.cfg.dedup.maxCandidates,
    });
    const decision = await params.llmEngine.decideDedupAction({
      candidate,
      existing,
    });
    decisions.push({
      candidate: {
        memoryType: candidate.memoryType,
        namespace: candidate.namespace,
        text: candidate.text,
        sourceRelPath: params.sourceRelPath,
        sourceExcerpt: candidate.sourceExcerpt,
        sourceMessageIndex: candidate.sourceMessageIndex,
      },
      action: decision.action,
      targetMemoryId: decision.targetMemoryId,
      nextText: decision.nextText,
      reason: decision.reason,
    });
  }
  return decisions;
}

export async function reconcileMarkdownToMem0(params: {
  api: MarkdownSyncApi;
  cfg: Mem0Config;
  store: Mem0Store;
  agentId: string;
}): Promise<MarkdownReconcileSummary> {
  const normalizedAgentId = params.agentId || "default";
  const workspaceDir = resolveWorkspaceDirForAgent(params.api, normalizedAgentId);
  const summary: MarkdownReconcileSummary = {
    enabled: params.cfg.sync.markdownToMem0,
    agentId: normalizedAgentId,
    workspaceDir,
    scannedFiles: 0,
    syncStateRows: 0,
    importedSourcePaths: 0,
    unresolvedMappings: 0,
    changedFiles: 0,
    movedFiles: 0,
    deletedFiles: 0,
    missingFiles: 0,
    staleMappings: 0,
    issues: [],
  };

  const files = await listMarkdownMemoryFiles(workspaceDir);
  summary.scannedFiles = files.length;
  const filesByRelPath = new Map(files.map((file) => [file.relPath, file]));
  const filesByHash = new Map<string, string[]>();
  for (const file of files) {
    const bucket = filesByHash.get(file.hash) ?? [];
    bucket.push(file.relPath);
    filesByHash.set(file.hash, bucket);
  }

  const stateRows = params.store.listMarkdownSyncState({
    agentId: normalizedAgentId,
    workspaceDir,
  });
  summary.syncStateRows = stateRows.length;
  const stateByRelPath = new Map(stateRows.map((row) => [row.relPath, row]));

  const importedRows = params.store.listImportedSourcePaths(normalizedAgentId);
  summary.importedSourcePaths = importedRows.length;
  const importedByRelPath = new Map(importedRows.map((row) => [row.sourceRelPath, row]));

  const issues: MarkdownReconcileIssue[] = [];
  const shortHash = (hash: string): string => hash.slice(0, 12);
  const addIssue = (issue: MarkdownReconcileIssue) => {
    issues.push(issue);
    if (issue.kind === "changed") {
      summary.changedFiles += 1;
      return;
    }
    if (issue.kind === "moved") {
      summary.movedFiles += 1;
      return;
    }
    if (issue.kind === "deleted") {
      summary.deletedFiles += 1;
      return;
    }
    if (issue.kind === "missing") {
      summary.missingFiles += 1;
      return;
    }
    summary.staleMappings += 1;
  };

  const sortedStateRows = [...stateRows].sort((a, b) => a.relPath.localeCompare(b.relPath));
  for (const row of sortedStateRows) {
    const memoryCount = importedByRelPath.get(row.relPath)?.memoryCount ?? 0;
    const currentFile = filesByRelPath.get(row.relPath);

    if (!currentFile) {
      const movedCandidates = [...(filesByHash.get(row.contentHash) ?? [])].sort((a, b) =>
        a.localeCompare(b),
      );
      if (movedCandidates.length > 0) {
        const movedToRelPath = movedCandidates[0]!;
        addIssue({
          kind: "moved",
          relPath: row.relPath,
          movedToRelPath,
          memoryCount,
          detail: `File moved: ${row.relPath} -> ${movedToRelPath}`,
        });
      } else {
        addIssue({
          kind: "deleted",
          relPath: row.relPath,
          memoryCount,
          detail: `Synced source file is missing and no hash match was found: ${row.relPath}`,
        });
      }
    } else if (currentFile.hash !== row.contentHash) {
      addIssue({
        kind: "changed",
        relPath: row.relPath,
        memoryCount,
        detail: `Content hash changed since last sync: ${shortHash(row.contentHash)} -> ${shortHash(currentFile.hash)}`,
      });
    }

    if (memoryCount === 0 && row.importedCount > 0) {
      addIssue({
        kind: "stale_mapping",
        relPath: row.relPath,
        memoryCount: 0,
        staleReason: "state_without_memories",
        detail: `Sync-state mapping exists without imported memories: ${row.relPath}`,
      });
    }
  }

  const sortedImportedRows = [...importedRows].sort((a, b) =>
    a.sourceRelPath.localeCompare(b.sourceRelPath),
  );
  for (const row of sortedImportedRows) {
    if (stateByRelPath.has(row.sourceRelPath)) {
      continue;
    }
    if (filesByRelPath.has(row.sourceRelPath)) {
      addIssue({
        kind: "stale_mapping",
        relPath: row.sourceRelPath,
        memoryCount: row.memoryCount,
        staleReason: "memory_without_state",
        detail: `Imported memories reference a file without sync-state metadata: ${row.sourceRelPath}`,
      });
      continue;
    }
    addIssue({
      kind: "missing",
      relPath: row.sourceRelPath,
      memoryCount: row.memoryCount,
      detail: `Imported memories reference a source file that no longer exists: ${row.sourceRelPath}`,
    });
  }

  issues.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind.localeCompare(b.kind);
    }
    if (a.relPath !== b.relPath) {
      return a.relPath.localeCompare(b.relPath);
    }
    return a.detail.localeCompare(b.detail);
  });

  summary.unresolvedMappings = issues.length;
  summary.issues = issues;
  return summary;
}

export async function syncMarkdownToMem0(params: {
  api: MarkdownSyncApi;
  cfg: Mem0Config;
  store: Mem0Store;
  llmEngine: MarkdownSyncLlmEngine;
  agentId: string;
  force?: boolean;
}): Promise<MarkdownSyncSummary> {
  const normalizedAgentId = params.agentId || "default";
  const workspaceDir = resolveWorkspaceDirForAgent(params.api, normalizedAgentId);
  const summary: MarkdownSyncSummary = {
    enabled: params.cfg.sync.markdownToMem0,
    agentId: normalizedAgentId,
    workspaceDir,
    scannedFiles: 0,
    importedFiles: 0,
    unchangedFiles: 0,
    failedFiles: 0,
    extractedCandidates: 0,
    appliedWrites: 0,
    usedHeuristicFallback: false,
  };

  if (!params.cfg.sync.markdownToMem0) {
    return summary;
  }

  const files = await listMarkdownMemoryFiles(workspaceDir);
  summary.scannedFiles = files.length;
  if (files.length === 0) {
    return summary;
  }

  const stateRows = params.store.listMarkdownSyncState({
    agentId: normalizedAgentId,
    workspaceDir,
  });
  const stateByRelPath = new Map(stateRows.map((row) => [row.relPath, row]));

  for (const file of files) {
    try {
      const existingState = stateByRelPath.get(file.relPath);
      if (!params.force && existingState && existingState.contentHash === file.hash) {
        summary.unchangedFiles += 1;
        continue;
      }

      const deltaMessages = buildMarkdownDeltaMessages({
        content: file.content,
        minMessageLength: params.cfg.autoExtract.minMessageLength,
        maxMessageChars: 900,
      });
      const extracted = await extractCandidatesForFile({
        llmEngine: params.llmEngine,
        cfg: params.cfg,
        messages: deltaMessages,
      });
      summary.usedHeuristicFallback ||= extracted.usedHeuristicFallback;
      summary.extractedCandidates += extracted.candidates.length;

      let writesCount = 0;
      const sessionKey = `memory-sync:markdown:${file.relPath}`;
      if (extracted.candidates.length > 0) {
        try {
          const decisions = await buildLlmDecisions({
            llmEngine: params.llmEngine,
            store: params.store,
            cfg: params.cfg,
            agentId: normalizedAgentId,
            sourceRelPath: file.relPath,
            candidates: extracted.candidates,
          });
          const writes = params.store.applyDecisions({
            agentId: normalizedAgentId,
            sessionKey,
            runId: createSyncRunId("markdown-sync"),
            decisions,
          });
          writesCount = writes.length;
        } catch {
          const writes = params.store.upsertMemories({
            agentId: normalizedAgentId,
            sessionKey,
            runId: createSyncRunId("markdown-sync-fallback"),
            dedup: params.cfg.dedup,
            candidates: toMemoryCandidateWrites(extracted.candidates, file.relPath),
          });
          writesCount = writes.length;
          summary.usedHeuristicFallback = true;
        }
      }

      summary.appliedWrites += writesCount;
      summary.importedFiles += 1;
      params.store.upsertMarkdownSyncState({
        agentId: normalizedAgentId,
        workspaceDir,
        relPath: file.relPath,
        contentHash: file.hash,
        mtimeMs: file.mtimeMs,
        importedCount: extracted.candidates.length,
      });
    } catch (err) {
      summary.failedFiles += 1;
      params.api.logger.warn(
        `memory-mem0: markdown sync failed for ${file.relPath}: ${String(err)}`,
      );
    }
  }

  return summary;
}
