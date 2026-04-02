/**
 * Simple skill prompt loader for memory extraction.
 * Reads markdown skill files relative to the plugin directory and caches them.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string>();

function resolveSkillsDir(): string {
  const candidates: string[] = [];

  // Strategy 1: import.meta.url (native ESM)
  try {
    const metaDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(metaDir, "skills"));
  } catch {
    // import.meta.url may not be available under jiti
  }

  // Strategy 2: __dirname (CJS / jiti fallback)
  if (typeof __dirname !== "undefined") {
    candidates.push(path.join(__dirname, "skills"));
  }

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "extraction-triage.md"))) {
      return dir;
    }
  }

  throw new Error("memory-mem0: unable to resolve skills directory");
}

function loadSkillFile(filename: string): string {
  const cached = cache.get(filename);
  if (cached !== undefined) {
    return cached;
  }

  const skillsDir = resolveSkillsDir();
  const filePath = path.join(skillsDir, filename);
  const content = fs.readFileSync(filePath, "utf-8").trim();
  cache.set(filename, content);
  return content;
}

export function loadExtractionPrompt(customRules?: {
  include?: string[];
  exclude?: string[];
}): string {
  let prompt = loadSkillFile("extraction-triage.md");

  const additions: string[] = [];
  if (customRules?.include && customRules.include.length > 0) {
    additions.push("\n## Additional Rules (Include)");
    for (const rule of customRules.include) {
      additions.push(`- ${rule}`);
    }
  }
  if (customRules?.exclude && customRules.exclude.length > 0) {
    additions.push("\n## Additional Rules (Exclude)");
    for (const rule of customRules.exclude) {
      additions.push(`- Do NOT extract: ${rule}`);
    }
  }

  if (additions.length > 0) {
    prompt += `\n${additions.join("\n")}`;
  }

  return prompt;
}
