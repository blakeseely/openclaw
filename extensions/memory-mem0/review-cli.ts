import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { Mem0Config, MemoryType, ReviewRating } from "./config.js";
import type {
  Mem0Store,
  MemoryReviewRow,
  QualityGapRow,
  QualityNeverRecalledRow,
  QualityRatingRow,
  QualitySupersededRow,
} from "./storage.js";

type ReviewTypeFilter = "semantic" | "episodic" | "procedural";

type ReviewCommandOptions = {
  agent?: string;
  type?: ReviewTypeFilter;
  since?: string;
  unreviewed?: boolean;
  limit?: number;
  memoryId?: string;
  rating?: string;
  expectedMemory?: string;
  sourceExcerpt?: string;
  note?: string;
  sessionKey?: string;
};

type MarkdownSyncCommandOptions = {
  agent?: string;
  force?: boolean;
};

type MarkdownReconcileCommandOptions = {
  agent?: string;
  showAll?: boolean;
  limit?: number;
  failOnUnresolved?: boolean;
};

type QualityReportCommandOptions = {
  agent?: string;
  since?: string;
  includeSensitive?: boolean;
  sampleLimit?: number;
  jsonlOut?: string;
};

type MarkdownSyncSummary = {
  workspaceDir: string;
  scannedFiles: number;
  importedFiles: number;
  unchangedFiles: number;
  failedFiles: number;
  extractedCandidates: number;
  appliedWrites: number;
  usedHeuristicFallback: boolean;
};

type MarkdownReconcileIssue = {
  kind: "changed" | "moved" | "deleted" | "missing" | "stale_mapping";
  relPath: string;
  memoryCount: number;
  detail: string;
  movedToRelPath?: string;
  staleReason?: "state_without_memories" | "memory_without_state";
};

type MarkdownReconcileSummary = {
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

const REVIEWABLE_TYPES: ReviewTypeFilter[] = ["semantic", "episodic", "procedural"];
const REVIEWABLE_RATINGS: ReviewRating[] = [
  "keep",
  "wrong",
  "redundant",
  "too_specific",
  "too_vague",
];

const PHASE_2A_DEFAULTS: Mem0Config["feedback"] = {
  enabled: true,
  review: {
    mode: "owner_cli_only",
  },
  derivedSignals: {
    enabled: true,
    recallUsedEvidence: "explicit_only",
    neverRecalledAfterDays: 14,
    supersededWithinTurns: 3,
  },
  reports: {
    redactByDefault: true,
    maxExcerptChars: 240,
  },
};

const RATING_ORDER: ReviewRating[] = ["wrong", "redundant", "too_specific", "too_vague", "keep"];

const MEMORY_TYPE_ORDER: MemoryType[] = ["semantic", "episodic", "procedural"];

function ensureMemoryCommand(program: Command): Command {
  const existing = program.commands.find((command) => command.name() === "memory");
  if (existing) {
    return existing;
  }
  return program.command("memory").description("Memory commands");
}

function parseSinceOption(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const match = /^(\d+)([mhd])$/i.exec(trimmed);
  if (!match) {
    throw new Error("--since must use the format <number><m|h|d>, for example 7d or 12h");
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Date.now() - amount * multiplier;
}

function normalizeType(value?: string): ReviewTypeFilter | undefined {
  if (!value) {
    return undefined;
  }
  if (REVIEWABLE_TYPES.includes(value as ReviewTypeFilter)) {
    return value as ReviewTypeFilter;
  }
  throw new Error(`Unsupported --type value: ${value}`);
}

function normalizeRating(value: string): ReviewRating | "missing" {
  if (value === "missing") {
    return "missing";
  }
  if (REVIEWABLE_RATINGS.includes(value as ReviewRating)) {
    return value as ReviewRating;
  }
  throw new Error(`Unsupported rating: ${value}`);
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function hashSessionKey(sessionKey: string): string {
  const hash = createHash("sha256").update(sessionKey, "utf8").digest("hex").slice(0, 12);
  return `session:${hash}`;
}

function redactSensitiveText(text: string): string {
  let next = text;
  next = next.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted:email]");
  next = next.replace(
    /\b(?:\+?\d{1,2}[ -]?)?(?:\(?\d{3}\)?[ -]?)\d{3}[ -]?\d{4}\b/g,
    "[redacted:phone]",
  );
  next = next.replace(/\b(?:sk|rk|pk)_[a-zA-Z0-9]{12,}\b/g, "[redacted:token]");
  next = next.replace(
    /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[redacted]",
  );
  return next;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatSensitiveText(
  input: string | null | undefined,
  params: {
    redact: boolean;
    maxChars: number;
  },
): string {
  const normalized = normalizeWhitespace(input ?? "");
  if (!normalized) {
    return "";
  }
  const redacted = params.redact ? redactSensitiveText(normalized) : normalized;
  if (redacted.length <= params.maxChars) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(0, params.maxChars - 3)).trimEnd()}...`;
}

function formatSessionKey(
  sessionKey: string | null | undefined,
  params: {
    redact: boolean;
  },
): string {
  if (!sessionKey) {
    return "";
  }
  return params.redact ? hashSessionKey(sessionKey) : sessionKey;
}

function formatPercent(count: number, total: number): string {
  if (total <= 0) {
    return "0.0%";
  }
  return `${((count / total) * 100).toFixed(1)}%`;
}

function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return "n/a";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(1)}m`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

function deriveGapTheme(expectedMemory: string): string {
  const normalized = expectedMemory
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "unspecified";
  }
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "user",
    "should",
    "have",
    "been",
    "memory",
    "must",
  ]);
  const words = normalized
    .split(" ")
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .slice(0, 4);
  if (words.length === 0) {
    return "unspecified";
  }
  return words.join(" ");
}

function summarizeGapThemes(
  rows: QualityGapRow[],
  maxThemes: number,
): Array<{ theme: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const theme = deriveGapTheme(row.expectedMemory ?? "");
    counts.set(theme, (counts.get(theme) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return a.theme.localeCompare(b.theme);
    })
    .slice(0, Math.max(1, maxThemes));
}

function printMemory(row: MemoryReviewRow, index: number) {
  const created = new Date(row.createdAt).toISOString();
  const updated = new Date(row.updatedAt).toISOString();
  const session = row.sessionKey ?? "";
  const namespace = row.namespace ?? "";
  console.log(`\n[${index + 1}] ${row.id}`);
  console.log(`  type: ${row.memoryType}`);
  console.log(`  namespace: ${namespace}`);
  console.log(`  dedup_action: ${row.dedupAction}`);
  console.log(`  created_at: ${created}`);
  console.log(`  updated_at: ${updated}`);
  console.log(`  session_key: ${session}`);
  console.log(`  source_message_index: ${row.sourceMessageIndex ?? ""}`);
  console.log(`  memory: ${row.text}`);
  if (row.sourceExcerpt) {
    console.log(`  source_excerpt: ${row.sourceExcerpt}`);
  }
}

async function runInteractiveReview(params: {
  agentId: string;
  rows: MemoryReviewRow[];
  store: Mem0Store;
}) {
  const io = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    for (let index = 0; index < params.rows.length; index += 1) {
      const row = params.rows[index];
      printMemory(row, index);
      const answer = (
        await io.question(
          "  rating [k=keep,w=wrong,r=redundant,s=too_specific,v=too_vague,m=missing,enter=skip,q=quit]: ",
        )
      )
        .trim()
        .toLowerCase();

      if (!answer) {
        continue;
      }
      if (answer === "q") {
        break;
      }
      if (answer === "m") {
        const sourceExcerpt = (await io.question("  source excerpt (optional): ")).trim();
        const expectedMemory = (await io.question("  expected memory (required): ")).trim();
        if (!expectedMemory) {
          console.log("  skipped: expected memory is required for missing");
          continue;
        }
        const note = (await io.question("  note (optional): ")).trim();
        params.store.addGap({
          agentId: params.agentId,
          sessionKey: row.sessionKey ?? undefined,
          sourceExcerpt: sourceExcerpt || row.sourceExcerpt || undefined,
          expectedMemory,
          note: note || undefined,
        });
        console.log("  saved gap entry");
        continue;
      }

      const keyMap: Record<string, ReviewRating> = {
        k: "keep",
        w: "wrong",
        r: "redundant",
        s: "too_specific",
        v: "too_vague",
      };
      const rating = keyMap[answer];
      if (!rating) {
        console.log("  skipped: unknown rating key");
        continue;
      }
      const note = (await io.question("  note (optional): ")).trim();
      params.store.addRating({
        agentId: params.agentId,
        memoryId: row.id,
        rating,
        note: note || undefined,
        sessionKey: row.sessionKey ?? undefined,
      });
      console.log(`  saved rating: ${rating}`);
    }
  } finally {
    io.close();
  }
}

function sortWorstRated(rows: QualityRatingRow[]): QualityRatingRow[] {
  const rank = new Map<ReviewRating, number>();
  for (const [index, rating] of RATING_ORDER.entries()) {
    rank.set(rating, index);
  }
  return [...rows].sort((a, b) => {
    const aRank = rank.get(a.rating) ?? RATING_ORDER.length;
    const bRank = rank.get(b.rating) ?? RATING_ORDER.length;
    if (aRank !== bRank) {
      return aRank - bRank;
    }
    return b.createdAt - a.createdAt;
  });
}

function asIsoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function printQualityReport(params: {
  agentId: string;
  sinceMs?: number;
  redact: boolean;
  sampleLimit: number;
  maxExcerptChars: number;
  neverRecalledAfterDays: number;
  supersededWithinTurns: number;
  memoryTypeCounts: ReturnType<Mem0Store["getMemoryCountsByType"]>;
  captureBySession: ReturnType<Mem0Store["listCaptureCountsBySession"]>;
  dedupStats: ReturnType<Mem0Store["getDedupStats"]>;
  ratings: QualityRatingRow[];
  recallHitCount: number;
  gaps: QualityGapRow[];
  neverRecalled: QualityNeverRecalledRow[];
  supersededSummary: ReturnType<Mem0Store["summarizeSupersededMemories"]>;
}) {
  const now = Date.now();
  const redactParams = { redact: params.redact, maxChars: params.maxExcerptChars };
  const byRating = new Map<ReviewRating, number>();
  for (const rating of REVIEWABLE_RATINGS) {
    byRating.set(rating, 0);
  }
  for (const row of params.ratings) {
    byRating.set(row.rating, (byRating.get(row.rating) ?? 0) + 1);
  }

  const ratingByType = new Map<MemoryType, Map<ReviewRating, number>>();
  for (const memoryType of MEMORY_TYPE_ORDER) {
    const counts = new Map<ReviewRating, number>();
    for (const rating of REVIEWABLE_RATINGS) {
      counts.set(rating, 0);
    }
    ratingByType.set(memoryType, counts);
  }
  for (const row of params.ratings) {
    const byType = ratingByType.get(row.memoryType);
    if (!byType) {
      continue;
    }
    byType.set(row.rating, (byType.get(row.rating) ?? 0) + 1);
  }

  const recallUsedCount = 0;
  const recallIgnoredCount = params.recallHitCount;
  const recallHitIgnoredRatio = `${params.recallHitCount}:${recallIgnoredCount}`;
  const worstRated = sortWorstRated(params.ratings.filter((row) => row.rating !== "keep")).slice(
    0,
    Math.max(1, params.sampleLimit),
  );
  const gapThemes = summarizeGapThemes(params.gaps, 5);

  console.log("memory quality report");
  console.log(`agent=${params.agentId}`);
  console.log(`generated_at=${asIsoTime(now)}`);
  console.log(`window_since=${params.sinceMs ? asIsoTime(params.sinceMs) : "all_time"}`);
  console.log(`redaction=${params.redact ? "enabled" : "disabled"}`);
  console.log(`max_excerpt_chars=${params.maxExcerptChars}`);

  console.log("\n[overall]");
  for (const row of params.memoryTypeCounts) {
    console.log(`memories.${row.memoryType}=${row.count}`);
  }
  if (params.captureBySession.length === 0) {
    console.log("capture_by_session=none");
  } else {
    const totalCaptures = params.captureBySession.reduce(
      (sum, row) => sum + Math.max(0, row.captureCount),
      0,
    );
    console.log(`capture.total=${totalCaptures}`);
    for (const row of params.captureBySession) {
      const key = formatSessionKey(row.sessionKey, { redact: params.redact }) || "(none)";
      console.log(
        `capture_by_session.${key}=${row.captureCount} (${formatPercent(row.captureCount, totalCaptures)})`,
      );
    }
  }
  console.log(`dedup.total_decisions=${params.dedupStats.totalDecisions}`);
  console.log(`dedup.hits=${params.dedupStats.dedupHits}`);
  console.log(
    `dedup.hit_rate=${formatPercent(params.dedupStats.dedupHits, params.dedupStats.totalDecisions)}`,
  );

  console.log("\n[ratings]");
  console.log(`ratings.total=${params.ratings.length}`);
  for (const rating of REVIEWABLE_RATINGS) {
    const count = byRating.get(rating) ?? 0;
    console.log(`ratings.${rating}=${count} (${formatPercent(count, params.ratings.length)})`);
  }
  for (const memoryType of MEMORY_TYPE_ORDER) {
    const typeCounts = ratingByType.get(memoryType)!;
    const totalForType = [...typeCounts.values()].reduce((sum, count) => sum + count, 0);
    if (totalForType === 0) {
      continue;
    }
    const tooSpecific = typeCounts.get("too_specific") ?? 0;
    const wrong = typeCounts.get("wrong") ?? 0;
    console.log(
      `ratings.pattern.${memoryType}=total:${totalForType},too_specific:${formatPercent(tooSpecific, totalForType)},wrong:${formatPercent(wrong, totalForType)}`,
    );
  }

  console.log("\n[derived_signals]");
  console.log(`recall_hit=${params.recallHitCount}`);
  console.log(`recall_used=${recallUsedCount} (explicit_only evidence unavailable in phase 2A)`);
  console.log(`recall_ignored=${recallIgnoredCount}`);
  console.log(`recall_hit_vs_ignored_ratio=${recallHitIgnoredRatio}`);
  console.log(`superseded_quickly=${params.supersededSummary.totalQuickSuperseded}`);
  console.log(`superseded_within_turns_threshold=${params.supersededWithinTurns}`);
  console.log(
    `average_time_to_supersede=${formatDurationMs(params.supersededSummary.averageTimeToSupersedeMs)}`,
  );
  console.log(
    `never_recalled.age_days>=${params.neverRecalledAfterDays}=${params.neverRecalled.length}`,
  );

  console.log("\n[gaps]");
  console.log(`gaps.total=${params.gaps.length}`);
  if (gapThemes.length === 0) {
    console.log("gaps.themes=none");
  } else {
    for (const theme of gapThemes) {
      console.log(`gaps.theme.${theme.theme}=${theme.count}`);
    }
  }

  if (worstRated.length > 0) {
    console.log("\n[sample_worst_rated]");
    for (const [index, row] of worstRated.entries()) {
      console.log(`${index + 1}. memory_id=${row.memoryId}`);
      console.log(`   rating=${row.rating}`);
      console.log(`   type=${row.memoryType}`);
      console.log(
        `   session=${formatSessionKey(row.sessionKey, { redact: params.redact }) || "(none)"}`,
      );
      console.log(`   text=${formatSensitiveText(row.memoryText, redactParams)}`);
      console.log(`   source_excerpt=${formatSensitiveText(row.sourceExcerpt, redactParams)}`);
    }
  }

  if (params.neverRecalled.length > 0) {
    console.log("\n[sample_never_recalled]");
    for (const [index, row] of params.neverRecalled
      .slice(0, Math.max(1, params.sampleLimit))
      .entries()) {
      console.log(`${index + 1}. memory_id=${row.memoryId}`);
      console.log(`   type=${row.memoryType}`);
      console.log(`   age_days=${row.ageDays.toFixed(1)}`);
      console.log(
        `   session=${formatSessionKey(row.sessionKey, { redact: params.redact }) || "(none)"}`,
      );
      console.log(`   text=${formatSensitiveText(row.text, redactParams)}`);
    }
  }

  if (params.supersededSummary.quick.length > 0) {
    console.log("\n[sample_superseded_quickly]");
    for (const [index, row] of params.supersededSummary.quick
      .slice(0, Math.max(1, params.sampleLimit))
      .entries()) {
      console.log(`${index + 1}. memory_id=${row.memoryId}`);
      console.log(`   type=${row.memoryType}`);
      console.log(`   turns_to_supersede=${row.turnsToSupersede}`);
      console.log(`   elapsed=${formatDurationMs(row.elapsedMs)}`);
      console.log(`   text=${formatSensitiveText(row.text, redactParams)}`);
    }
  }
}

async function writeQualityJsonl(params: {
  outputPath: string;
  redact: boolean;
  maxExcerptChars: number;
  agentId: string;
  sinceMs?: number;
  neverRecalledAfterDays: number;
  supersededWithinTurns: number;
  memoryTypeCounts: ReturnType<Mem0Store["getMemoryCountsByType"]>;
  captureBySession: ReturnType<Mem0Store["listCaptureCountsBySession"]>;
  dedupStats: ReturnType<Mem0Store["getDedupStats"]>;
  ratings: QualityRatingRow[];
  gaps: QualityGapRow[];
  neverRecalled: QualityNeverRecalledRow[];
  supersededSummary: ReturnType<Mem0Store["summarizeSupersededMemories"]>;
}) {
  const redactParams = { redact: params.redact, maxChars: params.maxExcerptChars };
  const records: Record<string, unknown>[] = [];
  records.push({
    recordType: "summary",
    generatedAt: Date.now(),
    agentId: params.agentId,
    sinceMs: params.sinceMs ?? null,
    neverRecalledAfterDays: params.neverRecalledAfterDays,
    supersededWithinTurns: params.supersededWithinTurns,
    memoryTypeCounts: params.memoryTypeCounts,
    captureBySession: params.captureBySession.map((row) => ({
      sessionKey: formatSessionKey(row.sessionKey, { redact: params.redact }) || null,
      captureCount: row.captureCount,
    })),
    dedupStats: params.dedupStats,
    derivedSignals: {
      neverRecalledCount: params.neverRecalled.length,
      supersededQuicklyCount: params.supersededSummary.totalQuickSuperseded,
      supersededTotalCount: params.supersededSummary.totalSuperseded,
    },
  });
  for (const row of params.ratings) {
    records.push({
      recordType: "rating",
      ratingId: row.ratingId,
      memoryId: row.memoryId,
      rating: row.rating,
      memoryType: row.memoryType,
      namespace: row.namespace,
      createdAt: row.createdAt,
      sessionKey: formatSessionKey(row.sessionKey, { redact: params.redact }) || null,
      note: formatSensitiveText(row.note, redactParams),
      memoryText: formatSensitiveText(row.memoryText, redactParams),
      sourceExcerpt: formatSensitiveText(row.sourceExcerpt, redactParams),
    });
  }
  for (const gap of params.gaps) {
    records.push({
      recordType: "gap",
      gapId: gap.gapId,
      createdAt: gap.createdAt,
      sessionKey: formatSessionKey(gap.sessionKey, { redact: params.redact }) || null,
      expectedMemory: formatSensitiveText(gap.expectedMemory, redactParams),
      sourceExcerpt: formatSensitiveText(gap.sourceExcerpt, redactParams),
      note: formatSensitiveText(gap.note, redactParams),
    });
  }
  for (const row of params.neverRecalled) {
    records.push({
      recordType: "derived_never_recalled",
      memoryId: row.memoryId,
      memoryType: row.memoryType,
      namespace: row.namespace,
      ageDays: Number(row.ageDays.toFixed(3)),
      createdAt: row.createdAt,
      sessionKey: formatSessionKey(row.sessionKey, { redact: params.redact }) || null,
      text: formatSensitiveText(row.text, redactParams),
      sourceExcerpt: formatSensitiveText(row.sourceExcerpt, redactParams),
    });
  }
  for (const row of params.supersededSummary.quick) {
    records.push({
      recordType: "derived_superseded_quickly",
      memoryId: row.memoryId,
      memoryType: row.memoryType,
      namespace: row.namespace,
      addCreatedAt: row.addCreatedAt,
      supersededAt: row.supersededAt,
      turnsToSupersede: row.turnsToSupersede,
      elapsedMs: row.elapsedMs,
      text: formatSensitiveText(row.text, redactParams),
      sourceExcerpt: formatSensitiveText(row.sourceExcerpt, redactParams),
    });
  }
  const resolvedPath = path.resolve(process.cwd(), params.outputPath);
  const payload = records.map((entry) => JSON.stringify(entry)).join("\n");
  await fs.writeFile(resolvedPath, `${payload}\n`, "utf-8");
  return resolvedPath;
}

export function registerMemoryReviewCli(params: {
  program: Command;
  resolveStore: (agentId: string) => Mem0Store;
  feedbackConfig?: Mem0Config["feedback"];
  syncMarkdown?: (params: {
    agentId: string;
    force?: boolean;
  }) => Promise<MarkdownSyncSummary | null>;
  reconcileMarkdown?: (params: { agentId: string }) => Promise<MarkdownReconcileSummary>;
}) {
  const feedbackConfig = params.feedbackConfig ?? PHASE_2A_DEFAULTS;
  const memory = ensureMemoryCommand(params.program);
  const hasReviewCommand = memory.commands.some((command) => command.name() === "review");

  if (!hasReviewCommand) {
    memory
      .command("review")
      .description("Review extracted memories and write human feedback labels")
      .option("--agent <id>", "Agent id", "default")
      .option("--type <type>", "Filter by memory type (semantic|episodic|procedural)")
      .option("--since <duration>", "Filter by time window, e.g. 7d or 12h")
      .option("--unreviewed", "Only include memories that have no rating yet")
      .option("--limit <n>", "Max memories to inspect", "25")
      .option("--memory-id <id>", "Apply a single rating to one memory id")
      .option(
        "--rating <rating>",
        "Rating to apply: keep|wrong|redundant|too_specific|too_vague|missing",
      )
      .option("--expected-memory <text>", "Expected memory text for --rating missing")
      .option("--source-excerpt <text>", "Source excerpt for --rating missing")
      .option("--note <text>", "Optional note for rating or gap")
      .option("--session-key <key>", "Optional session key to attach to manual gap entries")
      .action(async (options: ReviewCommandOptions) => {
        const agentId = options.agent?.trim() || "default";
        const store = params.resolveStore(agentId);

        if (options.rating) {
          const normalizedRating = normalizeRating(options.rating.trim());
          if (normalizedRating === "missing") {
            if (!options.expectedMemory?.trim()) {
              throw new Error("--expected-memory is required when --rating missing");
            }
            store.addGap({
              agentId,
              sessionKey: options.sessionKey?.trim() || undefined,
              sourceExcerpt: options.sourceExcerpt?.trim() || undefined,
              expectedMemory: options.expectedMemory.trim(),
              note: options.note?.trim() || undefined,
            });
            console.log("saved gap entry");
            return;
          }

          if (!options.memoryId?.trim()) {
            throw new Error("--memory-id is required when --rating is provided");
          }
          store.addRating({
            agentId,
            memoryId: options.memoryId.trim(),
            rating: normalizedRating,
            note: options.note?.trim() || undefined,
            sessionKey: options.sessionKey?.trim() || undefined,
          });
          console.log(`saved rating ${normalizedRating} for ${options.memoryId.trim()}`);
          return;
        }

        const sinceMs = parseSinceOption(options.since);
        const limit = Number.isFinite(Number(options.limit))
          ? Math.max(1, Math.floor(Number(options.limit)))
          : 25;
        const type = normalizeType(options.type);

        const rows = store.listForReview({
          agentId,
          type,
          sinceMs,
          unreviewed: options.unreviewed === true,
          limit,
        });

        if (rows.length === 0) {
          console.log("No memories matched the review filters.");
          return;
        }

        await runInteractiveReview({
          agentId,
          rows,
          store,
        });

        console.log(
          `Review complete. ratings=${store.getRatingCount(agentId)} gaps=${store.getGapCount(agentId)}`,
        );
      });
  }

  const hasQualityReportCommand = memory.commands.some(
    (command) => command.name() === "quality-report",
  );
  if (!hasQualityReportCommand) {
    memory
      .command("quality-report")
      .description(
        "Generate a phase-2A memory quality report from ratings, gaps, and recall events",
      )
      .option("--agent <id>", "Agent id", "default")
      .option("--since <duration>", "Filter by time window, e.g. 30d or 12h")
      .option("--include-sensitive", "Disable redaction for owner-only deep dives")
      .option("--sample-limit <n>", "Max sample entries per section", "5")
      .option("--jsonl-out <path>", "Optional JSONL export path for downstream analysis")
      .action(async (options: QualityReportCommandOptions) => {
        const agentId = options.agent?.trim() || "default";
        const sinceMs = parseSinceOption(options.since);
        const sampleLimit = normalizeCount(
          options.sampleLimit !== undefined ? Number(options.sampleLimit) : undefined,
          5,
        );
        const includeSensitive = options.includeSensitive === true;
        const redactByDefault = feedbackConfig.reports.redactByDefault;
        const redact = redactByDefault && !includeSensitive;
        const maxExcerptChars = Math.max(1, Math.floor(feedbackConfig.reports.maxExcerptChars));
        const neverRecalledAfterDays = Math.max(
          1,
          Math.floor(feedbackConfig.derivedSignals.neverRecalledAfterDays),
        );
        const supersededWithinTurns = Math.max(
          1,
          Math.floor(feedbackConfig.derivedSignals.supersededWithinTurns),
        );

        const store = params.resolveStore(agentId);
        const memoryTypeCounts = store.getMemoryCountsByType({ agentId, sinceMs });
        const captureBySession = store.listCaptureCountsBySession({
          agentId,
          sinceMs,
        });
        const dedupStats = store.getDedupStats({ agentId, sinceMs });
        const ratings = store.listLatestRatings({ agentId, sinceMs });
        const recallHitCount = store.getRecallEventCountForWindow({ agentId, sinceMs });
        const gaps = store.listGapsForQuality({
          agentId,
          sinceMs,
        });

        const derivedSignalsEnabled = feedbackConfig.derivedSignals.enabled;
        const now = Date.now();
        const neverRecalled = derivedSignalsEnabled
          ? store.listNeverRecalledMemories({
              agentId,
              olderThanMs: now - neverRecalledAfterDays * 86_400_000,
              sinceMs,
              now,
            })
          : [];
        const supersededSummary = derivedSignalsEnabled
          ? store.summarizeSupersededMemories({
              agentId,
              withinTurns: supersededWithinTurns,
              sinceMs,
            })
          : {
              quick: [],
              totalQuickSuperseded: 0,
              totalSuperseded: 0,
              averageTimeToSupersedeMs: null,
            };

        printQualityReport({
          agentId,
          sinceMs,
          redact,
          sampleLimit,
          maxExcerptChars,
          neverRecalledAfterDays,
          supersededWithinTurns,
          memoryTypeCounts,
          captureBySession,
          dedupStats,
          ratings,
          recallHitCount,
          gaps,
          neverRecalled,
          supersededSummary,
        });

        if (options.jsonlOut?.trim()) {
          const outputPath = await writeQualityJsonl({
            outputPath: options.jsonlOut.trim(),
            redact,
            maxExcerptChars,
            agentId,
            sinceMs,
            neverRecalledAfterDays,
            supersededWithinTurns,
            memoryTypeCounts,
            captureBySession,
            dedupStats,
            ratings,
            gaps,
            neverRecalled,
            supersededSummary,
          });
          console.log(`\njsonl_export=${outputPath}`);
        }
      });
  }

  const hasSyncMarkdownCommand = memory.commands.some(
    (command) => command.name() === "sync-markdown",
  );
  if (params.syncMarkdown && !hasSyncMarkdownCommand) {
    memory
      .command("sync-markdown")
      .description("Backfill markdown memory files into the mem0 store")
      .option("--agent <id>", "Agent id", "default")
      .option("--force", "Re-import files even when unchanged hashes are already recorded")
      .action(async (options: MarkdownSyncCommandOptions) => {
        const agentId = options.agent?.trim() || "default";
        const summary = await params.syncMarkdown?.({
          agentId,
          force: options.force === true,
        });
        if (!summary) {
          console.log("Markdown sync skipped (disabled or already completed).");
          return;
        }

        console.log(`agent=${agentId}`);
        console.log(`workspace=${summary.workspaceDir}`);
        console.log(`scanned_files=${summary.scannedFiles}`);
        console.log(`imported_files=${summary.importedFiles}`);
        console.log(`unchanged_files=${summary.unchangedFiles}`);
        console.log(`failed_files=${summary.failedFiles}`);
        console.log(`extracted_candidates=${summary.extractedCandidates}`);
        console.log(`applied_writes=${summary.appliedWrites}`);
        console.log(
          `extraction_fallback=${summary.usedHeuristicFallback ? "heuristic" : "llm_only"}`,
        );
      });
  }

  const hasReconcileMarkdownCommand = memory.commands.some(
    (command) => command.name() === "reconcile-markdown",
  );
  if (params.reconcileMarkdown && !hasReconcileMarkdownCommand) {
    memory
      .command("reconcile-markdown")
      .description("Verify markdown import mappings and report drift against workspace files")
      .option("--agent <id>", "Agent id", "default")
      .option("--limit <n>", "Max issues to print", "25")
      .option("--show-all", "Print all detected issues")
      .option("--fail-on-unresolved", "Exit with an error when unresolved mappings are detected")
      .action(async (options: MarkdownReconcileCommandOptions) => {
        const agentId = options.agent?.trim() || "default";
        const summary = await params.reconcileMarkdown?.({
          agentId,
        });
        if (!summary) {
          return;
        }

        console.log(`agent=${agentId}`);
        console.log(`workspace=${summary.workspaceDir}`);
        console.log(`scanned_files=${summary.scannedFiles}`);
        console.log(`sync_state_rows=${summary.syncStateRows}`);
        console.log(`imported_source_paths=${summary.importedSourcePaths}`);
        console.log(`unresolved_mappings=${summary.unresolvedMappings}`);
        console.log(`drift.changed=${summary.changedFiles}`);
        console.log(`drift.moved=${summary.movedFiles}`);
        console.log(`drift.deleted=${summary.deletedFiles}`);
        console.log(`drift.missing=${summary.missingFiles}`);
        console.log(`drift.stale_mappings=${summary.staleMappings}`);

        if (summary.issues.length === 0) {
          console.log("status=ok");
          return;
        }

        const issueLimit = normalizeCount(
          options.limit !== undefined ? Number(options.limit) : undefined,
          25,
        );
        const issueRows = options.showAll ? summary.issues : summary.issues.slice(0, issueLimit);

        console.log("\n[issues]");
        for (const [index, issue] of issueRows.entries()) {
          console.log(`${index + 1}. kind=${issue.kind}`);
          console.log(`   path=${issue.relPath}`);
          console.log(`   memories=${issue.memoryCount}`);
          if (issue.movedToRelPath) {
            console.log(`   moved_to=${issue.movedToRelPath}`);
          }
          if (issue.staleReason) {
            console.log(`   stale_reason=${issue.staleReason}`);
          }
          console.log(`   detail=${issue.detail}`);
        }

        if (!options.showAll && summary.issues.length > issueRows.length) {
          console.log(`issues_truncated=${summary.issues.length - issueRows.length}`);
          console.log(`tip=rerun with --show-all to print every issue`);
        }

        if (options.failOnUnresolved && summary.unresolvedMappings > 0) {
          throw new Error(`unresolved mappings detected: ${summary.unresolvedMappings}`);
        }
      });
  }
}
