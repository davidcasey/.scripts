#!/usr/bin/env node
/**
 * team-quarterly.mjs
 * Rolls up weekly team heartbeat files for a quarter into a single
 * domain-grouped narrative with Mermaid charts. Mirrors summary-quarterly.mjs
 * but reads the team heartbeat area and groups by DOMAIN (no daily TODOs).
 *
 * Usage:
 *   node src/chronicle/team-quarterly.mjs                 # current quarter
 *   node src/chronicle/team-quarterly.mjs --quarter 2026-Q2
 *   node src/chronicle/team-quarterly.mjs --quarter 2026-Q2 --force
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { loadEnv, expandHome } from "./lib/env.mjs";
import { pad, fmtDate, fmtDateShort, isoWeek, quarterBounds, weeksInRange } from "./lib/dates.mjs";
import { callAI } from "./lib/ai.mjs";
import { getStyleBlock } from "./lib/style.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

loadEnv();

const SUMMARY_SUFFIX = process.env.TEAM_SUMMARY_FILENAME_SUFFIX || "Heartbeat";
const styleBlock     = getStyleBlock();

function resolveTeamRoot() {
  if (process.env.OBSIDIAN_TEAM_PATH) return expandHome(process.env.OBSIDIAN_TEAM_PATH);
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (vault) return join(dirname(expandHome(vault)), "Team", "Heartbeat");
  console.error("Set OBSIDIAN_TEAM_PATH (or OBSIDIAN_VAULT_PATH) in .env.");
  process.exit(1);
}
const TEAM_ROOT = resolveTeamRoot();

const FLAG_FORCE = process.argv.includes("--force");

function resolveTargetQuarter() {
  const arg = process.argv.find(a => a.startsWith("--quarter="))?.split("=")[1]
           || process.argv[process.argv.indexOf("--quarter") + 1];
  if (arg) {
    const m = arg.match(/^(\d{4})-Q([1-4])$/);
    if (!m) { console.error("--quarter must be YYYY-Q[1-4], e.g. 2026-Q2"); process.exit(1); }
    return { year: +m[1], q: +m[2] };
  }
  const now = new Date();
  return { year: now.getFullYear(), q: Math.ceil((now.getMonth() + 1) / 3) };
}

// ─── Reading weekly heartbeats ─────────────────────────────────────────────────

function readWeeklyHeartbeats(year, q) {
  const { start, end } = quarterBounds(year, q);
  const weeks = weeksInRange(start, end);
  const out = [];

  for (const { year: wYear, week } of weeks) {
    const weekStr = pad(week);
    const yearDir = join(TEAM_ROOT, String(wYear));
    if (!existsSync(yearDir)) continue;

    // Weekly heartbeats live directly in the year folder, named {year}-W{ww}-{suffix}.md.
    const file = readdirSync(yearDir).find(f => f.startsWith(`${wYear}-W${weekStr}-`) && f.endsWith(".md"));
    if (!file) continue;

    const content = readFileSync(join(yearDir, file), "utf8");
    const relPath = file; // same folder as the quarterly output → link by filename
    out.push({ year: wYear, week, weekStr, relPath, content });
  }
  return out;
}

// ─── Frontmatter parsing ────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
}

function parseIntField(fm, key) {
  const m = fm.match(new RegExp(`^${key}: (\\d+)`, "m"));
  return m ? parseInt(m[1], 10) : 0;
}

function parseLanguages(fm) {
  const langs = {};
  const blockM = fm.match(/^languages:\n((?:[ \t]+\S[^\n]*\n?)*)/m);
  if (blockM) {
    for (const line of blockM[1].split("\n")) {
      const m = line.match(/^\s+"?([^":]+)"?:\s*(\d+)/);
      if (m && parseInt(m[2], 10) > 0) langs[m[1].trim()] = parseInt(m[2], 10);
    }
  }
  return langs;
}

// Parse the nested domains: block into [{name, authored, lines}]
function parseDomains(fm) {
  const blockM = fm.match(/^domains:\n([\s\S]*?)(?=^\S|\Z)/m);
  if (!blockM) return [];
  const domains = [];
  let cur = null;
  for (const line of blockM[1].split("\n")) {
    const nameM = line.match(/^\s+-\s+name:\s*(.+?)\s*$/);
    if (nameM) {
      if (cur) domains.push(cur);
      cur = { name: nameM[1].trim(), authored: 0, lines: 0 };
      continue;
    }
    if (!cur) continue;
    const apc = line.match(/^\s+authored_pr_count:\s*(\d+)/);
    if (apc) cur.authored = parseInt(apc[1], 10);
    const ln = line.match(/^\s+lines:\s*(\d+)/);
    if (ln) cur.lines = parseInt(ln[1], 10);
  }
  if (cur) domains.push(cur);
  return domains;
}

// ─── Chart data ──────────────────────────────────────────────────────────────

function buildChartData(heartbeats) {
  const domainLines = {};   // domain → LOC
  const domainAuthored = {};// domain → PR count
  const langAcc  = {};
  const activity = [];
  for (const h of heartbeats) {
    const fm = parseFrontmatter(h.content);
    for (const d of parseDomains(fm)) {
      domainLines[d.name]    = (domainLines[d.name] || 0) + d.lines;
      domainAuthored[d.name] = (domainAuthored[d.name] || 0) + d.authored;
    }
    for (const [l, v] of Object.entries(parseLanguages(fm))) langAcc[l] = (langAcc[l] || 0) + v;
    activity.push({ week: h.weekStr, authored: parseIntField(fm, "authored_pr_count") });
  }
  return { domainLines, domainAuthored, langAcc, activity };
}

function buildChartSection({ domainLines, domainAuthored, langAcc, activity }) {
  const parts = [];

  if (activity.some(w => w.authored > 0)) {
    const labels   = activity.map(w => `"W${w.week}"`).join(", ");
    const authored = activity.map(w => w.authored).join(", ");
    parts.push([
      "### Activity Rhythm", "",
      "```mermaid", "xychart-beta",
      '  title "Team PRs Authored by Week"',
      `  x-axis [${labels}]`,
      `  bar [${authored}]`,
      "```",
    ].join("\n"));
  }

  const topLangs = Object.entries(langAcc).filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a).slice(0, 5);
  if (topLangs.length) {
    parts.push([
      "### Languages", "",
      "```mermaid", "xychart-beta",
      '  title "Language Mix (accumulated %)"',
      `  x-axis [${topLangs.map(([k]) => `"${k}"`).join(", ")}]`,
      `  bar [${topLangs.map(([, v]) => v).join(", ")}]`,
      "```",
    ].join("\n"));
  }

  // Prefer LOC for the distribution; fall back to PR counts if no LOC data.
  const useLines = Object.values(domainLines).some(v => v > 0);
  const dist = useLines ? domainLines : domainAuthored;
  const topDomains = Object.entries(dist).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a);
  if (topDomains.length) {
    parts.push([
      "### Domain Distribution", "",
      "```mermaid", "pie",
      `  title ${useLines ? "Lines of Code Changed by Domain" : "PRs Authored by Domain"}`,
      topDomains.map(([k, v]) => `  "${k}": ${v}`).join("\n"),
      "```",
    ].join("\n"));
  }

  if (!parts.length) return "";
  return `## Quarter at a Glance\n\n${parts.join("\n\n")}\n\n---`;
}

// ─── AI summarisation ──────────────────────────────────────────────────────────

function buildPrompt(year, q, heartbeats) {
  const { start, end } = quarterBounds(year, q);
  const weeklyContext = heartbeats.map(h =>
    `### Week ${h.weekStr} (ref: ${h.relPath})\n${h.content}`
  ).join("\n\n---\n\n");

  return `You are generating a quarterly engineering heartbeat for a software TEAM for Q${q} ${year} (${fmtDate(start)} – ${fmtDate(end)}).

Your source is a series of weekly team heartbeats, each already grouped into DOMAIN sections (## Domain Name).

Instructions:
- Write at the DOMAIN level. The subject of every sentence is the domain or the work — e.g. "The Map domain shipped…". Do NOT center individual engineers; they may appear only as light trailing attribution.
- Group the quarterly narrative by domain, using the SAME domain section headings that appear in the weeklies.
- Under each domain, group related work into descriptive thematic subheadings.
- Write 2–5 sentence bullets per feature/theme — more context and impact than the weekly bullets.
- Merge overlapping work across weeks into a single bullet.
- Include Obsidian-relative source links after each bullet using the format:
  → [Week NN](filename.md)
- Use the exact filenames from the ref: paths provided.${styleBlock}

Return the following, in this exact order, with no preamble and no code fences:

SUMMARY: One sentence capturing the quarter's team-wide theme and output for frontmatter.

OVERVIEW:
[Two to three paragraphs narrating the quarter's arc across the team — strategic focus, how the work evolved, what shipped.]

## [Domain Name]

### [Thematic Group]

- **Feature name** — What was accomplished and its impact.
  → [Week 04](2026-W04-Heartbeat.md)

## [Another Domain]

### [Theme]

- **Feature** — Description.
  → [Week 07](2026-W07-Heartbeat.md)

---

WEEKLY HEARTBEATS:
${weeklyContext}`;
}

function parseAIResponse(raw) {
  const summaryMatch = raw.match(/^SUMMARY:\s*(.+?)$/m);
  const summary = summaryMatch ? summaryMatch[1].trim().replace(/^"|"$/g, "") : "";
  const body = raw.replace(/^SUMMARY:.+$/m, "").replace(/^OVERVIEW:/m, "").trim();
  return { summary, body };
}

// ─── Markdown assembly ────────────────────────────────────────────────────────

function buildMarkdown(year, q, summary, body, charts) {
  const { start, end } = quarterBounds(year, q);
  const frontmatter = [
    "---",
    summary ? `summary: "${summary.replace(/"/g, '\\"')}"` : `summary: ""`,
    `quarter: Q${q}`,
    `year: ${year}`,
    `date_range: ${fmtDate(start)} – ${fmtDate(end)}`,
    `tags:\n  - heartbeat\n  - quarterly\n  - team`,
    "---",
  ].join("\n");

  const chartSection = buildChartSection(charts);
  const firstHeading = body.search(/^## /m);
  const intro = firstHeading !== -1 ? body.slice(0, firstHeading).trimEnd() : body;
  const rest  = firstHeading !== -1 ? body.slice(firstHeading) : "";

  return [
    frontmatter, "",
    `# Q${q} ${year} Team Heartbeat`,
    `${fmtDateShort(start)} – ${fmtDateShort(end)}`,
    "", "---", "",
    intro,
    ...(chartSection ? ["", chartSection] : []),
    ...(rest ? ["", rest] : []),
  ].join("\n").trimEnd() + "\n";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { year, q } = resolveTargetQuarter();
  console.log(`Target quarter: ${year}-Q${q}`);

  const outFile = join(TEAM_ROOT, String(year), `${year}-Q${q}-${SUMMARY_SUFFIX}.md`);
  if (existsSync(outFile) && !FLAG_FORCE) {
    console.log(`Summary already exists: ${outFile}\nUse --force to overwrite.`);
    process.exit(0);
  }

  console.log("Reading weekly heartbeats…");
  const heartbeats = readWeeklyHeartbeats(year, q);
  console.log(`  Found ${heartbeats.length} weekly heartbeats`);
  if (!heartbeats.length) {
    console.error("No weekly heartbeats found for this quarter. Run team-weekly.mjs first.");
    process.exit(1);
  }

  const charts = buildChartData(heartbeats);
  const prompt = buildPrompt(year, q, heartbeats);

  console.log("Calling AI…");
  const { summary, body } = parseAIResponse(await callAI(prompt, 8096));

  writeFileSync(outFile, buildMarkdown(year, q, summary, body, charts), "utf8");
  console.log(`\nWritten: ${outFile}`);
}

main().catch(err => { console.error(err); process.exit(1); });
