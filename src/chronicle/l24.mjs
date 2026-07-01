#!/usr/bin/env node
/**
 * l24.mjs — "Last 24 hours" personal daily digest.
 *
 * Summarizes the previous business day's AI conversations (Claude Code + VS Code
 * Copilot Chat), authored PRs, and checked TODOs into an "## L24" section of
 * today's journal note — at most 10 terse bullets. Calendar meetings are a
 * separate "### Meetings" sub-list, not counted toward the 10.
 *
 * Usage:
 *   node src/chronicle/l24.mjs                 # summarize prev business day → today's note
 *   node src/chronicle/l24.mjs --date 2026-07-02
 *   node src/chronicle/l24.mjs --print         # stdout, don't write
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { loadEnv, required, expandHome, loadAccounts } from "./lib/env.mjs";
import { pad, isoWeek, localDay, previousBusinessDay } from "./lib/dates.mjs";
import { callAI } from "./lib/ai.mjs";
import { getStyleBlock } from "./lib/style.mjs";
import { parseCheckedTodos } from "./lib/obsidian.mjs";
import * as githubConnector    from "./connectors/github.mjs";
import * as gheConnector       from "./connectors/ghe.mjs";
import * as bitbucketConnector from "./connectors/bitbucket.mjs";

const CONNECTORS = { github: githubConnector, ghe: gheConnector, bitbucket: bitbucketConnector };

loadEnv();
const JOURNAL_ROOT   = expandHome(required("OBSIDIAN_VAULT_PATH"));
const CLAUDE_DIR     = expandHome(process.env.CLAUDE_PROJECTS_DIR || "~/.claude/projects");
const VSCODE_STORAGE = expandHome(process.env.VSCODE_STORAGE_DIR || "~/Library/Application Support/Code/User/workspaceStorage");
const MAX_BULLETS    = parseInt(process.env.L24_MAX_BULLETS || "10", 10);

// The note to write into (default today). --date targets a specific day's note.
function resolveNoteDate() {
  const arg = process.argv.find(a => a.startsWith("--date="))?.split("=")[1]
           || (process.argv.includes("--date") ? process.argv[process.argv.indexOf("--date") + 1] : null);
  const s = arg || localDay(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { console.error("--date must be YYYY-MM-DD"); process.exit(1); }
  return s;
}
const FLAG_PRINT = process.argv.includes("--print");

// ─── AI conversations: Claude Code ─────────────────────────────────────────────

function walkFiles(dir, ext, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, ext, out);
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function stripText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(p => p?.type === "text" && p.text).map(p => p.text).join("\n");
  return "";
}

// A real human prompt, not a tool result / system reminder / slash-command noise.
function isHumanPrompt(text) {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("<") && /^<[a-z-]+/i.test(t)) return false;   // tags like <system-reminder>
  if (/^\[Request interrupted/.test(t)) return false;
  return true;
}

function gatherClaudeCode(dateStr) {
  const items = [];
  for (const file of walkFiles(CLAUDE_DIR, ".jsonl")) {
    const project = basename(dirname(file));
    let lines;
    try { lines = readFileSync(file, "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "user" || !o.timestamp) continue;
      if (localDay(new Date(o.timestamp)) !== dateStr) continue; // local day, not UTC
      const text = stripText(o.message?.content);
      if (!isHumanPrompt(text)) continue;
      items.push({ source: "claude-code", project, text: text.slice(0, 500) });
    }
  }
  return items;
}

// ─── AI conversations: VS Code Copilot Chat ────────────────────────────────────

function copilotWorkspaceLabel(sessionFile) {
  try {
    const wsDir = dirname(dirname(sessionFile));
    const meta = JSON.parse(readFileSync(join(wsDir, "workspace.json"), "utf8"));
    if (meta.folder) return basename(decodeURIComponent(String(meta.folder)));
  } catch { /* ignore */ }
  return "copilot";
}

// Copilot stores chats two ways: legacy `.json` (top-level requests[]) and newer
// `.jsonl` where line 0 is a full snapshot {kind:0, v:{ requests[] }} plus patch
// lines. Reading line 0 covers closed sessions — what a past-day run needs.
function copilotRequests(file) {
  try {
    if (file.endsWith(".jsonl")) {
      const first = readFileSync(file, "utf8").split("\n", 1)[0];
      const v = JSON.parse(first).v;
      return Array.isArray(v?.requests) ? v.requests : [];
    }
    const j = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(j.requests) ? j.requests : [];
  } catch { return []; }
}

function gatherCopilot(dateStr) {
  const items = [];
  const files = [...walkFiles(VSCODE_STORAGE, ".jsonl"), ...walkFiles(VSCODE_STORAGE, ".json")]
    .filter(f => f.includes("/chatSessions/"));
  for (const file of files) {
    const reqs = copilotRequests(file);
    if (!reqs.length) continue;
    const label = copilotWorkspaceLabel(file);
    for (const req of reqs) {
      const ts = req.timestamp; // per-request epoch ms; skip if absent rather than misattribute
      if (!ts || localDay(new Date(ts)) !== dateStr) continue;
      const text = req.message?.text ?? (req.message?.parts || []).map(p => p.text).join("");
      if (!isHumanPrompt(text)) continue;
      items.push({ source: "copilot", project: label, text: String(text).slice(0, 500) });
    }
  }
  return items;
}

// ─── PRs authored that day ─────────────────────────────────────────────────────

async function gatherPRs(dateStr) {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end   = new Date(`${dateStr}T23:59:59.999Z`);
  const prs = [];
  for (const account of loadAccounts({ requireToken: false })) {
    const connector = CONNECTORS[account.type];
    if (!connector?.fetchAccountPRs) continue;
    try {
      // Daily window: trust search, skip the slow repo-enumeration fallback and reviewed PRs.
      const { authored } = await connector.fetchAccountPRs(account, start, end, { noFallback: true, skipReviewed: true });
      for (const pr of authored) prs.push({ repo: pr._repoName, number: pr.number, title: pr.title, url: pr.html_url });
    } catch (e) {
      console.error(`  [PRs] ${account.accountDisplayName}: ${e.message}`);
    }
  }
  return prs;
}

// ─── Calendar meetings that day ────────────────────────────────────────────────

async function gatherMeetings(dateStr) {
  const url = process.env.CALENDAR_ICS_URL;
  if (!url) return [];
  const ical = (await import("node-ical")).default;
  let data;
  try { data = await ical.async.fromURL(url); }
  catch (e) { console.error(`  [calendar] fetch failed: ${e.message}`); return []; }

  const dayStart = new Date(`${dateStr}T00:00:00`);
  const dayEnd   = new Date(`${dateStr}T23:59:59`);
  const meetings = [];

  for (const ev of Object.values(data)) {
    if (ev.type !== "VEVENT") continue;
    const summary = (ev.summary || "").toString().trim() || "(no title)";
    const exdates = ev.exdate ? Object.values(ev.exdate).map(d => localDay(new Date(d))) : [];

    if (ev.rrule) {
      let occ = [];
      try { occ = ev.rrule.between(dayStart, dayEnd, true); } catch { occ = []; }
      for (const o of occ) {
        if (localDay(o) !== dateStr || exdates.includes(dateStr)) continue;
        meetings.push({ start: o, summary, allDay: ev.datetype === "date" });
      }
    } else if (ev.start && localDay(new Date(ev.start)) === dateStr) {
      meetings.push({ start: new Date(ev.start), summary, allDay: ev.datetype === "date" });
    }
  }
  const seen = new Set();
  return meetings
    .filter(m => { const k = `${m.start.getTime()}|${m.summary}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start - b.start);
}

// ─── AI synthesis ──────────────────────────────────────────────────────────────

async function synthesizeBullets(dateStr, convos, prs, todos) {
  if (!convos.length && !prs.length && !todos.length) return [];
  const convoText = convos.length ? convos.map(c => `- [${c.source}/${c.project}] ${c.text.replace(/\s+/g, " ")}`).join("\n") : "(none)";
  const prText = prs.length ? prs.map(p => `- ${p.repo}#${p.number}: ${p.title}`).join("\n") : "(none)";
  const todoText = todos.length ? todos.map(t => `- ${t}`).join("\n") : "(none)";

  const raw = await callAI(
    `Summarize what this engineer worked on and accomplished on ${dateStr}, as a prioritized list of AT MOST ${MAX_BULLETS} bullets.

Sources: prompts from their AI coding conversations, the PRs they authored, and the TODO items they checked off. All three are signal for the same work — merge a conversation, its resulting PR, and a related TODO into ONE bullet. Order by importance; drop trivia and noise.

Completed TODOs are the engineer's own words for finished work: treat them as first-class accomplishments. Reuse a TODO verbatim as its bullet when it stands alone; fold it into a related conversation/PR bullet when they overlap.

Exclude items that are merely meeting or standup attendance — meetings are recorded separately, so never emit a bullet about attending them.

Keep each bullet TERSE: one line, roughly 8 to 16 words, past tense, leading with the outcome. Cut trailing clauses ("after confirming…", "in order to…", "; then…") and background — one accomplishment per bullet. Do not name tools like "Copilot" or "Claude"; describe the work itself. No preamble.${getStyleBlock()}
Return only the bullets, one per line starting with "- ". At most ${MAX_BULLETS}.

AI CONVERSATION PROMPTS:
${convoText}

PRS AUTHORED:
${prText}

COMPLETED TODOS:
${todoText}`,
    1200);

  return raw.split("\n").map(l => l.trim()).filter(l => /^[-*]\s+\S/.test(l))
    .map(l => "- " + l.replace(/^[-*]\s+/, "")).slice(0, MAX_BULLETS);
}

// ─── Render + write ────────────────────────────────────────────────────────────

function renderSection(bullets, meetings) {
  const lines = ["## L24", ""];
  lines.push(bullets.length ? bullets.join("\n") : "- _No AI activity or PRs recorded for this day._");
  if (meetings.length) {
    lines.push("", "### Meetings", "");
    for (const m of meetings) {
      const time = m.allDay ? "All day" : m.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      lines.push(`- ${time} — ${m.summary}`);
    }
  }
  return lines.join("\n") + "\n";
}

// Replace an existing "## L24" section (up to the next H2 or `---`) or append it.
function upsertSection(content, section) {
  const lines = content.split("\n");
  const start = lines.findIndex(l => /^## L24\s*$/.test(l));
  if (start === -1) return content.replace(/\s*$/, "") + "\n\n" + section;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
  return [...lines.slice(0, start), section.replace(/\n$/, ""), "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

function dailyNotePath(dateStr) {
  const [y] = dateStr.split("-");
  const { week } = isoWeek(new Date(`${dateStr}T12:00:00Z`));
  const weekDir = join(JOURNAL_ROOT, y, pad(week));
  let file = null;
  if (existsSync(weekDir)) file = readdirSync(weekDir).find(f => f.startsWith(dateStr) && f.endsWith(".md"));
  if (!file) {
    const dayName = new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    file = `${dateStr}-${dayName}.md`;
  }
  return { weekDir, path: join(weekDir, file) };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // L24 = last 24h: summarize the previous business day, write into the note date's journal.
  const noteDate = resolveNoteDate();                                       // where it's written (default today)
  const dataDate = previousBusinessDay(new Date(`${noteDate}T12:00:00`));   // what it summarizes (yesterday / Friday)
  console.log(`L24: summarizing ${dataDate} → ${noteDate} journal note`);

  const dataNote = dailyNotePath(dataDate);
  const todos = parseCheckedTodos(existsSync(dataNote.path) ? readFileSync(dataNote.path, "utf8") : "");
  console.log(`  completed TODOs (${dataDate}): ${todos.length}`);

  const convos = [...gatherClaudeCode(dataDate), ...gatherCopilot(dataDate)];
  console.log(`  AI conversations: ${convos.length} prompts (${convos.filter(c => c.source === "claude-code").length} Claude Code, ${convos.filter(c => c.source === "copilot").length} Copilot)`);

  const prs = await gatherPRs(dataDate);
  console.log(`  PRs authored: ${prs.length}`);

  const meetings = await gatherMeetings(dataDate);
  console.log(`  meetings: ${meetings.length}`);

  console.log(`  synthesizing…`);
  const bullets = await synthesizeBullets(dataDate, convos, prs, todos);
  const section = renderSection(bullets, meetings);

  if (FLAG_PRINT) { console.log("\n" + section); return; }

  const out = dailyNotePath(noteDate);
  mkdirSync(out.weekDir, { recursive: true });
  const existing = existsSync(out.path) ? readFileSync(out.path, "utf8") : `# ${noteDate}\n`;
  writeFileSync(out.path, upsertSection(existing, section), "utf8");
  console.log(`  Written: ${out.path}`);
}

main().catch(err => { console.error(err); process.exit(1); });
