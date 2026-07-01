/**
 * lib/style.mjs — loads the house writing-style guide and returns it as a prompt
 * block to inject into AI calls, plus concrete plain-language rules.
 *
 * Resolution order (first wins):
 *   1. TEAM_STYLE_FILE (if set and present)
 *   2. the repo's .github/instructions/writing-style.instructions.md (if present)
 *   3. DEFAULT_STYLE embedded below — so a portable copy of chronicle/ still has
 *      the full style even when detached from the repo.
 * Memoized; reads process.env at first call (after loadEnv()).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { REPO_ROOT, expandHome } from "./env.mjs";

// Embedded fallback: mirrors .github/instructions/writing-style.instructions.md
// (body only, no frontmatter). Kept as an array to avoid backtick escaping.
const DEFAULT_STYLE = [
  "Follow these writing conventions in all generated text, documentation, notes, and markdown output.",
  "",
  "## Style",
  "",
  "- Write in Chicago style (CMOS 17th edition conventions).",
  "- Use the Oxford (serial) comma in all lists of three or more items.",
  "- Use em-dashes sparingly. Prefer colons, semicolons, commas, or parentheses. One per document is fine; five is too many.",
  "- Use en-dashes only for ranges (e.g., pages 10–12, 2020–2025).",
  "- Prefer active voice. Use passive voice only when the actor is unknown or irrelevant.",
  "- Keep sentences direct. Avoid filler words, hedging, and unnecessary qualifiers.",
  '- Use second person ("you") for instructions, third person for descriptions.',
  "- Define technical terms on first use.",
  "- One main idea per paragraph. Keep paragraphs to 3–5 sentences.",
  '- Be confident but not absolute ("this approach works well" not "this is the best approach").',
  "",
  "## Tone",
  "",
  "- Professional and neutral. Not casual, not corporate.",
  "- No emojis unless they clearly improve readability.",
  "- No exclamation marks unless quoting someone.",
  "- Do not use ALL CAPS for emphasis; use **bold** instead.",
  "",
  "## Formatting (Markdown)",
  "",
  "- Use ATX-style headings (`#`, `##`, `###`). Do not skip heading levels.",
  "- Title Case for H1 and H2. Sentence case for H3 and below.",
  "- Use `-` for unordered lists, `1.` for ordered lists.",
  "- Wrap symbol names, file paths, commands, and code references in backticks: `garmin_sync.py`, `handleClick()`.",
  "- Use fenced code blocks with a language identifier for multi-line code. Always specify the language.",
  "- Separate sections with `---` only when a thematic break is intentional, not as decoration.",
  "- Use **bold** for key terms on first introduction. Use _italics_ sparingly, for emphasis or titles.",
  "- Tables should have descriptive headers and consistent alignment.",
  "",
  "## Word Choices",
  "",
  '- "Use" not "utilize," unless you mean repurposing something beyond its intended function.',
  '- "Ensure" (to make certain) not "insure" (to provide insurance) unless you mean insurance.',
  '- "Start" not "kick off."',
  '- "About" not "around" (when meaning approximately).',
  '- "Whether" not "whether or not."',
  '- Do not start sentences with "So," "Basically," "Actually," or "Obviously."',
  "",
  "## Structure",
  "",
  "- Lead with the most important information.",
  '- Start with the "why" before the "how" when both are needed.',
  "- Use headings to create scannable structure.",
  "- Prefer bullet lists for items that do not require narrative flow.",
  "- Use progressive disclosure: simple before complex.",
].join("\n");

// Concrete plain-language rules to keep AI summaries readable and un-buzzwordy.
// Appended to every summary prompt (in addition to the style guide).
const PLAIN_LANGUAGE = `Plain-language rules (important — these summaries read as buzzword soup otherwise):
- Write like you are telling a teammate what happened. Concrete and specific, never grand or abstract.
- Name what actually changed and its practical effect: "Added a retry so failed uploads recover" — not "delivered foundational resilience to elevate the upload experience."
- Ban corporate/marketing jargon. Do NOT use: foundational, robust, seamless(ly), leverage, utilize, holistic, synergy, streamline, empower, unlock, elevate, architected, principled, composable primitives, structural depth, drive/accelerate delivery, best-in-class, cutting-edge, paradigm, at scale, journey, deep-dive, first-class, ecosystem (unless literal), significant/major/powerful/comprehensive (unless a number backs it up).
- Prefer short, plain words over Latinate ones (use "use" not "utilize", "start" not "kick off", "let" not "enable").
- If a sentence still makes sense with a word removed, remove it.`;

let cached = null;

export function getStyleBlock() {
  if (cached !== null) return cached;
  const p = process.env.TEAM_STYLE_FILE
    ? expandHome(process.env.TEAM_STYLE_FILE)
    : join(REPO_ROOT, ".github/instructions/writing-style.instructions.md");
  const fromFile = existsSync(p) ? readFileSync(p, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim() : "";
  const guide = fromFile || DEFAULT_STYLE;   // external file overrides; embedded default keeps it portable
  cached = `\n\n${[guide, PLAIN_LANGUAGE].join("\n\n")}\n`;
  return cached;
}
