import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const MEMORY_TEXT_START_LINE = 10;
const MEMORY_TYPES = ["semantic", "episodic", "procedural"] as const;
const REVIEW_RATINGS = ["keep", "wrong", "redundant", "too_specific", "too_vague"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type ProceduralNamespace = "user_workflow" | "execution_trace";
export type ReviewRating = (typeof REVIEW_RATINGS)[number];
export type DedupAction = "ADD" | "UPDATE" | "DELETE" | "NONE";

export type Mem0DedupConfig = {
  enabled: boolean;
  similarityThreshold: number;
  maxCandidates: number;
};

type SqliteDatabase = import("node:sqlite").DatabaseSync;

function requireNodeSqlite(): typeof import("node:sqlite") {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `memory-mem0: SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}

export function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeForSimilarity(text)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const aSet = new Set(a);
  const bSet = new Set(b);
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...aSet, ...bSet]).size;
  if (union === 0) {
    return 0;
  }
  return intersection / union;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function similarityScore(a: string, b: string): number {
  const normalizedA = normalizeForSimilarity(a);
  const normalizedB = normalizeForSimilarity(b);
  if (!normalizedA || !normalizedB) {
    return 0;
  }
  if (normalizedA === normalizedB) {
    return 1;
  }
  const tokensA = tokenize(normalizedA);
  const tokensB = tokenize(normalizedB);
  const jaccard = jaccardSimilarity(tokensA, tokensB);
  const includesScore =
    normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA) ? 0.2 : 0;
  const prefixScore = normalizedA.slice(0, 20) === normalizedB.slice(0, 20) ? 0.1 : 0;
  return clamp(jaccard * 0.7 + includesScore + prefixScore, 0, 1);
}

export function recallScore(query: string, text: string): number {
  const normalizedQuery = normalizeForSimilarity(query);
  const normalizedText = normalizeForSimilarity(text);
  if (!normalizedQuery || !normalizedText) {
    return 0;
  }
  const similarity = similarityScore(normalizedQuery, normalizedText);
  const queryTokens = tokenize(normalizedQuery);
  const textTokens = new Set(tokenize(normalizedText));
  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      hits += 1;
    }
  }
  const tokenCoverage = queryTokens.length === 0 ? 0 : hits / queryTokens.length;
  const containsQuery = normalizedText.includes(normalizedQuery) ? 0.2 : 0;
  return clamp(similarity * 0.6 + tokenCoverage * 0.4 + containsQuery, 0, 1);
}

export type StoredMemory = {
  id: string;
  agentId: string;
  sessionKey: string | null;
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  text: string;
  sourceRelPath: string | null;
  sourceExcerpt: string | null;
  sourceMessageIndex: number | null;
  category: string | null;
  importance: number | null;
  createdAt: number;
  updatedAt: number;
};

export type MemorySearchHit = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory";
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  category: string | null;
  importance: number | null;
};

export type MemoryCandidateWrite = {
  memoryType: MemoryType;
  namespace?: ProceduralNamespace;
  text: string;
  sourceRelPath?: string;
  sourceExcerpt?: string;
  sourceMessageIndex?: number;
  category?: string;
  importance?: number;
};

export type MemoryWriteResult = {
  memoryId: string;
  action: DedupAction;
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  score?: number;
};

export type MarkdownSyncStateRow = {
  agentId: string;
  workspaceDir: string;
  relPath: string;
  contentHash: string;
  mtimeMs: number;
  importedCount: number;
  syncedAt: number;
};

export type ImportedSourcePathRow = {
  sourceRelPath: string;
  memoryCount: number;
  latestUpdatedAt: number;
};

export type ExistingMemoryCandidate = {
  id: string;
  text: string;
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  score: number;
};

export type MemoryApplyDecision = {
  candidate: MemoryCandidateWrite;
  action: DedupAction;
  targetMemoryId?: string;
  nextText?: string;
  reason?: string;
};

export type MemoryReviewRow = {
  id: string;
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  text: string;
  sourceExcerpt: string;
  sessionKey: string | null;
  sourceMessageIndex: number | null;
  createdAt: number;
  updatedAt: number;
  dedupAction: DedupAction;
  lastReviewedAt: number | null;
};

export type QualityMemoryTypeCount = {
  memoryType: MemoryType;
  count: number;
};

export type QualityMemoryTypeNamespaceCount = {
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  count: number;
};

export type QualityCaptureSessionCount = {
  sessionKey: string | null;
  captureCount: number;
};

export type QualityDedupStats = {
  totalDecisions: number;
  dedupHits: number;
  dedupHitRate: number;
};

export type QualityRatingRow = {
  ratingId: number;
  memoryId: string;
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  rating: ReviewRating;
  note: string | null;
  sessionKey: string | null;
  runId: string | null;
  createdAt: number;
  memoryText: string;
  sourceExcerpt: string | null;
};

export type QualityGapRow = {
  gapId: number;
  sessionKey: string | null;
  runId: string | null;
  sourceExcerpt: string | null;
  expectedMemory: string | null;
  note: string | null;
  createdAt: number;
};

export type QualityNeverRecalledRow = {
  memoryId: string;
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  sessionKey: string | null;
  text: string;
  sourceExcerpt: string | null;
  createdAt: number;
  ageDays: number;
};

export type QualitySupersededRow = {
  memoryId: string;
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  text: string;
  sourceExcerpt: string | null;
  addCreatedAt: number;
  supersededAt: number;
  turnsToSupersede: number;
  elapsedMs: number;
};

export type QualitySupersededSummary = {
  quick: QualitySupersededRow[];
  totalQuickSuperseded: number;
  totalSuperseded: number;
  averageTimeToSupersedeMs: number | null;
};

function tableValueToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (value == null) {
    return "";
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? "";
  } catch {
    return "";
  }
}

function tableValueToNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const normalized = Number(value ?? 0);
  return Number.isFinite(normalized) ? normalized : 0;
}

function parseMemoryType(value: unknown): MemoryType | null {
  const maybeType = tableValueToString(value);
  if (MEMORY_TYPES.includes(maybeType as MemoryType)) {
    return maybeType as MemoryType;
  }
  return null;
}

function parseReviewRating(value: unknown): ReviewRating | null {
  const maybeRating = tableValueToString(value);
  if (REVIEW_RATINGS.includes(maybeRating as ReviewRating)) {
    return maybeRating as ReviewRating;
  }
  return null;
}

function rowToStoredMemory(row: Record<string, unknown>): StoredMemory {
  return {
    id: tableValueToString(row.id),
    agentId: tableValueToString(row.agent_id),
    sessionKey: typeof row.session_key === "string" ? row.session_key : null,
    memoryType: tableValueToString(row.memory_type) as MemoryType,
    namespace: typeof row.namespace === "string" ? (row.namespace as ProceduralNamespace) : null,
    text: tableValueToString(row.text),
    sourceRelPath: typeof row.source_rel_path === "string" ? row.source_rel_path : null,
    sourceExcerpt: typeof row.source_excerpt === "string" ? row.source_excerpt : null,
    sourceMessageIndex:
      typeof row.source_message_index === "number" && Number.isFinite(row.source_message_index)
        ? Math.floor(row.source_message_index)
        : null,
    category: typeof row.category === "string" ? row.category : null,
    importance:
      typeof row.importance === "number" && Number.isFinite(row.importance) ? row.importance : null,
    createdAt: typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0),
    updatedAt: typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at ?? 0),
  };
}

function normalizeNamespace(
  namespace: ProceduralNamespace | null | undefined,
): ProceduralNamespace | null {
  if (namespace === "user_workflow" || namespace === "execution_trace") {
    return namespace;
  }
  return null;
}

function proceduralSegment(namespace: ProceduralNamespace | null): string {
  if (namespace === "execution_trace") {
    return "procedural-execution-trace";
  }
  return "procedural-user-workflow";
}

export function buildVirtualPath(
  memory: Pick<StoredMemory, "id" | "memoryType" | "namespace">,
): string {
  if (memory.memoryType === "procedural") {
    return `mem0/${proceduralSegment(memory.namespace)}/${memory.id}.md`;
  }
  return `mem0/${memory.memoryType}/${memory.id}.md`;
}

function parseVirtualPath(relPath: string): {
  memoryType: MemoryType;
  namespace: ProceduralNamespace | null;
  id: string;
} | null {
  const trimmed = relPath.trim();
  const match = /^mem0\/([^/]+)\/([a-zA-Z0-9-]+)\.md$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const [, typeSegment, id] = match;
  if (typeSegment === "semantic") {
    return { memoryType: "semantic", namespace: null, id };
  }
  if (typeSegment === "episodic") {
    return { memoryType: "episodic", namespace: null, id };
  }
  if (typeSegment === "procedural-user-workflow") {
    return { memoryType: "procedural", namespace: "user_workflow", id };
  }
  if (typeSegment === "procedural-execution-trace") {
    return { memoryType: "procedural", namespace: "execution_trace", id };
  }
  return null;
}

export function normalizeSourceRelPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/\\/g, "/");
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

function mergeMemoryText(existingText: string, incomingText: string): string {
  const normalizedExisting = normalizeForSimilarity(existingText);
  const normalizedIncoming = normalizeForSimilarity(incomingText);
  if (!normalizedExisting) {
    return incomingText;
  }
  if (!normalizedIncoming) {
    return existingText;
  }
  if (normalizedExisting === normalizedIncoming) {
    return existingText;
  }
  if (normalizedExisting.includes(normalizedIncoming)) {
    return existingText;
  }
  if (normalizedIncoming.includes(normalizedExisting)) {
    return incomingText;
  }
  return incomingText;
}

function renderMemoryDocument(
  memory: StoredMemory,
  params?: { sourceSessionKeyOverride?: string },
): { text: string } {
  const createdIso = new Date(memory.createdAt).toISOString();
  const updatedIso = new Date(memory.updatedAt).toISOString();
  const sourceSession = params?.sourceSessionKeyOverride ?? memory.sessionKey ?? "";
  const sourceMessageIndex = memory.sourceMessageIndex ?? -1;
  const sourceExcerpt = memory.sourceExcerpt ?? "";

  const memoryLines = memory.text.split(/\r?\n/);
  const lines = [
    "# mem0 memory",
    `id: ${memory.id}`,
    `type: ${memory.memoryType}`,
    `namespace: ${memory.namespace ?? ""}`,
    `created_at: ${createdIso}`,
    `updated_at: ${updatedIso}`,
    `source_session_key: ${sourceSession}`,
    `source_message_index: ${sourceMessageIndex}`,
    `source_excerpt: ${sourceExcerpt}`,
    "---",
    ...memoryLines,
  ];
  return { text: lines.join("\n") };
}

function trimSnippet(text: string, limit = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export class Mem0Store {
  private readonly db: SqliteDatabase;

  constructor(private readonly dbPath: string) {
    ensureDirForFile(dbPath);
    const sqlite = requireNodeSqlite();
    this.db = new sqlite.DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.ensureSchema();
  }

  get path(): string {
    return this.dbPath;
  }

  close() {
    this.db.close();
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        memory_type TEXT NOT NULL,
        namespace TEXT,
        text TEXT NOT NULL,
        source_rel_path TEXT,
        source_excerpt TEXT,
        source_message_index INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(agent_id, memory_type, namespace, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        run_id TEXT,
        action TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        namespace TEXT,
        previous_text TEXT,
        next_text TEXT,
        source_excerpt TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_history_memory ON memory_history(memory_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_history_agent ON memory_history(agent_id, id DESC);

      CREATE TABLE IF NOT EXISTS memory_ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        rating TEXT NOT NULL,
        note TEXT,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        run_id TEXT,
        reviewer TEXT NOT NULL DEFAULT 'owner',
        review_source TEXT NOT NULL DEFAULT 'cli',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_ratings_memory ON memory_ratings(memory_id, id DESC);

      CREATE TABLE IF NOT EXISTS memory_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        session_key TEXT,
        run_id TEXT,
        source_excerpt TEXT,
        expected_memory TEXT,
        note TEXT,
        reviewer TEXT NOT NULL DEFAULT 'owner',
        review_source TEXT NOT NULL DEFAULT 'cli',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_gaps_agent ON memory_gaps(agent_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_recall_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        run_id TEXT NOT NULL,
        recalled_at INTEGER NOT NULL,
        UNIQUE(memory_id, run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_recall_events_agent ON memory_recall_events(agent_id, recalled_at DESC);

      CREATE TABLE IF NOT EXISTS capture_cursors (
        agent_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        last_processed_index INTEGER NOT NULL,
        last_capture_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, session_key)
      );

      CREATE TABLE IF NOT EXISTS markdown_sync_state (
        agent_id TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        imported_count INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, workspace_dir, rel_path)
      );

      CREATE INDEX IF NOT EXISTS idx_markdown_sync_state_agent_workspace
        ON markdown_sync_state(agent_id, workspace_dir, rel_path);
    `);
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN source_rel_path TEXT;`);
    } catch {
      // already exists for upgraded stores
    }
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN category TEXT;`);
    } catch {
      // already exists for upgraded stores
    }
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN importance REAL;`);
    } catch {
      // already exists for upgraded stores
    }
  }

  getCursor(agentId: string, sessionKey: string): number {
    const row = this.db
      .prepare(
        `SELECT last_processed_index FROM capture_cursors WHERE agent_id = ? AND session_key = ? LIMIT 1`,
      )
      .get(agentId, sessionKey) as Record<string, unknown> | undefined;
    if (!row) {
      return -1;
    }
    const value = row.last_processed_index;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    return -1;
  }

  setCursor(agentId: string, sessionKey: string, lastProcessedIndex: number, now = Date.now()) {
    this.db
      .prepare(
        `
        INSERT INTO capture_cursors (agent_id, session_key, last_processed_index, last_capture_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, session_key)
        DO UPDATE SET
          last_processed_index = excluded.last_processed_index,
          last_capture_at = excluded.last_capture_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(agentId, sessionKey, lastProcessedIndex, now, now);
  }

  listMarkdownSyncState(params: { agentId: string; workspaceDir: string }): MarkdownSyncStateRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          agent_id,
          workspace_dir,
          rel_path,
          content_hash,
          mtime_ms,
          imported_count,
          synced_at
        FROM markdown_sync_state
        WHERE agent_id = ? AND workspace_dir = ?
      `,
      )
      .all(params.agentId, params.workspaceDir) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      agentId: tableValueToString(row.agent_id),
      workspaceDir: tableValueToString(row.workspace_dir),
      relPath: tableValueToString(row.rel_path),
      contentHash: tableValueToString(row.content_hash),
      mtimeMs: Number(row.mtime_ms ?? 0),
      importedCount: Number(row.imported_count ?? 0),
      syncedAt: Number(row.synced_at ?? 0),
    }));
  }

  listImportedSourcePaths(agentId: string): ImportedSourcePathRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          source_rel_path,
          COUNT(*) AS memory_count,
          MAX(updated_at) AS latest_updated_at
        FROM memories
        WHERE agent_id = ? AND deleted_at IS NULL AND source_rel_path IS NOT NULL
        GROUP BY source_rel_path
      `,
      )
      .all(agentId) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        sourceRelPath: tableValueToString(row.source_rel_path),
        memoryCount: tableValueToNumber(row.memory_count),
        latestUpdatedAt: tableValueToNumber(row.latest_updated_at),
      }))
      .filter((row) => row.sourceRelPath.trim().length > 0);
  }

  upsertMarkdownSyncState(params: {
    agentId: string;
    workspaceDir: string;
    relPath: string;
    contentHash: string;
    mtimeMs: number;
    importedCount: number;
    syncedAt?: number;
  }) {
    const syncedAt = params.syncedAt ?? Date.now();
    this.db
      .prepare(
        `
        INSERT INTO markdown_sync_state (
          agent_id,
          workspace_dir,
          rel_path,
          content_hash,
          mtime_ms,
          imported_count,
          synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, workspace_dir, rel_path)
        DO UPDATE SET
          content_hash = excluded.content_hash,
          mtime_ms = excluded.mtime_ms,
          imported_count = excluded.imported_count,
          synced_at = excluded.synced_at
      `,
      )
      .run(
        params.agentId,
        params.workspaceDir,
        params.relPath,
        params.contentHash,
        params.mtimeMs,
        Math.max(0, Math.floor(params.importedCount)),
        syncedAt,
      );
  }

  private listAgentMemories(agentId: string): StoredMemory[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          id,
          agent_id,
          session_key,
          memory_type,
          namespace,
          text,
          source_rel_path,
          source_excerpt,
          source_message_index,
          created_at,
          updated_at
        FROM memories
        WHERE agent_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
      `,
      )
      .all(agentId) as Array<Record<string, unknown>>;
    return rows.map(rowToStoredMemory);
  }

  search(params: {
    agentId: string;
    query: string;
    limit: number;
    minScore: number;
    types?: MemoryType[];
    namespace?: ProceduralNamespace | null;
  }): MemorySearchHit[] {
    const all = this.listAgentMemories(params.agentId);
    const typed = all.filter((memory) => {
      if (params.types && params.types.length > 0 && !params.types.includes(memory.memoryType)) {
        return false;
      }
      if (params.namespace !== undefined && memory.namespace !== params.namespace) {
        return false;
      }
      return true;
    });

    const scored: MemorySearchHit[] = [];
    for (const memory of typed) {
      const score = recallScore(params.query, memory.text);
      if (score < params.minScore) {
        continue;
      }
      const memoryLines = Math.max(1, memory.text.split(/\r?\n/).length);
      const sourcePath = normalizeSourceRelPath(memory.sourceRelPath);
      scored.push({
        id: memory.id,
        path: sourcePath || buildVirtualPath(memory),
        startLine: MEMORY_TEXT_START_LINE,
        endLine: MEMORY_TEXT_START_LINE + memoryLines - 1,
        score,
        snippet: trimSnippet(memory.text, 300),
        source: "memory",
        memoryType: memory.memoryType,
        namespace: memory.namespace,
        category: memory.category,
        importance: memory.importance,
      });
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      return a.id.localeCompare(b.id);
    });

    return scored.slice(0, Math.max(1, params.limit));
  }

  getMemoryById(agentId: string, memoryId: string): StoredMemory | null {
    const row = this.db
      .prepare(
        `
        SELECT
          id,
          agent_id,
          session_key,
          memory_type,
          namespace,
          text,
          source_rel_path,
          source_excerpt,
          source_message_index,
          created_at,
          updated_at
        FROM memories
        WHERE id = ? AND agent_id = ? AND deleted_at IS NULL
        LIMIT 1
      `,
      )
      .get(memoryId, agentId) as Record<string, unknown> | undefined;
    return row ? rowToStoredMemory(row) : null;
  }

  readVirtualPath(params: {
    agentId: string;
    relPath: string;
    from?: number;
    lines?: number;
    sourceSessionKeyOverride?: string;
  }): { path: string; text: string } {
    const parsed = parseVirtualPath(params.relPath);
    if (!parsed) {
      return { path: params.relPath, text: "" };
    }
    const memory = this.getMemoryById(params.agentId, parsed.id);
    if (!memory) {
      return { path: params.relPath, text: "" };
    }
    if (memory.memoryType !== parsed.memoryType) {
      return { path: params.relPath, text: "" };
    }
    if (parsed.memoryType === "procedural" && memory.namespace !== parsed.namespace) {
      return { path: params.relPath, text: "" };
    }

    const rendered = renderMemoryDocument(memory, {
      sourceSessionKeyOverride: params.sourceSessionKeyOverride,
    });
    const allLines = rendered.text.split(/\r?\n/);
    const fromLine = Math.max(1, Math.floor(params.from ?? 1));
    const count =
      params.lines !== undefined ? Math.max(0, Math.floor(params.lines)) : allLines.length;
    const startIndex = Math.min(allLines.length, fromLine - 1);
    const endIndex = Math.min(allLines.length, startIndex + count);
    const selected = count <= 0 ? [] : allLines.slice(startIndex, endIndex);

    return {
      path: buildVirtualPath(memory),
      text: selected.join("\n"),
    };
  }

  recordRecallEvents(params: {
    agentId: string;
    sessionKey?: string;
    runId: string;
    memoryIds: string[];
    now?: number;
  }) {
    if (params.memoryIds.length === 0) {
      return;
    }
    const now = params.now ?? Date.now();
    const statement = this.db.prepare(
      `
      INSERT OR IGNORE INTO memory_recall_events (
        memory_id,
        agent_id,
        session_key,
        run_id,
        recalled_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
    );
    for (const memoryId of params.memoryIds) {
      statement.run(memoryId, params.agentId, params.sessionKey ?? null, params.runId, now);
    }
  }

  private insertHistory(params: {
    memoryId: string;
    agentId: string;
    sessionKey?: string;
    runId?: string;
    action: DedupAction;
    memoryType: MemoryType;
    namespace?: ProceduralNamespace;
    previousText?: string;
    nextText?: string;
    sourceExcerpt?: string;
    createdAt: number;
  }) {
    this.db
      .prepare(
        `
        INSERT INTO memory_history (
          memory_id,
          agent_id,
          session_key,
          run_id,
          action,
          memory_type,
          namespace,
          previous_text,
          next_text,
          source_excerpt,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        params.memoryId,
        params.agentId,
        params.sessionKey ?? null,
        params.runId ?? null,
        params.action,
        params.memoryType,
        normalizeNamespace(params.namespace) ?? null,
        params.previousText ?? null,
        params.nextText ?? null,
        params.sourceExcerpt ?? null,
        params.createdAt,
      );
  }

  private pickBestCandidate(params: {
    agentId: string;
    memoryType: MemoryType;
    namespace?: ProceduralNamespace;
    text: string;
    maxCandidates: number;
  }): { memory: StoredMemory; score: number } | null {
    const candidates = this.listAgentMemories(params.agentId).filter((memory) => {
      if (memory.memoryType !== params.memoryType) {
        return false;
      }
      if (normalizeNamespace(memory.namespace) !== normalizeNamespace(params.namespace)) {
        return false;
      }
      return true;
    });

    let best: { memory: StoredMemory; score: number } | null = null;
    for (const memory of candidates.slice(0, Math.max(1, params.maxCandidates) * 5)) {
      const score = similarityScore(memory.text, params.text);
      if (!best || score > best.score) {
        best = { memory, score };
      }
    }
    return best;
  }

  listSimilarMemories(params: {
    agentId: string;
    memoryType: MemoryType;
    namespace?: ProceduralNamespace;
    text: string;
    maxCandidates: number;
  }): ExistingMemoryCandidate[] {
    const normalizedNamespace = normalizeNamespace(params.namespace);
    const matched = this.listAgentMemories(params.agentId)
      .filter((memory) => {
        if (memory.memoryType !== params.memoryType) {
          return false;
        }
        return normalizeNamespace(memory.namespace) === normalizedNamespace;
      })
      .map((memory) => ({
        id: memory.id,
        text: memory.text,
        memoryType: memory.memoryType,
        namespace: memory.namespace,
        score: similarityScore(memory.text, params.text),
      }))
      .toSorted((a, b) => b.score - a.score);

    return matched.slice(0, Math.max(1, params.maxCandidates));
  }

  private upsertMemoriesInternal(params: {
    agentId: string;
    sessionKey?: string;
    runId?: string;
    dedup: Mem0DedupConfig;
    candidates: MemoryCandidateWrite[];
    now?: number;
  }): MemoryWriteResult[] {
    const now = params.now ?? Date.now();
    const results: MemoryWriteResult[] = [];

    for (const candidate of params.candidates) {
      const memoryType = candidate.memoryType;
      const namespace = normalizeNamespace(candidate.namespace);
      const text = candidate.text.trim();
      if (!text) {
        continue;
      }

      if (!params.dedup.enabled) {
        const memoryId = randomUUID();
        this.db
          .prepare(
            `
              INSERT INTO memories (
                id,
                agent_id,
                session_key,
                memory_type,
                namespace,
                text,
                source_rel_path,
                source_excerpt,
                source_message_index,
                category,
                importance,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            memoryId,
            params.agentId,
            params.sessionKey ?? null,
            memoryType,
            namespace,
            text,
            normalizeSourceRelPath(candidate.sourceRelPath),
            candidate.sourceExcerpt ?? null,
            candidate.sourceMessageIndex ?? null,
            candidate.category ?? null,
            candidate.importance ?? null,
            now,
            now,
          );
        this.insertHistory({
          memoryId,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          action: "ADD",
          memoryType,
          namespace: namespace ?? undefined,
          previousText: "",
          nextText: text,
          sourceExcerpt: candidate.sourceExcerpt,
          createdAt: now,
        });
        results.push({
          memoryId,
          action: "ADD",
          memoryType,
          namespace,
        });
        continue;
      }

      const best = this.pickBestCandidate({
        agentId: params.agentId,
        memoryType,
        namespace: namespace ?? undefined,
        text,
        maxCandidates: params.dedup.maxCandidates,
      });

      if (!best || best.score < params.dedup.similarityThreshold) {
        const memoryId = randomUUID();
        this.db
          .prepare(
            `
              INSERT INTO memories (
                id,
                agent_id,
                session_key,
                memory_type,
                namespace,
                text,
                source_rel_path,
                source_excerpt,
                source_message_index,
                category,
                importance,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            memoryId,
            params.agentId,
            params.sessionKey ?? null,
            memoryType,
            namespace,
            text,
            normalizeSourceRelPath(candidate.sourceRelPath),
            candidate.sourceExcerpt ?? null,
            candidate.sourceMessageIndex ?? null,
            candidate.category ?? null,
            candidate.importance ?? null,
            now,
            now,
          );
        this.insertHistory({
          memoryId,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          action: "ADD",
          memoryType,
          namespace: namespace ?? undefined,
          previousText: "",
          nextText: text,
          sourceExcerpt: candidate.sourceExcerpt,
          createdAt: now,
        });
        results.push({
          memoryId,
          action: "ADD",
          memoryType,
          namespace,
        });
        continue;
      }

      const merged = mergeMemoryText(best.memory.text, text);
      if (normalizeForSimilarity(best.memory.text) === normalizeForSimilarity(merged)) {
        this.insertHistory({
          memoryId: best.memory.id,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          action: "NONE",
          memoryType,
          namespace: namespace ?? undefined,
          previousText: best.memory.text,
          nextText: best.memory.text,
          sourceExcerpt: candidate.sourceExcerpt,
          createdAt: now,
        });
        results.push({
          memoryId: best.memory.id,
          action: "NONE",
          memoryType,
          namespace,
          score: best.score,
        });
        continue;
      }

      this.db
        .prepare(
          `
            UPDATE memories
            SET
              text = ?,
              source_rel_path = ?,
              source_excerpt = ?,
              source_message_index = ?,
              category = COALESCE(?, category),
              importance = COALESCE(?, importance),
              session_key = ?,
              updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          merged,
          normalizeSourceRelPath(candidate.sourceRelPath) ?? best.memory.sourceRelPath,
          candidate.sourceExcerpt ?? null,
          candidate.sourceMessageIndex ?? null,
          candidate.category ?? null,
          candidate.importance ?? null,
          params.sessionKey ?? null,
          now,
          best.memory.id,
        );
      this.insertHistory({
        memoryId: best.memory.id,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        action: "UPDATE",
        memoryType,
        namespace: namespace ?? undefined,
        previousText: best.memory.text,
        nextText: merged,
        sourceExcerpt: candidate.sourceExcerpt,
        createdAt: now,
      });
      results.push({
        memoryId: best.memory.id,
        action: "UPDATE",
        memoryType,
        namespace,
        score: best.score,
      });
    }

    return results;
  }

  upsertMemories(params: {
    agentId: string;
    sessionKey?: string;
    runId?: string;
    dedup: Mem0DedupConfig;
    candidates: MemoryCandidateWrite[];
    now?: number;
  }): MemoryWriteResult[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const writes = this.upsertMemoriesInternal(params);
      this.db.exec("COMMIT");
      return writes;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private applyDecisionInternal(params: {
    agentId: string;
    sessionKey: string;
    runId?: string;
    decision: MemoryApplyDecision;
    now: number;
  }): MemoryWriteResult | null {
    const candidate = params.decision.candidate;
    const memoryType = candidate.memoryType;
    const namespace = normalizeNamespace(candidate.namespace);
    const sourceRelPath = normalizeSourceRelPath(candidate.sourceRelPath);
    const sourceExcerpt = candidate.sourceExcerpt ?? null;
    const sourceMessageIndex = candidate.sourceMessageIndex ?? null;

    const addMemory = (textInput: string): MemoryWriteResult | null => {
      const text = textInput.trim();
      if (!text) {
        return null;
      }
      const memoryId = randomUUID();
      this.db
        .prepare(
          `
            INSERT INTO memories (
              id,
              agent_id,
              session_key,
              memory_type,
              namespace,
              text,
              source_rel_path,
              source_excerpt,
              source_message_index,
              category,
              importance,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          memoryId,
          params.agentId,
          params.sessionKey,
          memoryType,
          namespace,
          text,
          sourceRelPath,
          sourceExcerpt,
          sourceMessageIndex,
          candidate.category ?? null,
          candidate.importance ?? null,
          params.now,
          params.now,
        );
      this.insertHistory({
        memoryId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        action: "ADD",
        memoryType,
        namespace: namespace ?? undefined,
        previousText: "",
        nextText: text,
        sourceExcerpt: sourceExcerpt ?? undefined,
        createdAt: params.now,
      });
      return {
        memoryId,
        action: "ADD",
        memoryType,
        namespace,
      };
    };

    const requestedAction = params.decision.action;
    if (requestedAction === "ADD") {
      return addMemory(params.decision.nextText ?? candidate.text);
    }

    const targetId = params.decision.targetMemoryId?.trim();
    const target = targetId ? this.getMemoryById(params.agentId, targetId) : null;
    if (!target) {
      if (requestedAction === "UPDATE") {
        return addMemory(params.decision.nextText ?? candidate.text);
      }
      return null;
    }
    if (target.memoryType !== memoryType || normalizeNamespace(target.namespace) !== namespace) {
      if (requestedAction === "UPDATE") {
        return addMemory(params.decision.nextText ?? candidate.text);
      }
      return null;
    }

    if (requestedAction === "DELETE") {
      this.db
        .prepare(
          `
            UPDATE memories
            SET deleted_at = ?, updated_at = ?
            WHERE id = ? AND agent_id = ?
          `,
        )
        .run(params.now, params.now, target.id, params.agentId);
      this.insertHistory({
        memoryId: target.id,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        action: "DELETE",
        memoryType,
        namespace: namespace ?? undefined,
        previousText: target.text,
        nextText: "",
        sourceExcerpt: sourceExcerpt ?? undefined,
        createdAt: params.now,
      });
      return {
        memoryId: target.id,
        action: "DELETE",
        memoryType,
        namespace,
      };
    }

    if (requestedAction === "NONE") {
      this.insertHistory({
        memoryId: target.id,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        action: "NONE",
        memoryType,
        namespace: namespace ?? undefined,
        previousText: target.text,
        nextText: target.text,
        sourceExcerpt: sourceExcerpt ?? undefined,
        createdAt: params.now,
      });
      return {
        memoryId: target.id,
        action: "NONE",
        memoryType,
        namespace,
      };
    }

    const nextTextRaw = params.decision.nextText ?? candidate.text;
    const nextText = nextTextRaw.trim();
    if (!nextText) {
      return null;
    }
    if (normalizeForSimilarity(nextText) === normalizeForSimilarity(target.text)) {
      this.insertHistory({
        memoryId: target.id,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        action: "NONE",
        memoryType,
        namespace: namespace ?? undefined,
        previousText: target.text,
        nextText: target.text,
        sourceExcerpt: sourceExcerpt ?? undefined,
        createdAt: params.now,
      });
      return {
        memoryId: target.id,
        action: "NONE",
        memoryType,
        namespace,
      };
    }

    this.db
      .prepare(
        `
          UPDATE memories
          SET
            text = ?,
            source_rel_path = ?,
            source_excerpt = ?,
            source_message_index = ?,
            category = COALESCE(?, category),
            importance = COALESCE(?, importance),
            session_key = ?,
            updated_at = ?
          WHERE id = ? AND agent_id = ?
        `,
      )
      .run(
        nextText,
        sourceRelPath ?? target.sourceRelPath,
        sourceExcerpt,
        sourceMessageIndex,
        candidate.category ?? null,
        candidate.importance ?? null,
        params.sessionKey,
        params.now,
        target.id,
        params.agentId,
      );
    this.insertHistory({
      memoryId: target.id,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      runId: params.runId,
      action: "UPDATE",
      memoryType,
      namespace: namespace ?? undefined,
      previousText: target.text,
      nextText,
      sourceExcerpt: sourceExcerpt ?? undefined,
      createdAt: params.now,
    });
    return {
      memoryId: target.id,
      action: "UPDATE",
      memoryType,
      namespace,
      score: similarityScore(target.text, nextText),
    };
  }

  applyDecisionsAndAdvanceCursor(params: {
    agentId: string;
    sessionKey: string;
    runId?: string;
    lastProcessedIndex: number;
    decisions: MemoryApplyDecision[];
  }): MemoryWriteResult[] {
    const now = Date.now();
    const writes: MemoryWriteResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const decision of params.decisions) {
        const applied = this.applyDecisionInternal({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          decision,
          now,
        });
        if (applied) {
          writes.push(applied);
        }
      }
      this.setCursor(params.agentId, params.sessionKey, params.lastProcessedIndex, now);
      this.db.exec("COMMIT");
      return writes;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  applyDecisions(params: {
    agentId: string;
    sessionKey: string;
    runId?: string;
    decisions: MemoryApplyDecision[];
    now?: number;
  }): MemoryWriteResult[] {
    const now = params.now ?? Date.now();
    const writes: MemoryWriteResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const decision of params.decisions) {
        const applied = this.applyDecisionInternal({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          decision,
          now,
        });
        if (applied) {
          writes.push(applied);
        }
      }
      this.db.exec("COMMIT");
      return writes;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listForReview(params: {
    agentId: string;
    type?: "semantic" | "procedural" | "episodic";
    sinceMs?: number;
    unreviewed?: boolean;
    limit?: number;
  }): MemoryReviewRow[] {
    const rows = this.listAgentMemories(params.agentId)
      .filter((memory) => {
        if (params.type && memory.memoryType !== params.type) {
          return false;
        }
        if (params.sinceMs && memory.createdAt < params.sinceMs) {
          return false;
        }
        return true;
      })
      .slice(0, Math.max(1, params.limit ?? 50));

    const result: MemoryReviewRow[] = [];
    for (const memory of rows) {
      const latestHistory = this.db
        .prepare(`SELECT action FROM memory_history WHERE memory_id = ? ORDER BY id DESC LIMIT 1`)
        .get(memory.id) as Record<string, unknown> | undefined;
      const latestRating = this.db
        .prepare(
          `SELECT created_at FROM memory_ratings WHERE memory_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(memory.id) as Record<string, unknown> | undefined;

      const reviewedAt =
        typeof latestRating?.created_at === "number"
          ? latestRating.created_at
          : latestRating?.created_at
            ? Number(latestRating.created_at)
            : null;
      if (params.unreviewed && reviewedAt !== null) {
        continue;
      }

      const actionRaw = tableValueToString(latestHistory?.action ?? "ADD");
      const action: DedupAction =
        actionRaw === "ADD" ||
        actionRaw === "UPDATE" ||
        actionRaw === "DELETE" ||
        actionRaw === "NONE"
          ? actionRaw
          : "ADD";

      result.push({
        id: memory.id,
        memoryType: memory.memoryType,
        namespace: memory.namespace,
        text: memory.text,
        sourceExcerpt: memory.sourceExcerpt ?? "",
        sessionKey: memory.sessionKey,
        sourceMessageIndex: memory.sourceMessageIndex,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
        dedupAction: action,
        lastReviewedAt: reviewedAt,
      });
    }

    result.sort((a, b) => b.updatedAt - a.updatedAt);
    return result;
  }

  addRating(params: {
    agentId: string;
    memoryId: string;
    rating: ReviewRating;
    note?: string;
    sessionKey?: string;
    runId?: string;
    now?: number;
  }) {
    const now = params.now ?? Date.now();
    this.db
      .prepare(
        `
        INSERT INTO memory_ratings (
          memory_id,
          rating,
          note,
          agent_id,
          session_key,
          run_id,
          reviewer,
          review_source,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'owner', 'cli', ?)
      `,
      )
      .run(
        params.memoryId,
        params.rating,
        params.note ?? null,
        params.agentId,
        params.sessionKey ?? null,
        params.runId ?? null,
        now,
      );
  }

  addGap(params: {
    agentId: string;
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
    sourceExcerpt?: string;
    expectedMemory?: string;
    note?: string;
    now?: number;
  }) {
    const now = params.now ?? Date.now();
    this.db
      .prepare(
        `
        INSERT INTO memory_gaps (
          agent_id,
          session_id,
          session_key,
          run_id,
          source_excerpt,
          expected_memory,
          note,
          reviewer,
          review_source,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', 'cli', ?)
      `,
      )
      .run(
        params.agentId,
        params.sessionId ?? null,
        params.sessionKey ?? null,
        params.runId ?? null,
        params.sourceExcerpt ?? null,
        params.expectedMemory ?? null,
        params.note ?? null,
        now,
      );
  }

  getRecallEventCount(agentId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM memory_recall_events WHERE agent_id = ?`)
      .get(agentId) as Record<string, unknown>;
    return tableValueToNumber(row.count);
  }

  getRecallEventCountForWindow(params: { agentId: string; sinceMs?: number }): number {
    const args: Array<string | number> = [params.agentId];
    let query = `SELECT COUNT(*) AS count FROM memory_recall_events WHERE agent_id = ?`;
    if (typeof params.sinceMs === "number" && Number.isFinite(params.sinceMs)) {
      query += ` AND recalled_at >= ?`;
      args.push(Math.floor(params.sinceMs));
    }
    const row = this.db.prepare(query).get(...args) as Record<string, unknown>;
    return tableValueToNumber(row.count);
  }

  getMemoryCountsByType(params: { agentId: string; sinceMs?: number }): QualityMemoryTypeCount[] {
    const args: Array<string | number> = [params.agentId];
    let query = `
      SELECT memory_type, COUNT(*) AS count
      FROM memories
      WHERE agent_id = ? AND deleted_at IS NULL
    `;
    if (typeof params.sinceMs === "number" && Number.isFinite(params.sinceMs)) {
      query += ` AND created_at >= ?`;
      args.push(Math.floor(params.sinceMs));
    }
    query += ` GROUP BY memory_type`;
    const rows = this.db.prepare(query).all(...args) as Array<Record<string, unknown>>;

    const counts = new Map<MemoryType, number>();
    for (const memoryType of MEMORY_TYPES) {
      counts.set(memoryType, 0);
    }
    for (const row of rows) {
      const memoryType = parseMemoryType(row.memory_type);
      if (!memoryType) {
        continue;
      }
      counts.set(memoryType, tableValueToNumber(row.count));
    }

    return MEMORY_TYPES.map((memoryType) => ({
      memoryType,
      count: counts.get(memoryType) ?? 0,
    }));
  }

  getMemoryCountsByTypeAndNamespace(params: {
    agentId: string;
  }): QualityMemoryTypeNamespaceCount[] {
    const rows = this.db
      .prepare(
        `
      SELECT
        memory_type,
        namespace,
        COUNT(*) AS count
      FROM memories
      WHERE agent_id = ? AND deleted_at IS NULL
      GROUP BY memory_type, namespace
    `,
      )
      .all(params.agentId) as Array<Record<string, unknown>>;
    const result: QualityMemoryTypeNamespaceCount[] = [];
    for (const row of rows) {
      const memoryType = parseMemoryType(row.memory_type);
      if (!memoryType) {
        continue;
      }
      const namespace = normalizeNamespace(row.namespace as ProceduralNamespace | null | undefined);
      result.push({
        memoryType,
        namespace,
        count: tableValueToNumber(row.count),
      });
    }
    return result;
  }

  listCaptureCountsBySession(params: {
    agentId: string;
    sinceMs?: number;
    limit?: number;
  }): QualityCaptureSessionCount[] {
    const args: Array<string | number> = [params.agentId];
    let query = `
      SELECT session_key, COUNT(*) AS capture_count
      FROM memory_history
      WHERE agent_id = ? AND action IN ('ADD', 'UPDATE')
    `;
    if (typeof params.sinceMs === "number" && Number.isFinite(params.sinceMs)) {
      query += ` AND created_at >= ?`;
      args.push(Math.floor(params.sinceMs));
    }
    query += ` GROUP BY session_key ORDER BY capture_count DESC, session_key ASC`;
    if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
      query += ` LIMIT ?`;
      args.push(Math.max(1, Math.floor(params.limit)));
    }
    const rows = this.db.prepare(query).all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionKey: typeof row.session_key === "string" ? row.session_key : null,
      captureCount: tableValueToNumber(row.capture_count),
    }));
  }

  getDedupStats(params: { agentId: string; sinceMs?: number }): QualityDedupStats {
    const args: Array<string | number> = [params.agentId];
    let query = `
      SELECT
        COUNT(*) AS total_decisions,
        SUM(CASE WHEN action IN ('UPDATE', 'NONE', 'DELETE') THEN 1 ELSE 0 END) AS dedup_hits
      FROM memory_history
      WHERE agent_id = ? AND action IN ('ADD', 'UPDATE', 'NONE', 'DELETE')
    `;
    if (typeof params.sinceMs === "number" && Number.isFinite(params.sinceMs)) {
      query += ` AND created_at >= ?`;
      args.push(Math.floor(params.sinceMs));
    }
    const row = this.db.prepare(query).get(...args) as Record<string, unknown>;
    const totalDecisions = tableValueToNumber(row.total_decisions);
    const dedupHits = tableValueToNumber(row.dedup_hits);
    return {
      totalDecisions,
      dedupHits,
      dedupHitRate: totalDecisions > 0 ? dedupHits / totalDecisions : 0,
    };
  }

  listLatestRatings(params: {
    agentId: string;
    sinceMs?: number;
    limit?: number;
  }): QualityRatingRow[] {
    const args: Array<string | number> = [params.agentId];
    let whereClause = `r.agent_id = ?`;
    if (typeof params.sinceMs === "number" && Number.isFinite(params.sinceMs)) {
      whereClause += ` AND r.created_at >= ?`;
      args.push(Math.floor(params.sinceMs));
    }
    let query = `
      SELECT
        r.id AS rating_id,
        r.memory_id,
        r.rating,
        r.note,
        r.session_key,
        r.run_id,
        r.created_at,
        m.memory_type,
        m.namespace,
        m.text,
        m.source_excerpt
      FROM memory_ratings r
      JOIN memories m
        ON m.id = r.memory_id
       AND m.agent_id = r.agent_id
      WHERE ${whereClause}
        AND r.id = (
          SELECT r2.id
          FROM memory_ratings r2
          WHERE r2.agent_id = r.agent_id AND r2.memory_id = r.memory_id
          ORDER BY r2.created_at DESC, r2.id DESC
          LIMIT 1
        )
      ORDER BY r.created_at DESC, r.id DESC
    `;
    if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
      query += ` LIMIT ?`;
      args.push(Math.max(1, Math.floor(params.limit)));
    }

    const rows = this.db.prepare(query).all(...args) as Array<Record<string, unknown>>;
    const result: QualityRatingRow[] = [];
    for (const row of rows) {
      const memoryType = parseMemoryType(row.memory_type);
      const rating = parseReviewRating(row.rating);
      if (!memoryType || !rating) {
        continue;
      }
      result.push({
        ratingId: tableValueToNumber(row.rating_id),
        memoryId: tableValueToString(row.memory_id),
        memoryType,
        namespace: normalizeNamespace(
          typeof row.namespace === "string" ? (row.namespace as ProceduralNamespace) : null,
        ),
        rating,
        note: typeof row.note === "string" ? row.note : null,
        sessionKey: typeof row.session_key === "string" ? row.session_key : null,
        runId: typeof row.run_id === "string" ? row.run_id : null,
        createdAt: tableValueToNumber(row.created_at),
        memoryText: tableValueToString(row.text),
        sourceExcerpt: typeof row.source_excerpt === "string" ? row.source_excerpt : null,
      });
    }
    return result;
  }

  listGapsForQuality(params: {
    agentId: string;
    sinceMs?: number;
    limit?: number;
  }): QualityGapRow[] {
    const args: Array<string | number> = [params.agentId];
    let query = `
      SELECT
        id,
        session_key,
        run_id,
        source_excerpt,
        expected_memory,
        note,
        created_at
      FROM memory_gaps
      WHERE agent_id = ?
    `;
    if (typeof params.sinceMs === "number" && Number.isFinite(params.sinceMs)) {
      query += ` AND created_at >= ?`;
      args.push(Math.floor(params.sinceMs));
    }
    query += ` ORDER BY created_at DESC, id DESC`;
    if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
      query += ` LIMIT ?`;
      args.push(Math.max(1, Math.floor(params.limit)));
    }

    const rows = this.db.prepare(query).all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      gapId: tableValueToNumber(row.id),
      sessionKey: typeof row.session_key === "string" ? row.session_key : null,
      runId: typeof row.run_id === "string" ? row.run_id : null,
      sourceExcerpt: typeof row.source_excerpt === "string" ? row.source_excerpt : null,
      expectedMemory: typeof row.expected_memory === "string" ? row.expected_memory : null,
      note: typeof row.note === "string" ? row.note : null,
      createdAt: tableValueToNumber(row.created_at),
    }));
  }

  listNeverRecalledMemories(params: {
    agentId: string;
    olderThanMs: number;
    sinceMs?: number;
    now?: number;
    limit?: number;
  }): QualityNeverRecalledRow[] {
    const now = params.now ?? Date.now();
    const args: Array<string | number> = [params.agentId, Math.floor(params.olderThanMs)];
    let query = `
      SELECT
        m.id,
        m.memory_type,
        m.namespace,
        m.session_key,
        m.text,
        m.source_excerpt,
        m.created_at
      FROM memories m
      LEFT JOIN memory_recall_events r
        ON r.memory_id = m.id
       AND r.agent_id = m.agent_id
      WHERE m.agent_id = ?
        AND m.deleted_at IS NULL
        AND m.created_at <= ?
        AND r.id IS NULL
    `;
    if (typeof params.sinceMs === "number" && Number.isFinite(params.sinceMs)) {
      query += ` AND m.created_at >= ?`;
      args.push(Math.floor(params.sinceMs));
    }
    query += ` ORDER BY m.created_at ASC, m.id ASC`;
    if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
      query += ` LIMIT ?`;
      args.push(Math.max(1, Math.floor(params.limit)));
    }

    const rows = this.db.prepare(query).all(...args) as Array<Record<string, unknown>>;
    const result: QualityNeverRecalledRow[] = [];
    for (const row of rows) {
      const memoryType = parseMemoryType(row.memory_type);
      if (!memoryType) {
        continue;
      }
      const createdAt = tableValueToNumber(row.created_at);
      const ageDays = Math.max(0, (now - createdAt) / 86_400_000);
      result.push({
        memoryId: tableValueToString(row.id),
        memoryType,
        namespace: normalizeNamespace(
          typeof row.namespace === "string" ? (row.namespace as ProceduralNamespace) : null,
        ),
        sessionKey: typeof row.session_key === "string" ? row.session_key : null,
        text: tableValueToString(row.text),
        sourceExcerpt: typeof row.source_excerpt === "string" ? row.source_excerpt : null,
        createdAt,
        ageDays,
      });
    }
    return result;
  }

  summarizeSupersededMemories(params: {
    agentId: string;
    withinTurns: number;
    sinceMs?: number;
    limit?: number;
  }): QualitySupersededSummary {
    const rows = this.db
      .prepare(
        `
        SELECT
          id,
          memory_id,
          action,
          memory_type,
          namespace,
          run_id,
          next_text,
          source_excerpt,
          created_at
        FROM memory_history
        WHERE agent_id = ? AND action IN ('ADD', 'UPDATE', 'DELETE')
        ORDER BY memory_id ASC, id ASC
      `,
      )
      .all(params.agentId) as Array<Record<string, unknown>>;

    type SupersedeEvent = {
      memoryId: string;
      memoryType: MemoryType;
      namespace: ProceduralNamespace | null;
      text: string;
      sourceExcerpt: string | null;
      addCreatedAt: number;
      supersededAt: number;
      turnsToSupersede: number;
      elapsedMs: number;
    };

    const allSuperseded: SupersedeEvent[] = [];
    let cursor = 0;
    while (cursor < rows.length) {
      const memoryId = tableValueToString(rows[cursor]?.memory_id);
      const bucket: Array<Record<string, unknown>> = [];
      while (cursor < rows.length && tableValueToString(rows[cursor]?.memory_id) === memoryId) {
        bucket.push(rows[cursor]);
        cursor += 1;
      }
      const addIndex = bucket.findIndex((row) => tableValueToString(row.action) === "ADD");
      if (addIndex < 0) {
        continue;
      }
      const addRow = bucket[addIndex];
      const memoryType = parseMemoryType(addRow.memory_type);
      if (!memoryType) {
        continue;
      }
      const addCreatedAt = tableValueToNumber(addRow.created_at);
      if (
        typeof params.sinceMs === "number" &&
        Number.isFinite(params.sinceMs) &&
        addCreatedAt < params.sinceMs
      ) {
        continue;
      }
      const seenRuns = new Set<string>();
      for (let index = addIndex + 1; index < bucket.length; index += 1) {
        const row = bucket[index];
        const runId = typeof row.run_id === "string" ? row.run_id.trim() : "";
        if (runId) {
          seenRuns.add(runId);
        }
        const action = tableValueToString(row.action);
        if (action !== "UPDATE" && action !== "DELETE") {
          continue;
        }
        const turnsToSupersede = seenRuns.size > 0 ? seenRuns.size : 1;
        const supersededAt = tableValueToNumber(row.created_at);
        const elapsedMs = Math.max(0, supersededAt - addCreatedAt);
        allSuperseded.push({
          memoryId,
          memoryType,
          namespace: normalizeNamespace(
            typeof addRow.namespace === "string" ? (addRow.namespace as ProceduralNamespace) : null,
          ),
          text: tableValueToString(addRow.next_text),
          sourceExcerpt: typeof addRow.source_excerpt === "string" ? addRow.source_excerpt : null,
          addCreatedAt,
          supersededAt,
          turnsToSupersede,
          elapsedMs,
        });
        break;
      }
    }

    const quickAll = allSuperseded.filter(
      (row) => row.turnsToSupersede <= Math.max(1, Math.floor(params.withinTurns)),
    );
    const quickSorted = quickAll.toSorted((a, b) => {
      if (a.turnsToSupersede !== b.turnsToSupersede) {
        return a.turnsToSupersede - b.turnsToSupersede;
      }
      if (a.elapsedMs !== b.elapsedMs) {
        return a.elapsedMs - b.elapsedMs;
      }
      return a.memoryId.localeCompare(b.memoryId);
    });
    const quick =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? quickSorted.slice(0, Math.max(1, Math.floor(params.limit)))
        : quickSorted;

    const totalElapsedMs = allSuperseded.reduce((sum, row) => sum + row.elapsedMs, 0);
    return {
      quick,
      totalQuickSuperseded: quickAll.length,
      totalSuperseded: allSuperseded.length,
      averageTimeToSupersedeMs:
        allSuperseded.length > 0 ? totalElapsedMs / allSuperseded.length : null,
    };
  }

  getRatingCount(agentId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM memory_ratings WHERE agent_id = ?`)
      .get(agentId) as Record<string, unknown>;
    return tableValueToNumber(row.count);
  }

  getGapCount(agentId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM memory_gaps WHERE agent_id = ?`)
      .get(agentId) as Record<string, unknown>;
    return tableValueToNumber(row.count);
  }
}
