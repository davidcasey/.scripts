/**
 * lib/style.mjs — loads the house writing-style guide and returns it as a prompt
 * block to inject into AI calls. Defaults to the repo's guide; override with
 * TEAM_STYLE_FILE. Memoized; reads process.env at first call (after loadEnv()).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { REPO_ROOT, expandHome } from "./env.mjs";

let cached = null;

export function getStyleBlock() {
  if (cached !== null) return cached;
  const p = process.env.TEAM_STYLE_FILE
    ? expandHome(process.env.TEAM_STYLE_FILE)
    : join(REPO_ROOT, ".github/instructions/writing-style.instructions.md");
  const guide = existsSync(p) ? readFileSync(p, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim() : "";
  cached = guide ? `\n\nFollow these writing conventions:\n${guide}\n` : "";
  return cached;
}
