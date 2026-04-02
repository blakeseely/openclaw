import type { MemoryType, ProceduralNamespace } from "./config.js";
import { normalizeForSimilarity } from "./storage.js";

export type DeltaMessage = {
  index: number;
  role: "user" | "assistant";
  text: string;
};

export type ExtractedMemoryCandidate = {
  memoryType: MemoryType;
  namespace?: ProceduralNamespace;
  text: string;
  sourceExcerpt: string;
  sourceMessageIndex: number;
  category?: string;
  importance?: number;
};

const PROMPT_INJECTION_PATTERNS = [
  /ignore (all|any|previous|above|prior) instructions/i,
  /do not follow (the )?(system|developer)/i,
  /system prompt/i,
  /developer message/i,
  /<\s*(system|assistant|developer|tool|function|relevant-memories)\b/i,
  /\b(run|execute|call|invoke)\b.{0,48}\b(tool|command)\b/i,
];

const ONE_TIME_PATTERNS = [
  /\b(this|that)\s+(task|ticket|issue|request)\b/i,
  /\bfor now\b/i,
  /\bright now\b/i,
  /\bone[- ]time\b/i,
  /\bjust this once\b/i,
  /\btoday only\b/i,
  /\btemporary\b/i,
];

const WORKFLOW_SIGNAL_PATTERNS = [
  /\b(prefer|preferably|prefered|preferred)\b/i,
  /\b(want|need|expect|require)\b/i,
  /\b(always|never|avoid|don'?t|do not)\b/i,
  /\b(brief|concise|minimal|small changes)\b/i,
  /\b(test|tests|coverage|lint|format)\b/i,
  /\b(commit|commits|commit message)\b/i,
  /\b(bun|node|typescript|javascript)\b/i,
  /\b(refactor|abstraction|composition|inheritance)\b/i,
];

const SEMANTIC_SIGNAL_PATTERNS = [
  /\b(i|we)\s+(prefer|like|love|hate|want|need)\b/i,
  /\bmy\s+[a-z][a-z0-9_-]{1,30}\s+(is|are|was)\b/i,
  /\b(always|never)\b/i,
  /\buse\s+(bun|node|typescript|javascript|pnpm)\b/i,
  /\b(single owner|owner only|human only)\b/i,
];

const EPISODIC_SIGNAL_PATTERNS = [
  /\b(today|yesterday|tomorrow|last week|this week)\b/i,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/i,
  /\b(deployed|released|shipped|rolled back|fixed|broke|investigated|committed)\b/i,
  /\b(version|v\d+\.\d+|build)\b/i,
];

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function looksLikePromptInjection(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function escapeMemoryForPrompt(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char] ?? char);
}

export { normalizeForSimilarity, recallScore, similarityScore } from "./storage.js";

export function collectDeltaMessages(params: {
  messages: unknown[];
  fromIndex: number;
  maxMessages: number;
  minMessageLength: number;
  triggers: Array<"user" | "assistant" | "both">;
}): DeltaMessage[] {
  const allowUser = params.triggers.includes("both") || params.triggers.includes("user");
  const allowAssistant = params.triggers.includes("both") || params.triggers.includes("assistant");

  const collected: DeltaMessage[] = [];
  for (let index = params.fromIndex + 1; index < params.messages.length; index += 1) {
    const raw = params.messages[index];
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const message = raw as Record<string, unknown>;
    const roleRaw = typeof message.role === "string" ? message.role : "";
    const role = roleRaw === "assistant" ? "assistant" : roleRaw === "user" ? "user" : null;
    if (!role) {
      continue;
    }
    if ((role === "user" && !allowUser) || (role === "assistant" && !allowAssistant)) {
      continue;
    }

    for (const text of extractTextBlocks(message.content)) {
      const normalized = normalizeWhitespace(text);
      if (!normalized || normalized.length < params.minMessageLength) {
        continue;
      }
      collected.push({ index, role, text: normalized });
      if (collected.length >= params.maxMessages) {
        return collected;
      }
    }
  }

  return collected;
}

export function extractMemoryCandidates(params: {
  messages: DeltaMessage[];
  memoryTypes: MemoryType[];
  proceduralNamespaces: ProceduralNamespace[];
}): ExtractedMemoryCandidate[] {
  const includeSemantic = params.memoryTypes.includes("semantic");
  const includeEpisodic = params.memoryTypes.includes("episodic");
  const includeProcedural =
    params.memoryTypes.includes("procedural") &&
    params.proceduralNamespaces.includes("user_workflow");

  const dedupe = new Set<string>();
  const out: ExtractedMemoryCandidate[] = [];

  for (const message of params.messages) {
    const text = normalizeWhitespace(message.text);
    if (!text || looksLikePromptInjection(text)) {
      continue;
    }
    if (text.includes("<relevant-memories>") || text.includes("<workflow-preferences>")) {
      continue;
    }

    const sentences = splitSentences(text);

    if (includeSemantic) {
      for (const sentence of sentences) {
        if (!isSemanticCandidate(sentence)) {
          continue;
        }
        if (!isReusable(sentence)) {
          continue;
        }
        pushCandidate({
          out,
          dedupe,
          memoryType: "semantic",
          text: sentence,
          sourceExcerpt: text,
          sourceMessageIndex: message.index,
        });
      }
    }

    if (includeEpisodic) {
      for (const sentence of sentences) {
        if (!isEpisodicCandidate(sentence)) {
          continue;
        }
        pushCandidate({
          out,
          dedupe,
          memoryType: "episodic",
          text: sentence,
          sourceExcerpt: text,
          sourceMessageIndex: message.index,
        });
      }
    }

    if (includeProcedural) {
      const patterns = extractWorkflowPatterns(text);
      for (const pattern of patterns) {
        pushCandidate({
          out,
          dedupe,
          memoryType: "procedural",
          namespace: "user_workflow",
          text: pattern,
          sourceExcerpt: text,
          sourceMessageIndex: message.index,
        });
      }
    }
  }

  return out;
}

function pushCandidate(params: {
  out: ExtractedMemoryCandidate[];
  dedupe: Set<string>;
  memoryType: MemoryType;
  namespace?: ProceduralNamespace;
  text: string;
  sourceExcerpt: string;
  sourceMessageIndex: number;
}) {
  const normalizedText = normalizeSentence(params.text);
  if (!normalizedText || normalizedText.length < 6) {
    return;
  }
  const key = `${params.memoryType}:${params.namespace ?? "none"}:${normalizeForSimilarity(normalizedText)}`;
  if (params.dedupe.has(key)) {
    return;
  }
  params.dedupe.add(key);

  params.out.push({
    memoryType: params.memoryType,
    namespace: params.namespace,
    text: normalizedText,
    sourceExcerpt: truncate(params.sourceExcerpt, 320),
    sourceMessageIndex: params.sourceMessageIndex,
  });
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      blocks.push(record.text);
    }
  }
  return blocks;
}

function splitSentences(text: string): string[] {
  return text
    .split(/[\n.!?]+/)
    .map((entry) => normalizeSentence(entry))
    .filter((entry) => entry.length >= 12);
}

function normalizeSentence(text: string): string {
  return normalizeWhitespace(text)
    .replace(/^[-*\d.\s]+/, "")
    .replace(/^please\s+/i, "")
    .trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function isReusable(text: string): boolean {
  if (!text) {
    return false;
  }
  return !ONE_TIME_PATTERNS.some((pattern) => pattern.test(text));
}

function isSemanticCandidate(text: string): boolean {
  return SEMANTIC_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function isEpisodicCandidate(text: string): boolean {
  return EPISODIC_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function extractWorkflowPatterns(text: string): string[] {
  const lines = splitSentences(text);
  const patterns: string[] = [];
  for (const line of lines) {
    if (!WORKFLOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }
    if (!isReusable(line)) {
      continue;
    }

    const canonical = canonicalizeWorkflowPattern(line);
    if (!canonical || canonical.length < 12) {
      continue;
    }
    if (looksLikePromptInjection(canonical)) {
      continue;
    }
    patterns.push(canonical);
    if (patterns.length >= 2) {
      break;
    }
  }
  return patterns;
}

function canonicalizeWorkflowPattern(text: string): string {
  const normalized = normalizeSentence(text);
  if (!normalized) {
    return "";
  }

  let sentence = normalized.replace(/^(can you|could you|please|let'?s)\s+/i, "").trim();
  if (/^i\s+/i.test(sentence)) {
    sentence = sentence.replace(/^i\s+/i, "User ");
  } else if (/^we\s+/i.test(sentence)) {
    sentence = sentence.replace(/^we\s+/i, "User prefers we ");
  } else if (/^don'?t\s+/i.test(sentence) || /^do not\s+/i.test(sentence)) {
    sentence = `User prefers that we ${sentence.toLowerCase()}`;
  } else if (!/^user\s+/i.test(sentence)) {
    sentence = `User preference: ${sentence}`;
  }

  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
