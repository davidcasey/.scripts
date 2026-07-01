#!/usr/bin/env node
/**
 * quarterly.mjs
 * Reads weekly summary .md files + daily journal ## TODO checked items
 * for a quarter, combines them with AI, and writes a quarterly summary
 * to the year folder.
 *
 * Usage: node src/chronicle/quarterly.mjs [--quarter 2026-Q1]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { loadEnv, required, expandHome, PROJECT_ROOT } from "./lib/env.mjs";
import { pad, fmtDate, fmtDateShort, quarterBounds, isoWeek, weeksInRange } from "./lib/dates.mjs";
import { callAI } from "./lib/ai.mjs";
import { parseCheckedTodos } from "./lib/obsidian.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

// All accounts (no token filter) with host/isGHE — used only to list account names in the prompt.
function loadAccounts() {
  const accountsPath = join(PROJECT_ROOT, "accounts.json");
  if (!existsSync(accountsPath)) {
    console.error(`Missing accounts.json at ${accountsPath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(accountsPath, "utf8")).map(a => {
    const host  = (a.host || "https://github.com").replace(/\/$/, "");
    const isGHE = host !== "https://github.com";
    return { ...a, host, isGHE };
  });
}

loadEnv();

const JOURNAL_ROOT   = expandHome(required("OBSIDIAN_VAULT_PATH"));
const SUMMARY_PREFIX = process.env.SUMMARY_FILENAME_PREFIX || "Summary";

const FLAG_FORCE = process.argv.includes("--force");

// ─── CLI args ─────────────────────────────────────────────────────────────────

function resolveTargetQuarter() {
  const arg = process.argv.find(a => a.startsWith("--quarter="))?.split("=")[1]
           || process.argv[process.argv.indexOf("--quarter") + 1];
  if (arg) {
    const m = arg.match(/^(\d{4})-Q([1-4])$/);
    if (!m) { console.error("--quarter must be YYYY-Q[1-4], e.g. 2026-Q1"); process.exit(1); }
    return { year: +m[1], q: +m[2] };
  }
  const now = new Date();
  return { year: now.getFullYear(), q: Math.ceil((now.getMonth() + 1) / 3) };
}

// ─── Reading weekly summaries ──────────────────────────────────────────────────

function readWeeklySummaries(year, q) {
  const { start, end } = quarterBounds(year, q);
  const weeks = weeksInRange(start, end);
  const summaries = [];

  for (const { year: wYear, week } of weeks) {
    const weekStr = pad(week);
    const weekDir = join(JOURNAL_ROOT, String(wYear), weekStr);
    if (!existsSync(weekDir)) continue;

    const files = readdirSync(weekDir);
    const summaryFile = files.find(f => f.includes(SUMMARY_PREFIX) && f.endsWith(".md"));
    if (!summaryFile) continue;

    const content = readFileSync(join(weekDir, summaryFile), "utf8");
    // Relative path from the year folder for Obsidian links
    const relPath = `${weekStr}/${summaryFile}`;
    summaries.push({ year: wYear, week, weekStr, relPath, content });
  }

  return summaries;
}

// ─── Reading daily TODOs ───────────────────────────────────────────────────────

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

function readDailyTodos(year, q) {
  const { start, end } = quarterBounds(year, q);
  const results = [];
  const yearDir = join(JOURNAL_ROOT, String(year));
  if (!existsSync(yearDir)) return results;

  for (const weekFolder of readdirSync(yearDir).sort()) {
    if (!/^\d{2}$/.test(weekFolder)) continue;
    const weekDir = join(yearDir, weekFolder);

    for (const file of readdirSync(weekDir).sort()) {
      if (!DAY_FILE_RE.test(file)) continue;
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const fileDate = new Date(dateMatch[1] + "T00:00:00Z");
      if (fileDate < start || fileDate > end) continue;

      const todos = parseCheckedTodos(readFileSync(join(weekDir, file), "utf8"));
      if (!todos.length) continue;

      const dayName = file.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(".md", "");
      results.push({
        date: dateMatch[1],
        dayName,
        weekStr: weekFolder,
        relPath: `${weekFolder}/${file}`,
        todos,
      });
    }
  }
  return results;
}

// ─── Chart data ──────────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
}

function parseIntField(fm, key) {
  const m = fm.match(new RegExp(`^${key}: (\\d+)`, "m"));
  return m ? parseInt(m[1], 10) : 0;
}

function parseRepos(fm) {
  const m = fm.match(/^repos: \[([^\]]*)\]/m);
  return m && m[1].trim() ? m[1].split(",").map(r => r.trim()).filter(Boolean) : [];
}

function parseRepoLines(fm) {
  const lines = {};
  const blockM = fm.match(/^repos:\n((?:[ \t]+\S[^\n]*\n?)*)/m);
  if (blockM) {
    for (const line of blockM[1].split("\n")) {
      const m = line.match(/^\s+(\S+):\s*(\d+)/);
      if (m) lines[m[1]] = parseInt(m[2], 10);
    }
  }
  return lines;
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

function buildChartData(summaries) {
  const repoLines  = {};
  const langAcc    = {};
  const activity   = [];
  for (const s of summaries) {
    const fm = parseFrontmatter(s.content);
    // Per-repo lines of code (from repo_lines: field when available)
    const rl = parseRepoLines(fm);
    if (Object.keys(rl).length) {
      for (const [r, v] of Object.entries(rl)) repoLines[r] = (repoLines[r] || 0) + v;
    } else {
      // Fall back to frequency count for weeks predating repo_lines tracking
      for (const r of parseRepos(fm)) repoLines[r] = (repoLines[r] || 0) + 1;
    }
    const langs = parseLanguages(fm);
    for (const [l, v] of Object.entries(langs)) langAcc[l] = (langAcc[l] || 0) + v;
    activity.push({
      week: s.weekStr,
      authored: parseIntField(fm, "authored_pr_count"),
      reviewed: parseIntField(fm, "reviewed_pr_count"),
    });
  }
  return { repoLines, langAcc, activity };
}

function buildChartSection({ repoLines, langAcc, activity }) {
  const parts = [];

  if (activity.some(w => w.authored > 0 || w.reviewed > 0)) {
    const labels   = activity.map(w => `"W${w.week}"`).join(", ");
    const authored = activity.map(w => w.authored).join(", ");
    parts.push([
      "### Activity Rhythm",
      "",
      "```mermaid",
      "xychart-beta",
      '  title "PRs Authored by Week"',
      `  x-axis [${labels}]`,
      `  bar [${authored}]`,
      "```",
    ].join("\n"));
  }

  const topLangs = Object.entries(langAcc)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (topLangs.length) {
    const labels = topLangs.map(([k]) => `"${k}"`).join(", ");
    const values = topLangs.map(([, v]) => v).join(", ");
    parts.push([
      "### Languages",
      "",
      "```mermaid",
      "xychart-beta",
      '  title "Language Mix (accumulated %)"',
      `  x-axis [${labels}]`,
      `  bar [${values}]`,
      "```",
    ].join("\n"));
  }

  const topRepos = Object.entries(repoLines)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 12);
  if (topRepos.length) {
    const pieLines = topRepos.map(([k, v]) => `  "${k}": ${v}`).join("\n");
    parts.push([
      "### Repo Distribution",
      "",
      "```mermaid",
      "pie",
      "  title Lines of Code Changed",
      pieLines,
      "```",
    ].join("\n"));
  }

  if (!parts.length) return "";
  return `## Quarter at a Glance\n\n${parts.join("\n\n")}\n\n---`;
}

// ─── AI summarisation ──────────────────────────────────────────────────────────

function buildPrompt(year, q, accounts, summaries, dailyTodos) {
  const { start, end } = quarterBounds(year, q);

  const accountList = [...new Map(accounts.map(a => [a.accountDisplayName, a])).values()]
    .map(a => `- ${a.accountDisplayName}`)
    .join("\n");

  const weeklyContext = summaries.map(s => {
    // Strip the "### PRs Reviewed" block from each weekly file before sending to AI
    const content = s.content.replace(/^### PRs Reviewed\n[\s\S]*?(?=^###|^##|\Z)/gm, "");
    return `### Week ${s.weekStr} (ref: ${s.relPath})\n${content}`;
  }).join("\n\n---\n\n");

  const todoContext = dailyTodos.length
    ? dailyTodos.map(d =>
        `${d.date} ${d.dayName} (ref: ${d.relPath}):\n${d.todos.map(t => `  - ${t}`).join("\n")}`
      ).join("\n\n")
    : "No checked TODOs found this quarter.";

  return `You are generating a quarterly statement of work for a software engineer for Q${q} ${year} (${fmtDate(start)} – ${fmtDate(end)}).

You have two sources:
1. Weekly PR summaries — grouped by account section
2. Daily checked TODO items — thematic non-PR work

Instructions:
- TODOs are almost always work for the primary GHE account unless clearly otherwise
- Merge overlapping work (a TODO about "dark mode" + a PR for it = one bullet, not two)
- Write 2–5 sentence bullets per feature/theme — more context and impact than the weekly summaries
- Group related bullets under descriptive thematic subheadings within each account section
- Detect recurring meetings (items appearing most weeks: standups, 1:1s, planning) and list them in a ## Recurring Meetings section at the end
- Include Obsidian-relative source links after each bullet using the format:
  → [Week NN](../NN/filename.md) or [Week NN, DayName](../NN/filename.md)
- Use exact filenames from the ref: paths provided

Accounts covered this quarter:
${accountList}

Return the following, in this exact order, with no preamble and no code fences:

SUMMARY: One sentence capturing the quarter’s overall theme and output for frontmatter.

OVERVIEW:
[Two to three paragraphs narrating the quarter’s arc — what was the strategic focus, how did the work evolve, what shipped.]

## [Account Name]

### [Thematic Group]

- **Feature name** — What was accomplished and its impact.
  → [Week 04](../04/2026-W04-Summary.md)

- **Another feature** — Description.
  → [Week 06](../06/2026-W06-Summary.md)

### [Another Theme]

- **Feature** — Description.
  → [Week 07](../07/2026-W07-Summary.md)

## Recurring Meetings

- Weekly standup
- 1:1 with manager

---

WEEKLY SUMMARIES:
${weeklyContext}

---

DAILY TODO ITEMS:
${todoContext}`;
}

function parseAIResponse(raw) {
  const summaryMatch = raw.match(/^SUMMARY:\s*(.+?)$/m);
  const summary = summaryMatch ? summaryMatch[1].trim().replace(/^"|"$/g, "") : "";
  const body = raw
    .replace(/^SUMMARY:.+$/m, "")
    .replace(/^OVERVIEW:/m, "")
    .trim();
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
    `tags:\n  - summary\n  - quarterly`,
    "---",
  ].join("\n");

  const chartSection = buildChartSection(charts);

  // Split body at the first ## heading so charts land after the intro paragraphs
  const firstHeading = body.search(/^## /m);
  const intro  = firstHeading !== -1 ? body.slice(0, firstHeading).trimEnd() : body;
  const rest   = firstHeading !== -1 ? body.slice(firstHeading) : "";

  return [
    frontmatter,
    "",
    `# Q${q} ${year} Summary`,
    `${fmtDateShort(start)} – ${fmtDateShort(end)}`,
    "",
    "---",
    "",
    intro,
    ...(chartSection ? ["", chartSection] : []),
    ...(rest ? ["", rest] : []),
  ].join("\n").trimEnd() + "\n";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { year, q } = resolveTargetQuarter();
  console.log(`Target quarter: ${year}-Q${q}`);

  const outFile = join(JOURNAL_ROOT, String(year), `${year}-Q${q}-Summary.md`);
  if (existsSync(outFile) && !FLAG_FORCE) {
    console.log(`Summary already exists: ${outFile}`);
    console.log("Use --force to overwrite.");
    process.exit(0);
  }

  console.log("Reading weekly summaries…");
  const summaries = readWeeklySummaries(year, q);
  console.log(`  Found ${summaries.length} weekly summaries`);

  if (!summaries.length) {
    console.error("No weekly summaries found for this quarter. Run weekly.mjs first.");
    process.exit(1);
  }

  console.log("Reading daily TODOs…");
  const dailyTodos = readDailyTodos(year, q);
  const todoCount = dailyTodos.reduce((n, d) => n + d.todos.length, 0);
  console.log(`  Found ${todoCount} checked TODO items across ${dailyTodos.length} days`);

  const accounts = loadAccounts();
  const charts   = buildChartData(summaries);
  const prompt   = buildPrompt(year, q, accounts, summaries, dailyTodos);

  console.log("Calling AI…");
  const aiOutput = await callAI(prompt, 8096);
  const { summary, body } = parseAIResponse(aiOutput);

  writeFileSync(outFile, buildMarkdown(year, q, summary, body, charts), "utf8");
  console.log(`\nWritten: ${outFile}`);
}

main().catch(err => { console.error(err); process.exit(1); });
