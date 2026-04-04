import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { fallbackCategoryFromType, getCategoryImportance, isValidCategory } from "./categories.js";
import type { DedupAction, Mem0Config, MemoryType, ProceduralNamespace } from "./config.js";
import {
  looksLikePromptInjection,
  normalizeForSimilarity,
  type DeltaMessage,
  type ExtractedMemoryCandidate,
} from "./extract.js";
import { loadExtractionPrompt } from "./skill-loader.js";
import type { ExistingMemoryCandidate } from "./storage.js";

type ModelSelection = {
  provider: string;
  model: string;
};

export type LlmDedupDecision = {
  action: DedupAction;
  targetMemoryId?: string;
  nextText?: string;
  reason?: string;
};

const INTERNAL_SESSION_KEY_PREFIX = "mem0-internal:";
const LLM_TIMEOUT_MS = 35_000;
const MAX_EXTRACTED_MEMORIES = 12;

function stripCodeFences(text: string): string {
  // Strip <think>...</think> blocks from reasoning models (DeepSeek, QwQ, etc.)
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(cleaned);
  if (match) {
    return (match[1] ?? "").trim();
  }
  return cleaned;
}

function parseJsonObject(raw: string): unknown {
  const stripped = stripCodeFences(raw);
  try {
    return JSON.parse(stripped);
  } catch {
    const firstBrace = stripped.indexOf("{");
    const lastBrace = stripped.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
    }
    const firstBracket = stripped.indexOf("[");
    const lastBracket = stripped.lastIndexOf("]");
    if (firstBracket >= 0 && lastBracket > firstBracket) {
      return JSON.parse(stripped.slice(firstBracket, lastBracket + 1));
    }
    throw new Error("memory-mem0: model returned invalid JSON");
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resolveModelSelection(cfg: Mem0Config, api: OpenClawPluginApi): ModelSelection {
  const modelCfg = api.config?.agents?.defaults?.model;
  const primary = typeof modelCfg === "string" ? modelCfg : modelCfg?.primary;
  const [primaryProvider, ...primaryModelParts] =
    typeof primary === "string" ? primary.split("/") : [];
  const primaryModel = primaryModelParts.join("/");

  let provider = cfg.llm.provider.trim();
  let model = cfg.llm.model.trim();

  if (provider === "auto") {
    provider = primaryProvider ?? "";
  }
  if (model === "fast") {
    model = primaryModel ?? "";
  }

  if (!provider && model.includes("/")) {
    const [fromModelProvider, ...fromModelParts] = model.split("/");
    provider = fromModelProvider;
    model = fromModelParts.join("/");
  }

  if (!provider || !model) {
    throw new Error(
      "memory-mem0: unable to resolve extraction model. Configure plugins.entries.memory-mem0.config.llm.provider/model or set agents.defaults.model.primary.",
    );
  }

  return {
    provider,
    model,
  };
}

type LlmTaskResult = {
  json: unknown;
  model: ModelSelection;
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are a JSON-only function.",
  "Return only valid JSON.",
  "Do not use markdown fences.",
  "Do not include explanations.",
  "Do not call tools.",
].join(" ");

async function runJsonTask(params: {
  api: OpenClawPluginApi;
  cfg: Mem0Config;
  instruction: string;
  input: Record<string, unknown>;
  runLabel: string;
  systemPrompt?: string;
}): Promise<LlmTaskResult> {
  const model = resolveModelSelection(params.cfg, params.api);

  const systemPrompt = params.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const userMessage = `TASK:\n${params.instruction}\n\nINPUT_JSON:\n${JSON.stringify(
    params.input,
    null,
    2,
  )}`;

  // Resolve API key for the configured provider
  const auth = await params.api.runtime.modelAuth.resolveApiKeyForProvider({
    provider: model.provider,
  });
  const apiKey = auth?.apiKey;
  if (!apiKey) {
    throw new Error(
      `memory-mem0: no API key resolved for provider "${model.provider}". Configure auth via openclaw models auth login.`,
    );
  }

  // Direct Anthropic Messages API call — bypasses the subagent pipeline
  // so we get clean JSON without tools, memory injection, or agent context.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `memory-mem0: Anthropic API error ${response.status}: ${errorBody.slice(0, 200)}`,
      );
    }

    const result = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (result.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("memory-mem0: model returned empty output");
    }

    return { json: parseJsonObject(text), model };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeNamespace(value: unknown): ProceduralNamespace | undefined {
  if (value === "user_workflow" || value === "execution_trace") {
    return value;
  }
  return undefined;
}

function normalizeType(value: unknown): MemoryType | undefined {
  if (value === "semantic" || value === "episodic" || value === "procedural") {
    return value;
  }
  return undefined;
}

function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return null;
}

function safeImportance(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return null;
}

export function isInternalMem0Session(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.startsWith(INTERNAL_SESSION_KEY_PREFIX);
}

export class Mem0LlmEngine {
  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly cfg: Mem0Config,
  ) {}

  async extractCandidates(params: {
    deltaMessages: DeltaMessage[];
    memoryTypes: MemoryType[];
    proceduralNamespaces: ProceduralNamespace[];
  }): Promise<ExtractedMemoryCandidate[]> {
    if (params.deltaMessages.length === 0) {
      return [];
    }

    const inputMessages = params.deltaMessages.map((message) => ({
      index: message.index,
      role: message.role,
      text: message.text,
    }));

    const skillPrompt = loadExtractionPrompt(
      (this.cfg.autoExtract as Record<string, unknown>).customRules as
        | { include?: string[]; exclude?: string[] }
        | undefined,
    );

    const instruction = [
      "Apply the extraction protocol above to the provided conversation messages.",
      "Do not emit procedural execution traces in this phase.",
      `Limit to at most ${MAX_EXTRACTED_MEMORIES} memories.`,
    ].join(" ");

    const task = await runJsonTask({
      api: this.api,
      cfg: this.cfg,
      instruction,
      systemPrompt: skillPrompt,
      input: {
        allowed_memory_types: params.memoryTypes,
        allowed_procedural_namespaces: params.proceduralNamespaces,
        messages: inputMessages,
      },
      runLabel: "mem0-extract",
    });

    const result = task.json as Record<string, unknown>;
    const rawMemories = Array.isArray(result.memories) ? result.memories : [];
    const allowedMessageIndexes = new Map(
      params.deltaMessages.map((message) => [message.index, message]),
    );

    const candidates: ExtractedMemoryCandidate[] = [];
    const seen = new Set<string>();

    for (const rawEntry of rawMemories.slice(0, MAX_EXTRACTED_MEMORIES)) {
      if (!rawEntry || typeof rawEntry !== "object") {
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      const memoryType = normalizeType(entry.memory_type);
      if (!memoryType || !params.memoryTypes.includes(memoryType)) {
        continue;
      }

      const namespace = normalizeNamespace(entry.namespace);
      if (memoryType === "procedural") {
        if (namespace !== "user_workflow") {
          continue;
        }
        if (!params.proceduralNamespaces.includes("user_workflow")) {
          continue;
        }
      }

      const text = normalizeMemoryText(typeof entry.text === "string" ? entry.text : "");
      if (!text || text.length < 8) {
        continue;
      }
      if (looksLikePromptInjection(text)) {
        continue;
      }

      const sourceMessageIndex = safeNumber(entry.source_message_index);
      if (sourceMessageIndex === null || !allowedMessageIndexes.has(sourceMessageIndex)) {
        continue;
      }

      const message = allowedMessageIndexes.get(sourceMessageIndex)!;
      const sourceExcerpt =
        normalizeMemoryText(typeof entry.source_excerpt === "string" ? entry.source_excerpt : "") ||
        message.text;

      const rawCategory = typeof entry.category === "string" ? entry.category.trim() : "";
      const category = isValidCategory(rawCategory)
        ? rawCategory
        : fallbackCategoryFromType(memoryType, namespace ?? undefined);
      const rawImportance = safeImportance(entry.importance);
      const importance = rawImportance ?? getCategoryImportance(category);

      const key = `${memoryType}:${namespace ?? "none"}:${normalizeForSimilarity(text)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      candidates.push({
        memoryType,
        namespace,
        text,
        sourceExcerpt: truncate(sourceExcerpt, 320),
        sourceMessageIndex,
        category,
        importance,
      });
    }

    return candidates;
  }

  async decideDedupAction(params: {
    candidate: ExtractedMemoryCandidate;
    existing: ExistingMemoryCandidate[];
  }): Promise<LlmDedupDecision> {
    if (params.existing.length === 0) {
      return {
        action: "ADD",
        nextText: params.candidate.text,
        reason: "no_existing_candidates",
      };
    }

    const references = params.existing.map((memory, index) => ({
      ref: `m${index + 1}`,
      id: memory.id,
      text: memory.text,
      score: memory.score,
    }));
    const byRef = new Map(references.map((entry) => [entry.ref, entry.id]));

    const instruction = [
      "Choose a memory dedup action for one extracted memory candidate.",
      "Return JSON with shape:",
      '{"action":"ADD|UPDATE|DELETE|NONE","target_ref":"m1|m2|...|null","updated_text":"...","reason":"..."}',
      "Rules:",
      "- ADD when no existing memory captures the same reusable information.",
      "- NONE when candidate duplicates an existing memory with no meaningful change.",
      "- UPDATE when an existing memory should be revised with candidate information.",
      "- DELETE only when an existing memory should be removed due to contradiction/invalidity.",
      "- target_ref must be null for ADD, and must match one provided ref for UPDATE/DELETE/NONE.",
      "- updated_text is required for UPDATE, optional for ADD, and ignored for DELETE/NONE.",
      "- Keep text concise, factual, and instruction-free.",
    ].join(" ");

    const task = await runJsonTask({
      api: this.api,
      cfg: this.cfg,
      instruction,
      input: {
        candidate: {
          memory_type: params.candidate.memoryType,
          namespace: params.candidate.namespace ?? null,
          text: params.candidate.text,
          source_excerpt: params.candidate.sourceExcerpt,
        },
        existing: references,
      },
      runLabel: "mem0-dedup",
    });

    const payload = task.json as Record<string, unknown>;
    const actionRaw = typeof payload.action === "string" ? payload.action.toUpperCase() : "ADD";
    const action: DedupAction =
      actionRaw === "ADD" ||
      actionRaw === "UPDATE" ||
      actionRaw === "DELETE" ||
      actionRaw === "NONE"
        ? actionRaw
        : "ADD";

    const targetRef = typeof payload.target_ref === "string" ? payload.target_ref : "";
    const targetMemoryId = byRef.get(targetRef);
    const updatedText = normalizeMemoryText(
      typeof payload.updated_text === "string" ? payload.updated_text : "",
    );
    const reason = truncate(
      normalizeMemoryText(typeof payload.reason === "string" ? payload.reason : ""),
      240,
    );

    if (action === "ADD") {
      const nextText = updatedText || params.candidate.text;
      return {
        action,
        nextText: looksLikePromptInjection(nextText) ? params.candidate.text : nextText,
        reason: reason || "llm_add",
      };
    }

    if (!targetMemoryId) {
      return {
        action: "ADD",
        nextText: params.candidate.text,
        reason: reason || "missing_target_ref_fallback_add",
      };
    }

    if (action === "UPDATE") {
      const nextText = updatedText || params.candidate.text;
      return {
        action,
        targetMemoryId,
        nextText: looksLikePromptInjection(nextText) ? params.candidate.text : nextText,
        reason: reason || "llm_update",
      };
    }

    return {
      action,
      targetMemoryId,
      reason: reason || `llm_${action.toLowerCase()}`,
    };
  }
}
