#!/usr/bin/env node
/**
 * summary-weekly.mjs
 * Generates a weekly statement-of-work from PRs across all configured
 * accounts and writes it to your Obsidian journal.
 *
 * Usage: node src/summarizer/summary-weekly.mjs [--week 2026-W18] [--latest]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import * as githubConnector    from "./connector-github.mjs";
import * as gheConnector       from "./connector-ghe.mjs";
import * as bitbucketConnector from "./connector-bitbucket.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONNECTORS = {
  github:    githubConnector,
  ghe:       gheConnector,
  bitbucket: bitbucketConnector,
};

// ─── Config ───────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) {
    console.error(`Missing .env file at ${envPath}\nCopy .env.example and fill it in.`);
    process.exit(1);
  }
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] ??= val;
  }
}

function loadAllAccounts() {
  const accountsPath = join(__dirname, "accounts.json");
  if (!existsSync(accountsPath)) {
    console.error(`Missing accounts.json at ${accountsPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(accountsPath, "utf8"));
  return raw.flatMap(a => {
    const token = process.env[a.tokenEnvVar];
    if (!token) {
      console.log(`Skipping ${a.accountDisplayName} (${a.type}) — ${a.tokenEnvVar} not set.`);
      return [];
    }
    return [{ ...a, token }];
  });
}

function required(key) {
  if (!process.env[key]) { console.error(`Missing required env var: ${key}`); process.exit(1); }
  return process.env[key];
}

function expandHome(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p);
}

loadEnv();

const JOURNAL_ROOT   = expandHome(required("OBSIDIAN_VAULT_PATH"));
const SUMMARY_PREFIX = process.env.SUMMARY_FILENAME_PREFIX || "Summary";
const AI_PROVIDER    = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY     = process.env.OPENAI_API_KEY;
const OPENAI_BASE    = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const AI_MODEL       = process.env.AI_MODEL;

// ─── Date helpers ─────────────────────────────────────────────────────────────

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function weekBounds(year, week) {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() + 1 - dow);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

function pad(n) { return String(n).padStart(2, "0"); }
function fmtDate(d) { return d.toISOString().slice(0, 10); }
function fmtDateShort(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

const FLAG_LATEST  = process.argv.includes("--latest");
const FLAG_REBUILD = process.argv.includes("--rebuild");

function resolveTargetWeek() {
  const arg = process.argv.find(a => a.startsWith("--week="))?.split("=")[1]
           || process.argv[process.argv.indexOf("--week") + 1];
  if (arg) {
    const m = arg.match(/^(\d{4})-W(\d{1,2})$/);
    if (!m) { console.error("--week must be YYYY-WNN, e.g. 2026-W18"); process.exit(1); }
    return { year: +m[1], week: +m[2] };
  }
  const now = new Date();
  now.setDate(now.getDate() - 7);
  return isoWeek(now);
}

// ─── Obsidian folder walking ───────────────────────────────────────────────────

// Find every week folder that already has a summary (for --rebuild mode).
function findSummarisedWeeks() {
  const result = [];
  for (const yearDir of readdirSync(JOURNAL_ROOT)) {
    if (!/^\d{4}$/.test(yearDir)) continue;
    const yearPath = join(JOURNAL_ROOT, yearDir);
    for (const weekDir of readdirSync(yearPath)) {
      if (!/^\d{2}$/.test(weekDir)) continue;
      const weekPath = join(yearPath, weekDir);
      const files = readdirSync(weekPath);
      if (files.some(f => f.includes(SUMMARY_PREFIX))) {
        result.push({ year: +yearDir, week: +weekDir, weekDir: weekPath });
      }
    }
  }
  return result.sort((a, b) => a.year - b.year || a.week - b.week);
}

function findUnsummarisedWeeks(targetYear, targetWeek) {
  const MAX_LOOKBACK = 200;
  let { year, week } = { year: targetYear, week: targetWeek };
  const unsummarised = [];

  for (let i = 0; i < MAX_LOOKBACK; i++) {
    const weekStr = pad(week);
    const weekDir = join(JOURNAL_ROOT, String(year), weekStr);

    if (existsSync(weekDir)) {
      const files = readdirSync(weekDir);
      const hasSummary = files.some(f => f.includes(SUMMARY_PREFIX));
      if (hasSummary) {
        console.log(`Found existing summary at ${year}-W${weekStr}, stopping lookback.`);
        break;
      }
      unsummarised.push({ year, week, weekDir });
    }

    week--;
    if (week === 0) { year--; week = 52; }
  }

  if (unsummarised.length === 0) {
    console.log("All weeks are already summarised.");
    process.exit(0);
  }

  // index 0 = most recent, last = oldest
  return unsummarised;
}

// ─── AI summarisation ─────────────────────────────────────────────────────────

function buildPrompt(prs, account) {
  const prText = prs.map(pr => [
    `### ${pr._repoName}#${pr.number}: ${pr.title}`,
    `URL: ${pr.html_url}`,
    `State: ${pr.state}`,
    pr.body ? `Description:\n${pr.body.slice(0, 1000)}` : "",
  ].filter(Boolean).join("\n")).join("\n\n---\n\n");

  return `You are generating a weekly statement of work for a software engineer.

You will produce two things:

1. A one or two sentence CONTEXTUAL SUMMARY of the week's overall themes and focus areas.
   This goes in frontmatter as: summary: "..."

2. A PR list in this exact format for each PR:

#### repo#number
[PR title](url)
- **Feature name** — 1–4 sentences describing what was done and why it matters.
- **Another feature** — Description.

Rules:
- Use only the short repo name (e.g. "web-shared-services", not "PreCise/web-shared-services")
- Features should be meaningful work a client or manager cares about
- Skip pure chores, dependency bumps, or formatting-only PRs — output the heading and link but no bullets
- Be specific and technical but readable

Return ONLY the following, no preamble, no code fences:

SUMMARY: one or two sentence summary here

PR_LIST:
#### repo#number
[PR title](url)
- **Feature** — Description.

PRs:
${prText}`;
}

async function callAI(prompt, maxTokens = 2048) {
  if (AI_PROVIDER === "openai") {
    if (!OPENAI_KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: OPENAI_KEY, baseURL: OPENAI_BASE });
    const model = AI_MODEL || "gpt-4o";
    console.log(`  AI: OpenAI (${model})`);
    const resp = await client.chat.completions.create({
      model, max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return resp.choices[0].message.content.trim();
  } else {
    if (!ANTHROPIC_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const model = AI_MODEL || "claude-sonnet-4-6";
    console.log(`  AI: Anthropic (${model})`);
    const msg = await client.messages.create({
      model, max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content[0].text.trim();
  }
}

function parseAIResponse(raw) {
  const summaryMatch = raw.match(/^SUMMARY:\s*(.+?)(?=\n\nPR_LIST:|\nPR_LIST:)/s);
  const prListMatch  = raw.match(/PR_LIST:\s*([\s\S]+)$/);
  const summary  = summaryMatch ? summaryMatch[1].trim().replace(/^"|"$/g, "") : "";
  const prList   = prListMatch  ? prListMatch[1].trim() : raw.trim();
  return { summary, prList };
}

async function summariseAccount(account, prs) {
  if (!prs.length) return { summary: "", prList: "_No PRs authored this week._" };
  const raw = await callAI(buildPrompt(prs, account));
  return parseAIResponse(raw);
}

// ─── Markdown assembly ────────────────────────────────────────────────────────

function buildMarkdown(year, week, accountResults, languages = {}, repoLines = {}) {
  const { start, end } = weekBounds(year, week);

  const authoredCount = accountResults.reduce((n, r) => n + r.authored.length, 0);
  const reviewedCount = accountResults.reduce((n, r) => n + r.reviewed.length, 0);

  const summaryLines = accountResults
    .filter(r => r.aiSummary)
    .map(r => `  - "${r.account.accountDisplayName}: ${r.aiSummary.replace(/"/g, '\\"')}"`);

  const repoLineEntries = Object.entries(repoLines).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a);
  const reposYaml = repoLineEntries.length
    ? `repos:\n${repoLineEntries.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`
    : null;
  const langEntries = Object.entries(languages).filter(([, v]) => v > 0);
  const langsYaml = langEntries.length
    ? `languages:\n${langEntries.map(([k, v]) => {
        // Quote keys that contain YAML-special characters or spaces
        const key = /[\s:#\[\]{}&*!|>'"@`]/.test(k) ? `"${k}"` : k;
        return `  ${key}: ${v}`;
      }).join('\n')}`
    : null; // omit field entirely when empty

  const frontmatter = [
    "---",
    summaryLines.length
      ? `summary:\n${summaryLines.join("\n")}`
      : `summary: []`,
    `week: ${week}`,
    `year: ${year}`,
    `date_range: ${fmtDate(start)} \u2013 ${fmtDate(end)}`,
    `authored_pr_count: ${authoredCount}`,
    `reviewed_pr_count: ${reviewedCount}`,
    reposYaml,
    langsYaml,
    `tags:\n  - summary\n  - weekly`,
    "---",
  ].filter(line => line !== null).join("\n");

  const sections = accountResults.map(({ account, reviewed, prList }) => {
    const reviewedLinks = reviewed.length
      ? reviewed.map(pr => `- [${pr._repoName}#${pr.number} — ${pr.title}](${pr.html_url})`).join("\n")
      : "_None this week._";

    return `## ${account.accountDisplayName}

### PRs Authored

${prList}

### PRs Reviewed

${reviewedLinks}`;
  });

  return `${frontmatter}

# ${year}—Week ${pad(week)} Summary
${fmtDateShort(start)} – ${fmtDateShort(end)}

---

${sections.join("\n\n---\n\n")}
`.trimEnd() + "\n";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const accounts = loadAllAccounts();

  let toProcess;

  if (FLAG_REBUILD) {
    toProcess = findSummarisedWeeks();
    const weekArg = process.argv.find(a => a.startsWith("--week="))?.split("=")[1]
               || (process.argv.includes("--week") && process.argv[process.argv.indexOf("--week") + 1]);
    if (weekArg) {
      const m = weekArg.match(/^(\d{4})-W(\d{1,2})$/);
      if (m) toProcess = toProcess.filter(w => w.year === +m[1] && w.week === +m[2]);
    }
    console.log(`Rebuild mode: ${toProcess.length} existing week(s) to reprocess.`);
  } else {
    const { year, week } = resolveTargetWeek();
    console.log(`Target week: ${year}-W${pad(week)}`);
    const allUnsummarised = findUnsummarisedWeeks(year, week);
    toProcess = FLAG_LATEST
      ? [allUnsummarised[0]]
      : [...allUnsummarised].reverse();
    if (FLAG_LATEST) {
      console.log(`Most recent unsummarised week: ${toProcess[0].year}-W${pad(toProcess[0].week)}`);
      if (allUnsummarised.length > 1) {
        console.log(`(${allUnsummarised.length - 1} older unsummarised week(s) — run without --latest to backfill)`);
      }
    } else {
      console.log(`Processing ${toProcess.length} unsummarised week(s), oldest first.`);
    }
  }

  for (const { year: foundYear, week: foundWeek, weekDir } of toProcess) {
    const { start, end } = weekBounds(foundYear, foundWeek);
    console.log(`\nProcessing: ${foundYear}-W${pad(foundWeek)} (${fmtDate(start)} → ${fmtDate(end)})`);

    const accountResults = [];
    for (const account of accounts) {
      const connector = CONNECTORS[account.type];
      if (!connector) {
        console.warn(`  [${account.accountDisplayName}] unknown type "${account.type}" — skipping.`);
        continue;
      }

      let authored, reviewed;
      try {
        ({ authored, reviewed } = await connector.fetchAccountPRs(account, start, end));
      } catch (e) {
        console.error(`  [${account.accountDisplayName}] fetch failed: ${e.message}`);
        process.exit(1);
      }

      if (authored.length === 0 && reviewed.length === 0) {
        console.log(`  No activity for ${account.accountDisplayName}, skipping.`);
        continue;
      }

      console.log(`  Summarising ${account.accountDisplayName}…`);
      const { summary: aiSummary, prList } = await summariseAccount(account, authored);
      accountResults.push({ account, authored, reviewed, aiSummary, prList });
    }

    if (accountResults.length === 0) {
      console.log(`  No PRs found for ${foundYear}-W${pad(foundWeek)} — skipping.`);
      continue;
    }

    // Fetch language data from PR file changes
    console.log(`  Fetching language data\u2026`);
    const langChanges = {};
    const repoChanges = {};
    for (const result of accountResults) {
      const connector = CONNECTORS[result.account.type];
      if (!connector.fetchPRLanguages || !result.authored.length) continue;
      try {
        const { langChanges: lc, repoChanges: rc } = await connector.fetchPRLanguages(result.account, result.authored);
        for (const [lang, n] of Object.entries(lc)) langChanges[lang] = (langChanges[lang] || 0) + n;
        for (const [repo, n] of Object.entries(rc)) repoChanges[repo] = (repoChanges[repo] || 0) + n;
      } catch (e) {
        console.warn(`  Language fetch failed for ${result.account.accountDisplayName}: ${e.message}`);
      }
    }
    const totalChanges = Object.values(langChanges).reduce((a, b) => a + b, 0);
    if (!totalChanges) console.log(`  Language data unavailable (token may lack repo-read scope).`);
    const languages = totalChanges ? Object.fromEntries(
      Object.entries(langChanges)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([lang, n]) => [lang, Math.round(n / totalChanges * 100)])
    ) : {};

    const markdown = buildMarkdown(foundYear, foundWeek, accountResults, languages, repoChanges);
    const filename = `${foundYear}-W${pad(foundWeek)}-${SUMMARY_PREFIX}.md`;
    const outPath  = join(weekDir, filename);

    writeFileSync(outPath, markdown, "utf8");
    console.log(`  Written: ${outPath}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
