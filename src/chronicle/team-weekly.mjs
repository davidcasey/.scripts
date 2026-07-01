#!/usr/bin/env node
/**
 * team-weekly.mjs
 * Generates a weekly team "heartbeat" — all authored PRs for a roster of
 * engineers from a single GHE org, grouped by DOMAIN (not by person) and
 * narrated at the domain level. Writes one digest to a separate Obsidian area.
 *
 * Domain is a property of the PR, not the repo (one repo → many domains, one
 * domain → many repos), so each PR is AI-classified (by title, body, changed
 * files) into a fixed taxonomy of domain names defined in team.json. Host/org/
 * token are reused from the GHE account in accounts.json (single shared token).
 *
 * Usage:
 *   node src/chronicle/team-weekly.mjs                # last completed week
 *   node src/chronicle/team-weekly.mjs --week 2026-W27
 *   node src/chronicle/team-weekly.mjs --weeks 4      # backfill 4 recent weeks
 *   node src/chronicle/team-weekly.mjs --rebuild      # overwrite existing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadEnv, required, expandHome, PROJECT_ROOT } from "./lib/env.mjs";
import { pad, fmtDate, fmtDateShort, isoWeek, weekBounds } from "./lib/dates.mjs";
import { callAI } from "./lib/ai.mjs";
import { getStyleBlock } from "./lib/style.mjs";
import * as gheConnector from "./connectors/ghe.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

// Reuse the GHE account (host/org/token) from accounts.json for the shared read token.
function loadTeamAccount() {
  const accountsPath = join(PROJECT_ROOT, "accounts.json");
  if (!existsSync(accountsPath)) {
    console.error(`Missing accounts.json at ${accountsPath}`);
    process.exit(1);
  }
  const accounts = JSON.parse(readFileSync(accountsPath, "utf8"));
  const ghe = accounts.find(a => a.type === "ghe");
  if (!ghe) {
    console.error(`No account with "type": "ghe" found in accounts.json — needed for the team roster fetch.`);
    process.exit(1);
  }
  const token = process.env[ghe.tokenEnvVar];
  if (!token) {
    console.error(`Token env var ${ghe.tokenEnvVar} (for ${ghe.accountDisplayName}) is not set in .env.`);
    process.exit(1);
  }
  return { host: ghe.host, org: ghe.org, token, displayName: ghe.accountDisplayName };
}

// team.json is a list of engineer usernames — either a bare array, or an object
// { "engineers": [...] } with an optional "domains" grouping override. The
// roster seeds the fetch; display names are resolved from the GHE API. Repos
// default to one-domain-each (prettified) unless a domains override groups them.
function loadTeam() {
  const teamPath = join(PROJECT_ROOT, "team.json");
  if (!existsSync(teamPath)) {
    console.error(`Missing team.json at ${teamPath}\nCopy team.example.json and fill it in.`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(teamPath, "utf8"));
  const engineers = raw.engineers;
  const domains   = (raw.domains || []).map(d =>
    typeof d === "string" ? { name: d, hint: "" } : { name: d.name, hint: d.hint || "" });
  if (!Array.isArray(engineers) || !engineers.length) {
    console.error(`team.json needs a non-empty "engineers" list of GHE usernames.`);
    process.exit(1);
  }
  if (!domains.length || domains.some(d => !d.name)) {
    console.error(`team.json needs a non-empty "domains" taxonomy — a list of { "name", "hint" } (hint optional). Each PR is classified into one of these names.`);
    process.exit(1);
  }
  return { engineers, domains };
}

loadEnv();

const SUMMARY_SUFFIX = process.env.TEAM_SUMMARY_FILENAME_SUFFIX || "Heartbeat";

// Team output root. Defaults to a sibling "Team/Heartbeat" of the personal vault.
function resolveTeamRoot() {
  if (process.env.OBSIDIAN_TEAM_PATH) return expandHome(process.env.OBSIDIAN_TEAM_PATH);
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (vault) return join(dirname(expandHome(vault)), "Team", "Heartbeat");
  console.error("Set OBSIDIAN_TEAM_PATH (or OBSIDIAN_VAULT_PATH) in .env.");
  process.exit(1);
}
const TEAM_ROOT = resolveTeamRoot();

// House writing-style block (from the repo guide) injected into AI prompts.
const styleBlock = getStyleBlock();
const SUGGEST_DOMAINS = (process.env.TEAM_SUGGEST_DOMAINS || "true").toLowerCase() !== "false";

const UNCATEGORIZED = "Uncategorized";
const prKey = pr => `${pr._repoName}#${pr.number}`;

// Marker appended to a PR link when it is not merged.
const STATUS_MARK = {
  merged: "",
  open:   " _(open)_",
  draft:  " _(draft)_",
  closed: " _(closed, unmerged)_",
};

// ─── CLI args ─────────────────────────────────────────────────────────────────

const FLAG_REBUILD = process.argv.includes("--rebuild");

function getArg(name) {
  return process.argv.find(a => a.startsWith(`${name}=`))?.split("=")[1]
      || (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
}

function resolveTargetWeeks() {
  const weekArg = getArg("--week");
  if (weekArg) {
    const m = weekArg.match(/^(\d{4})-W(\d{1,2})$/);
    if (!m) { console.error("--week must be YYYY-WNN, e.g. 2026-W27"); process.exit(1); }
    return [{ year: +m[1], week: +m[2] }];
  }
  const n = Math.max(1, parseInt(getArg("--weeks") || "1", 10));
  const now = new Date();
  now.setDate(now.getDate() - 7); // last completed week
  let { year, week } = isoWeek(now);
  const weeks = [];
  for (let i = 0; i < n; i++) {
    weeks.push({ year, week });
    week--;
    if (week === 0) { year--; week = 52; }
  }
  return weeks;
}

// ─── Digest generation (staged: classify → narrate per domain → synthesize) ──
//
// Real weeks run to dozens of PRs, which overflow a single call's output budget
// and small local context windows. So the work is staged into small, bounded
// calls: (1) classify PRs in batches (short output), (2) narrate each domain's
// PRs in batches, (3) synthesize one team-wide summary line. TEAM_BATCH_SIZE
// caps PRs per call so prompts stay within modest local model contexts.

const BATCH_SIZE = Math.max(1, parseInt(process.env.TEAM_BATCH_SIZE || "15", 10));

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── Stage 1: classification ──
function buildClassifyPrompt(domains, prs, fileData) {
  const taxonomy = domains.map(d => `- ${d.name}${d.hint ? ` — ${d.hint}` : ""}`).join("\n");
  const prText = prs.map(pr => {
    const files = fileData.perPR?.[prKey(pr)]?.files || [];
    return [
      `${prKey(pr)}: ${pr.title}`,
      files.length ? `  files: ${files.slice(0, 20).join(", ")}` : "",
      pr.body ? `  desc: ${pr.body.replace(/\s+/g, " ").slice(0, 300)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return `Classify each pull request into EXACTLY ONE engineering domain.

Domain is a property of the WORK, not the repository — one repo can contain PRs from several domains, and one domain spans many repos. Judge by:
- The repository name (the part before "#") — it OFTEN appears verbatim in a domain's description below; if it does, that domain is very likely correct.
- The changed file paths (strong signal — e.g. .github/workflows/*, *.tf, ci/* → infrastructure; *.tsx/*.scss → UI).
- The title and description.
Use ${UNCATEGORIZED} sparingly — only when no domain description mentions the repo and the work clearly fits none.

Domains:
${taxonomy}
- ${UNCATEGORIZED} — only if a PR genuinely fits none of the above.

Return ONE line per PR, nothing else, no preamble, exactly:
repo#number => Domain Name

PRs:
${prText}`;
}

function parseClassification(raw, domains, prs) {
  const valid = new Map(domains.map(d => [d.name.toLowerCase(), d.name]));
  const assign = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\S+#\d+)\s*=>\s*(.+?)\s*$/);
    if (m) assign[m[1]] = valid.get(m[2].trim().toLowerCase()) || UNCATEGORIZED;
  }
  for (const pr of prs) assign[prKey(pr)] ??= UNCATEGORIZED; // model skipped it
  return assign;
}

async function classifyAll(domains, prs, fileData) {
  const batches = chunk(prs, BATCH_SIZE);
  const assign = {};
  let i = 0;
  for (const batch of batches) {
    console.log(`    classify batch ${++i}/${batches.length} (${batch.length} PRs)…`);
    const raw = await callAI(buildClassifyPrompt(domains, batch, fileData), Math.max(256, batch.length * 24));
    Object.assign(assign, parseClassification(raw, domains, batch));
  }
  return assign;
}

// ── Stage 2: per-domain summary ──
// One short domain-level paragraph. The PR list itself is a plain list of links
// rendered deterministically in code (renderPrList) — no per-PR prose.
function buildDomainPrompt(domainName, prs) {
  const prText = prs.map(pr =>
    `- ${pr.title}${pr.body ? `: ${pr.body.replace(/\s+/g, " ").slice(0, 200)}` : ""}`
  ).join("\n");

  return `Write a concise domain-level summary (2 to 4 sentences) of the **${domainName}** domain's work this week, based on the pull requests below.

Rules:
- Domain-level voice: the subject is the domain or the work, e.g. "The ${domainName} domain shipped…". Never name individual people.
- Prose only. No bullet list, no PR titles verbatim, no links.
- Be specific and technical but readable.${styleBlock}
Return ONLY the summary text, no preamble, no quotes.

PRs:
${prText}`;
}

async function narrateDomain(domainName, prs) {
  return (await callAI(buildDomainPrompt(domainName, prs), 512)).trim().replace(/^"|"$/g, "");
}

// Escape markdown link-text brackets so titles like "[ATLAS-123] fix" don't break the link.
function escapeLinkText(s) {
  return s.replace(/[\[\]]/g, m => "\\" + m);
}

// A domain's PRs as a simple sorted list of links, with a marker for non-merged PRs.
function renderPrList(domainPrs) {
  return [...domainPrs]
    .sort((a, b) => a._repoName.localeCompare(b._repoName) || a.number - b.number)
    .map(pr => `- [${escapeLinkText(pr.title)}](${pr.html_url})${STATUS_MARK[pr._status] || ""}`)
    .join("\n");
}

// ── Stage 3: team-wide summary ──
async function synthesiseTeamSummary(domainResults) {
  const parts = domainResults.filter(d => d.summary).map(d => `- ${d.name}: ${d.summary}`).join("\n");
  if (!parts) return "";
  return (await callAI(
    `These are per-domain weekly summaries for an engineering team:\n\n${parts}\n\nWrite ONE sentence capturing the team-wide theme and output across all domains this week. Domain-level voice, no individual names.${styleBlock}\nReturn only the sentence, no preamble, no quotes.`,
    256)).trim().replace(/^"|"$/g, "");
}

// ── Stage 4 (optional): suggest taxonomy improvements ──
// Greenfield product → the domain set will evolve. Flag likely new domains or
// splits (e.g. a domain that dominates every week, or a recurring Uncategorized
// theme). Conservative by design: returns "" when the taxonomy looks fine.
async function suggestTaxonomy(domainResults) {
  if (!SUGGEST_DOMAINS) return "";
  const total = domainResults.reduce((n, d) => n + d.prs.length, 0) || 1;
  const ranked = [...domainResults].sort((a, b) => b.prs.length - a.prs.length);
  const dist = ranked.map(d =>
    `- ${d.name}: ${d.prs.length} PRs (${Math.round(d.prs.length / total * 100)}%) — repos: ${[...new Set(d.prs.map(p => p._repoName))].join(", ")}`
  ).join("\n");
  const top = ranked[0];
  const topShare = Math.round(top.prs.length / total * 100);
  const uncat = domainResults.find(d => d.name === UNCATEGORIZED);
  const uncatTitles = uncat?.prs.length
    ? uncat.prs.map(p => `  - ${p._repoName}: ${p.title}`).join("\n")
    : "  (none)";

  const raw = (await callAI(
    `You maintain the domain taxonomy for a weekly engineering summary. The product is an AVL (Automatic Vehicle Location) MRM (Mobile Resource Management) enterprise SaaS, early and greenfield, so the taxonomy is expected to evolve.

This week's domains, by share of PRs, with the repos in each:
${dist}

Uncategorized PRs this week (a recurring theme here suggests a missing domain):
${uncatTitles}

Consider proposing a change when:
- One domain dominates the week (here the largest is **${top.name}** at ${topShare}%). If its repos or themes cleanly separate into two coherent areas, propose a split with concrete member repos.
- Uncategorized shows a recurring theme that deserves its own domain.
Do not propose churn for its own sake; if the taxonomy is already coherent, respond with exactly "NONE".

Give at most three suggestions. Format each as one bullet: "- **Proposed domain** — the change, which repos or work move into it, and why it helps."${styleBlock}
Return only the bullets, or NONE.`,
    500)).trim();

  return /^none\b/i.test(raw) || !raw ? "" : raw;
}

async function generateDigest(domains, prs, fileData, names) {
  const assign = await classifyAll(domains, prs, fileData);

  const order = [...domains.map(d => d.name), UNCATEGORIZED];
  const buckets = new Map(order.map(n => [n, []]));
  for (const pr of prs) buckets.get(assign[prKey(pr)] || UNCATEGORIZED).push(pr);

  const domainResults = [];
  for (const name of order) {
    const domainPrs = buckets.get(name);
    if (!domainPrs.length) continue;
    console.log(`    summarising "${name}" (${domainPrs.length} PRs)…`);
    const summary = await narrateDomain(name, domainPrs);
    domainResults.push({
      name,
      prs: domainPrs,
      summary,
      prList: renderPrList(domainPrs),
      contributors: [...new Set(domainPrs.map(p => p._author))].sort(),
      lines: domainPrs.reduce((n, p) => n + (fileData.perPR[prKey(p)]?.lines || 0), 0),
    });
  }

  const teamSummary = await synthesiseTeamSummary(domainResults);
  const suggestions = await suggestTaxonomy(domainResults);
  if (suggestions) console.log(`    taxonomy suggestions produced`);
  return { teamSummary, domainResults, suggestions };
}

// ─── Markdown assembly ────────────────────────────────────────────────────────

function yamlList(items) {
  return items.map(i => `  - ${i}`).join("\n");
}

function buildMarkdown(year, week, teamSummary, domainResults, languages, names, suggestions = "") {
  const { start, end } = weekBounds(year, week);
  const totalAuthored = domainResults.reduce((n, d) => n + d.prs.length, 0);
  const allContributors = [...new Set(domainResults.flatMap(d => d.contributors))].sort();

  const domainsYaml = domainResults.map(d => [
    `  - name: ${d.name}`,
    `    authored_pr_count: ${d.prs.length}`,
    `    lines: ${d.lines || 0}`,
    `    contributors: [${d.contributors.join(", ")}]`,
    `    repos: [${[...new Set(d.prs.map(p => p._repoName))].join(", ")}]`,
  ].join("\n")).join("\n");

  const langEntries = Object.entries(languages).filter(([, v]) => v > 0);
  const langsYaml = langEntries.length
    ? `languages:\n${langEntries.map(([k, v]) => {
        const key = /[\s:#\[\]{}&*!|>'"@`]/.test(k) ? `"${k}"` : k;
        return `  ${key}: ${v}`;
      }).join("\n")}`
    : null;

  const frontmatter = [
    "---",
    teamSummary ? `summary: "${teamSummary.replace(/"/g, '\\"')}"` : `summary: ""`,
    `week: ${week}`,
    `year: ${year}`,
    `date_range: ${fmtDate(start)} – ${fmtDate(end)}`,
    `authored_pr_count: ${totalAuthored}`,
    allContributors.length ? `engineers:\n${yamlList(allContributors)}` : `engineers: []`,
    `domains:\n${domainsYaml}`,
    langsYaml,
    `tags:\n  - heartbeat\n  - weekly\n  - team`,
    "---",
  ].filter(line => line !== null).join("\n");

  const sections = domainResults.map(d => {
    const who = d.contributors.map(u => names[u] || u).join(", ");
    return `## ${d.name}
_${who || "—"}_

${d.summary ? `${d.summary}\n\n` : ""}### Pull Requests

${d.prList}`;
  });

  const suggestionSection = suggestions
    ? `\n\n---\n\n## Taxonomy Suggestions\n_Advisory: proposed domain changes for you to accept or ignore._\n\n${suggestions}`
    : "";

  return `${frontmatter}

# ${year}—Week ${pad(week)} Team Summary
${fmtDateShort(start)} – ${fmtDateShort(end)}

---

${sections.join("\n\n---\n\n")}${suggestionSection}
`.trimEnd() + "\n";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = loadTeamAccount();
  const { engineers: usernames, domains } = loadTeam();

  console.log(`Team roster: ${usernames.length} engineers via ${account.displayName} (${account.org})`);
  console.log(`Domain taxonomy: ${domains.map(d => d.name).join(", ")}`);

  const weeks = resolveTargetWeeks();
  console.log(`Processing ${weeks.length} week(s): ${weeks.map(w => `${w.year}-W${pad(w.week)}`).join(", ")}`);

  for (const { year, week } of weeks) {
    const { start, end } = weekBounds(year, week);
    const yearDir  = join(TEAM_ROOT, String(year));
    const outPath  = join(yearDir, `${year}-W${pad(week)}-${SUMMARY_SUFFIX}.md`);

    if (existsSync(outPath) && !FLAG_REBUILD) {
      console.log(`\n${year}-W${pad(week)}: heartbeat exists, skipping (use --rebuild to overwrite).`);
      continue;
    }

    console.log(`\nProcessing ${year}-W${pad(week)} (${fmtDate(start)} → ${fmtDate(end)})`);

    let prs;
    try {
      prs = await gheConnector.fetchTeamAuthoredPRs(account, usernames, start, end);
    } catch (e) {
      console.error(`  fetch failed: ${e.message}`);
      process.exit(1);
    }

    if (!prs.length) {
      console.log(`  No authored PRs this week — skipping.`);
      continue;
    }
    console.log(`  ${prs.length} authored PR(s) across the team.`);

    // Resolve author logins → display names for attribution.
    const names = await gheConnector.fetchUserDisplayNames(account, prs.map(p => p._author));

    // Per-PR changed files (classification signal) + line counts + language mix.
    console.log(`  Fetching file data…`);
    let fileData = { perPR: {}, langChanges: {} };
    try {
      fileData = await gheConnector.fetchPRFileData(
        { host: account.host, org: account.org, token: account.token }, prs);
    } catch (e) {
      console.warn(`  File fetch failed: ${e.message} — classifying from title/body only.`);
    }
    const totalChanges = Object.values(fileData.langChanges).reduce((a, b) => a + b, 0);
    if (!totalChanges) console.log(`  File/language data unavailable (token may lack repo-read scope).`);
    const languages = totalChanges ? Object.fromEntries(
      Object.entries(fileData.langChanges).sort(([, a], [, b]) => b - a).slice(0, 5)
        .map(([lang, n]) => [lang, Math.round(n / totalChanges * 100)])
    ) : {};

    // Classify + narrate in one inference; recover per-domain metadata from it.
    console.log(`  Classifying + summarising ${prs.length} PR(s)…`);
    const { teamSummary, domainResults, suggestions } = await generateDigest(domains, prs, fileData, names);
    const uncat = domainResults.find(d => d.name === UNCATEGORIZED)?.prs.length || 0;
    if (uncat) console.log(`  ${uncat} PR(s) uncategorized — extend the taxonomy in team.json if this is large.`);

    mkdirSync(yearDir, { recursive: true });
    writeFileSync(outPath, buildMarkdown(year, week, teamSummary, domainResults, languages, names, suggestions), "utf8");
    console.log(`  Written: ${outPath}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
