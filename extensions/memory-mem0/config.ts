import { homedir } from "node:os";
import { join } from "node:path";

export const MEMORY_TYPES = ["semantic", "episodic", "procedural"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const PROCEDURAL_NAMESPACES = ["user_workflow", "execution_trace"] as const;
export type ProceduralNamespace = (typeof PROCEDURAL_NAMESPACES)[number];

export const REVIEW_RATINGS = ["keep", "wrong", "redundant", "too_specific", "too_vague"] as const;
export type ReviewRating = (typeof REVIEW_RATINGS)[number];

export const CHAT_TYPES = ["direct", "group", "channel"] as const;
export type ScopeChatType = (typeof CHAT_TYPES)[number];

export const DEDUP_ACTIONS = ["ADD", "UPDATE", "DELETE", "NONE"] as const;
export type DedupAction = (typeof DEDUP_ACTIONS)[number];

export type Mem0Config = {
  autoExtract: {
    enabled: boolean;
    triggers: Array<"user" | "assistant" | "both">;
    memoryTypes: MemoryType[];
    proceduralNamespaces: ProceduralNamespace[];
    minMessageLength: number;
    rateLimitSeconds: number;
    delta: {
      strategy: "since_last_processed";
      maxMessagesPerRun: number;
    };
  };
  recall: {
    enabled: boolean;
    maxInjectedMemories: number;
    maxInjectedChars: number;
    procedural: {
      enabled: boolean;
      maxInjectedPatterns: number;
      injectAs: "workflow_preferences_section";
    };
  };
  dedup: {
    enabled: boolean;
    similarityThreshold: number;
    maxCandidates: number;
  };
  store: {
    path: string;
  };
  sync: {
    markdownToMem0: boolean;
    mem0ToMarkdown: boolean;
  };
  feedback: {
    enabled: boolean;
    review: {
      mode: "owner_cli_only";
    };
    derivedSignals: {
      enabled: boolean;
      recallUsedEvidence: "explicit_only";
      neverRecalledAfterDays: number;
      supersededWithinTurns: number;
    };
    reports: {
      redactByDefault: boolean;
      maxExcerptChars: number;
    };
  };
  scope: {
    default: "allow" | "deny";
    rules: Array<{
      action: "allow" | "deny";
      match: {
        chatType?: ScopeChatType;
      };
    }>;
  };
  llm: {
    provider: string;
    model: string;
  };
};

export const DEFAULT_STORE_PATH = join(homedir(), ".openclaw", "memory", "{agentId}-mem0.sqlite");

const DEFAULT_CONFIG: Mem0Config = {
  autoExtract: {
    enabled: true,
    triggers: ["user"],
    memoryTypes: ["semantic", "episodic", "procedural"],
    proceduralNamespaces: ["user_workflow"],
    minMessageLength: 20,
    rateLimitSeconds: 5,
    delta: {
      strategy: "since_last_processed",
      maxMessagesPerRun: 20,
    },
  },
  recall: {
    enabled: true,
    maxInjectedMemories: 5,
    maxInjectedChars: 2000,
    procedural: {
      enabled: true,
      maxInjectedPatterns: 10,
      injectAs: "workflow_preferences_section",
    },
  },
  dedup: {
    enabled: true,
    similarityThreshold: 0.7,
    maxCandidates: 5,
  },
  store: {
    path: DEFAULT_STORE_PATH,
  },
  sync: {
    markdownToMem0: true,
    mem0ToMarkdown: false,
  },
  feedback: {
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
  },
  scope: {
    default: "deny",
    rules: [{ action: "allow", match: { chatType: "direct" } }],
  },
  llm: {
    provider: "auto",
    model: "fast",
  },
};

function cloneDefaultConfig(): Mem0Config {
  return {
    autoExtract: {
      enabled: DEFAULT_CONFIG.autoExtract.enabled,
      triggers: [...DEFAULT_CONFIG.autoExtract.triggers],
      memoryTypes: [...DEFAULT_CONFIG.autoExtract.memoryTypes],
      proceduralNamespaces: [...DEFAULT_CONFIG.autoExtract.proceduralNamespaces],
      minMessageLength: DEFAULT_CONFIG.autoExtract.minMessageLength,
      rateLimitSeconds: DEFAULT_CONFIG.autoExtract.rateLimitSeconds,
      delta: {
        strategy: DEFAULT_CONFIG.autoExtract.delta.strategy,
        maxMessagesPerRun: DEFAULT_CONFIG.autoExtract.delta.maxMessagesPerRun,
      },
    },
    recall: {
      enabled: DEFAULT_CONFIG.recall.enabled,
      maxInjectedMemories: DEFAULT_CONFIG.recall.maxInjectedMemories,
      maxInjectedChars: DEFAULT_CONFIG.recall.maxInjectedChars,
      procedural: {
        enabled: DEFAULT_CONFIG.recall.procedural.enabled,
        maxInjectedPatterns: DEFAULT_CONFIG.recall.procedural.maxInjectedPatterns,
        injectAs: DEFAULT_CONFIG.recall.procedural.injectAs,
      },
    },
    dedup: {
      enabled: DEFAULT_CONFIG.dedup.enabled,
      similarityThreshold: DEFAULT_CONFIG.dedup.similarityThreshold,
      maxCandidates: DEFAULT_CONFIG.dedup.maxCandidates,
    },
    store: {
      path: DEFAULT_CONFIG.store.path,
    },
    sync: {
      markdownToMem0: DEFAULT_CONFIG.sync.markdownToMem0,
      mem0ToMarkdown: DEFAULT_CONFIG.sync.mem0ToMarkdown,
    },
    feedback: {
      enabled: DEFAULT_CONFIG.feedback.enabled,
      review: {
        mode: DEFAULT_CONFIG.feedback.review.mode,
      },
      derivedSignals: {
        enabled: DEFAULT_CONFIG.feedback.derivedSignals.enabled,
        recallUsedEvidence: DEFAULT_CONFIG.feedback.derivedSignals.recallUsedEvidence,
        neverRecalledAfterDays: DEFAULT_CONFIG.feedback.derivedSignals.neverRecalledAfterDays,
        supersededWithinTurns: DEFAULT_CONFIG.feedback.derivedSignals.supersededWithinTurns,
      },
      reports: {
        redactByDefault: DEFAULT_CONFIG.feedback.reports.redactByDefault,
        maxExcerptChars: DEFAULT_CONFIG.feedback.reports.maxExcerptChars,
      },
    },
    scope: {
      default: DEFAULT_CONFIG.scope.default,
      rules: DEFAULT_CONFIG.scope.rules.map((rule) => ({
        action: rule.action,
        match: { ...rule.match },
      })),
    },
    llm: {
      provider: DEFAULT_CONFIG.llm.provider,
      model: DEFAULT_CONFIG.llm.model,
    },
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readBoolean(record: Record<string, unknown>, key: string, current: boolean): boolean {
  if (!(key in record)) {
    return current;
  }
  if (typeof record[key] !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return record[key] as boolean;
}

function readString(record: Record<string, unknown>, key: string, current: string): string {
  if (!(key in record)) {
    return current;
  }
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  current: number,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (!(key in record)) {
    return current;
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  const normalized = options.integer ? Math.floor(value) : value;
  if (options.min !== undefined && normalized < options.min) {
    throw new Error(`${key} must be >= ${options.min}`);
  }
  if (options.max !== undefined && normalized > options.max) {
    throw new Error(`${key} must be <= ${options.max}`);
  }
  return normalized;
}

function readArrayEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  current: T[],
): T[] {
  if (!(key in record)) {
    return current;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  if (value.length === 0) {
    return [];
  }
  const normalized: T[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${key} must contain only strings`);
    }
    if (!allowed.includes(item as T)) {
      throw new Error(`${key} has unsupported value: ${item}`);
    }
    normalized.push(item as T);
  }
  return [...new Set(normalized)];
}

function readScopeRules(current: Mem0Config["scope"]["rules"], value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("scope.rules must be an array");
  }
  const normalized: Mem0Config["scope"]["rules"] = [];
  for (const rule of value) {
    const record = asRecord(rule, "scope.rules[]");
    const action = record.action;
    if (action !== "allow" && action !== "deny") {
      throw new Error("scope.rules[].action must be allow or deny");
    }
    const match = asRecord(record.match, "scope.rules[].match");
    const chatType = match.chatType;
    if (chatType !== undefined && !CHAT_TYPES.includes(chatType as ScopeChatType)) {
      throw new Error(`scope.rules[].match.chatType has unsupported value: ${String(chatType)}`);
    }
    normalized.push({
      action,
      match: {
        chatType: chatType as ScopeChatType | undefined,
      },
    });
  }
  return normalized.length > 0 ? normalized : current;
}

function readTriggers(
  record: Record<string, unknown>,
  key: string,
  current: Array<"user" | "assistant" | "both">,
): Array<"user" | "assistant" | "both"> {
  const allowed = ["user", "assistant", "both"] as const;
  return readArrayEnum(record, key, allowed, current);
}

export const memoryMem0ConfigSchema = {
  parse(value: unknown): Mem0Config {
    const next = cloneDefaultConfig();
    if (!value) {
      return next;
    }

    const root = asRecord(value, "memory-mem0 config");

    if ("autoExtract" in root) {
      const autoExtract = asRecord(root.autoExtract, "autoExtract");
      next.autoExtract.enabled = readBoolean(autoExtract, "enabled", next.autoExtract.enabled);
      next.autoExtract.triggers = readTriggers(autoExtract, "triggers", next.autoExtract.triggers);
      next.autoExtract.memoryTypes = readArrayEnum(
        autoExtract,
        "memoryTypes",
        MEMORY_TYPES,
        next.autoExtract.memoryTypes,
      );
      next.autoExtract.proceduralNamespaces = readArrayEnum(
        autoExtract,
        "proceduralNamespaces",
        PROCEDURAL_NAMESPACES,
        next.autoExtract.proceduralNamespaces,
      );
      next.autoExtract.minMessageLength = readNumber(
        autoExtract,
        "minMessageLength",
        next.autoExtract.minMessageLength,
        { min: 1, integer: true },
      );
      next.autoExtract.rateLimitSeconds = readNumber(
        autoExtract,
        "rateLimitSeconds",
        next.autoExtract.rateLimitSeconds,
        { min: 0, integer: true },
      );

      if ("delta" in autoExtract) {
        const delta = asRecord(autoExtract.delta, "autoExtract.delta");
        const strategy = delta.strategy;
        if (strategy !== undefined && strategy !== "since_last_processed") {
          throw new Error("autoExtract.delta.strategy must be since_last_processed");
        }
        next.autoExtract.delta.strategy = "since_last_processed";
        next.autoExtract.delta.maxMessagesPerRun = readNumber(
          delta,
          "maxMessagesPerRun",
          next.autoExtract.delta.maxMessagesPerRun,
          { min: 1, integer: true },
        );
      }
    }

    if ("recall" in root) {
      const recall = asRecord(root.recall, "recall");
      next.recall.enabled = readBoolean(recall, "enabled", next.recall.enabled);
      next.recall.maxInjectedMemories = readNumber(
        recall,
        "maxInjectedMemories",
        next.recall.maxInjectedMemories,
        { min: 1, integer: true },
      );
      next.recall.maxInjectedChars = readNumber(
        recall,
        "maxInjectedChars",
        next.recall.maxInjectedChars,
        { min: 1, integer: true },
      );

      if ("procedural" in recall) {
        const procedural = asRecord(recall.procedural, "recall.procedural");
        next.recall.procedural.enabled = readBoolean(
          procedural,
          "enabled",
          next.recall.procedural.enabled,
        );
        next.recall.procedural.maxInjectedPatterns = readNumber(
          procedural,
          "maxInjectedPatterns",
          next.recall.procedural.maxInjectedPatterns,
          { min: 1, integer: true },
        );
        const injectAs = procedural.injectAs;
        if (injectAs !== undefined && injectAs !== "workflow_preferences_section") {
          throw new Error("recall.procedural.injectAs must be workflow_preferences_section");
        }
        next.recall.procedural.injectAs = "workflow_preferences_section";
      }
    }

    if ("dedup" in root) {
      const dedup = asRecord(root.dedup, "dedup");
      next.dedup.enabled = readBoolean(dedup, "enabled", next.dedup.enabled);
      next.dedup.similarityThreshold = readNumber(
        dedup,
        "similarityThreshold",
        next.dedup.similarityThreshold,
        { min: 0, max: 1 },
      );
      next.dedup.maxCandidates = readNumber(dedup, "maxCandidates", next.dedup.maxCandidates, {
        min: 1,
        integer: true,
      });
    }

    if ("store" in root) {
      const store = asRecord(root.store, "store");
      next.store.path = readString(store, "path", next.store.path);
    }

    if ("sync" in root) {
      const sync = asRecord(root.sync, "sync");
      next.sync.markdownToMem0 = readBoolean(sync, "markdownToMem0", next.sync.markdownToMem0);
      next.sync.mem0ToMarkdown = readBoolean(sync, "mem0ToMarkdown", next.sync.mem0ToMarkdown);
    }

    if ("feedback" in root) {
      const feedback = asRecord(root.feedback, "feedback");
      next.feedback.enabled = readBoolean(feedback, "enabled", next.feedback.enabled);

      if ("review" in feedback) {
        const review = asRecord(feedback.review, "feedback.review");
        const mode = review.mode;
        if (mode !== undefined && mode !== "owner_cli_only") {
          throw new Error("feedback.review.mode must be owner_cli_only");
        }
        next.feedback.review.mode = "owner_cli_only";
      }

      if ("derivedSignals" in feedback) {
        const signals = asRecord(feedback.derivedSignals, "feedback.derivedSignals");
        next.feedback.derivedSignals.enabled = readBoolean(
          signals,
          "enabled",
          next.feedback.derivedSignals.enabled,
        );
        const evidence = signals.recallUsedEvidence;
        if (evidence !== undefined && evidence !== "explicit_only") {
          throw new Error("feedback.derivedSignals.recallUsedEvidence must be explicit_only");
        }
        next.feedback.derivedSignals.recallUsedEvidence = "explicit_only";
        next.feedback.derivedSignals.neverRecalledAfterDays = readNumber(
          signals,
          "neverRecalledAfterDays",
          next.feedback.derivedSignals.neverRecalledAfterDays,
          { min: 1, integer: true },
        );
        next.feedback.derivedSignals.supersededWithinTurns = readNumber(
          signals,
          "supersededWithinTurns",
          next.feedback.derivedSignals.supersededWithinTurns,
          { min: 1, integer: true },
        );
      }

      if ("reports" in feedback) {
        const reports = asRecord(feedback.reports, "feedback.reports");
        next.feedback.reports.redactByDefault = readBoolean(
          reports,
          "redactByDefault",
          next.feedback.reports.redactByDefault,
        );
        next.feedback.reports.maxExcerptChars = readNumber(
          reports,
          "maxExcerptChars",
          next.feedback.reports.maxExcerptChars,
          { min: 1, integer: true },
        );
      }
    }

    if ("scope" in root) {
      const scope = asRecord(root.scope, "scope");
      const defaultMode = scope.default;
      if (defaultMode !== undefined && defaultMode !== "allow" && defaultMode !== "deny") {
        throw new Error("scope.default must be allow or deny");
      }
      if (defaultMode !== undefined) {
        next.scope.default = defaultMode;
      }
      if ("rules" in scope) {
        next.scope.rules = readScopeRules(next.scope.rules, scope.rules);
      }
    }

    if ("llm" in root) {
      const llm = asRecord(root.llm, "llm");
      next.llm.provider = readString(llm, "provider", next.llm.provider);
      next.llm.model = readString(llm, "model", next.llm.model);
    }

    return next;
  },
  uiHints: {
    "store.path": {
      label: "Mem0 Store Path",
      help: "SQLite path for mem0-style structured memory storage",
      advanced: true,
      placeholder: DEFAULT_STORE_PATH,
    },
    "autoExtract.enabled": {
      label: "Auto Extract",
      help: "Capture semantic/episodic/procedural memories after successful runs",
    },
    "recall.enabled": {
      label: "Recall Injection",
      help: "Inject relevant memories into prompt context before model execution",
    },
    "scope.default": {
      label: "Default Scope",
      help: "Use deny-by-default with explicit allow rules for safe capture",
    },
  },
};

export function resolveStorePathTemplate(template: string, agentId: string): string {
  return template.replaceAll("{agentId}", agentId || "default");
}
