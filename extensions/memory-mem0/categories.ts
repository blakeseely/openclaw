/**
 * Memory category definitions with importance scores and TTL policies.
 * Ported from upstream mem0 skills-based architecture.
 */

export type CategoryConfig = {
  importance: number;
  /** TTL string like "7d", "90d", or null for permanent. */
  ttl: string | null;
  /** If true, memory should not be auto-updated or deleted by consolidation. */
  immutable?: boolean;
};

export type MemoryCategory =
  | "identity"
  | "configuration"
  | "rule"
  | "preference"
  | "decision"
  | "technical"
  | "relationship"
  | "project"
  | "operational";

export const MEMORY_CATEGORIES: Record<MemoryCategory, CategoryConfig> = {
  identity: { importance: 0.95, ttl: null, immutable: true },
  configuration: { importance: 0.95, ttl: null },
  rule: { importance: 0.9, ttl: null },
  preference: { importance: 0.85, ttl: null },
  decision: { importance: 0.8, ttl: null },
  technical: { importance: 0.8, ttl: null },
  relationship: { importance: 0.75, ttl: null },
  project: { importance: 0.75, ttl: "90d" },
  operational: { importance: 0.6, ttl: "7d" },
};

/** Categories ordered from highest to lowest priority for recall ranking. */
export const DEFAULT_CATEGORY_ORDER: MemoryCategory[] = [
  "identity",
  "configuration",
  "rule",
  "preference",
  "decision",
  "technical",
  "relationship",
  "project",
  "operational",
];

const ALL_CATEGORIES = new Set<string>(Object.keys(MEMORY_CATEGORIES));
const DEFAULT_IMPORTANCE = 0.5;

export function isValidCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && ALL_CATEGORIES.has(value);
}

export function getCategoryImportance(category: string | null | undefined): number {
  if (!category || !isValidCategory(category)) {
    return DEFAULT_IMPORTANCE;
  }
  return MEMORY_CATEGORIES[category].importance;
}

/**
 * Heuristic fallback: map memoryType to a reasonable default category
 * when the LLM fails to assign one.
 */
export function fallbackCategoryFromType(memoryType: string, namespace?: string): MemoryCategory {
  if (memoryType === "procedural" && namespace === "user_workflow") {
    return "preference";
  }
  if (memoryType === "procedural") {
    return "operational";
  }
  if (memoryType === "episodic") {
    return "operational";
  }
  // semantic → preference is the safest generic default
  return "preference";
}
