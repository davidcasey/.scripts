# Chronicle
```
▄▖▌       ▘  ▜   
▌ ▛▌▛▘▛▌▛▌▌▛▘▐ █▌
▙▖▌▌▌ ▙▌▌▌▌▙▖▐▖▙▖
```                 

Chronicle turns your engineering activity into readable Markdown in your Obsidian vault. It runs three things: personal weekly and quarterly statements of work from your PRs (GitHub, GitHub Enterprise, and Bitbucket Cloud); a team heartbeat that groups a roster's PRs by domain rather than by person; and **L24**, a daily "last 24 hours" digest built from your AI conversations, authored PRs, checked TODOs, and calendar meetings. Summaries are written by your choice of AI provider (Anthropic, OpenAI-compatible, or a local Ollama model).

---

## Requirements

- Node.js 18 or later (native `fetch` required)
- pnpm
- An Obsidian vault organized with year and week folders: `VAULT/2026/25/`

---

## File Structure

```
src/chronicle/
  weekly.mjs             — personal weekly summary orchestration
  quarterly.mjs          — personal quarterly summary (weekly files + daily TODOs)
  team-weekly.mjs        — team heartbeat weekly, grouped by domain
  team-quarterly.mjs     — team heartbeat quarterly rollup, grouped by domain
  l24.mjs                — "last 24h" personal daily digest into the journal note
  lib/
    env.mjs              — .env loading, path roots, account loading
    dates.mjs            — week/quarter/day helpers (ISO week, business-day, …)
    ai.mjs               — single callAI() for anthropic | openai | ollama
    style.mjs            — house writing-style guide → prompt block
    obsidian.mjs         — shared vault helpers (parseCheckedTodos)
  connectors/
    github.mjs           — GitHub.com and GHE API connector
    ghe.mjs              — GitHub Enterprise re-export of github.mjs
    bitbucket.mjs        — Bitbucket Cloud API connector
  accounts.json          — account definitions (gitignored)
  accounts.example.json  — template with placeholder values (committed)
  team.json              — team roster + domain taxonomy (gitignored)
  team.example.json      — team template (committed)
  .env                   — secrets (gitignored)
  .env.example           — template (committed)
```

---

## Setup

### 1. Copy `.env.example` to `.env`

```sh
cp src/chronicle/.env.example src/chronicle/.env
```

Fill in all values. `.env` is gitignored and never committed.

### 2. Configure `accounts.json`

Each entry defines one account. The `type` field determines which connector is used. If a `tokenEnvVar` is commented out or missing from `.env`, that account is silently skipped.

#### GitHub Enterprise (GHE)

```json
{
  "accountDisplayName": "Display Name",
  "type": "ghe",
  "host": "https://your-ghe-host.com",
  "org": "YourOrg",
  "username": "your-ghe-username",
  "tokenEnvVar": "TOKEN_GHE"
}
```

#### GitHub.com

```json
{
  "accountDisplayName": "Display Name",
  "type": "github",
  "host": "https://github.com",
  "org": "",
  "username": "your-github-username",
  "tokenEnvVar": "TOKEN_GITHUB"
}
```

#### Bitbucket Cloud

```json
{
  "accountDisplayName": "Display Name",
  "type": "bitbucket",
  "workspace": "your-workspace-slug",
  "email": "you@yourcompany.com",
  "nickname": "Your Display Name",
  "accountId": "712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "tokenEnvVar": "TOKEN_BITBUCKET"
}
```

- `email` — your Atlassian account email (used for Basic auth)
- `nickname` — your Bitbucket display name as it appears on PRs (used as fallback if `accountId` is absent)
- `accountId` — your Bitbucket account UUID (preferred; stable even if display name changes)

To find your `accountId` and `username`, open any PR you authored in the workspace and check the API:

```sh
curl -u "you@email.com:YOUR_TOKEN" \
  "https://api.bitbucket.org/2.0/repositories/WORKSPACE/REPO/pullrequests/PR_NUMBER" \
  | grep -A4 '"author"'
```

---

## Token Setup

The env var names below (`TOKEN_GHE`, etc.) are examples. Name each one however you like, as long as it matches the `tokenEnvVar` of the matching account in `accounts.json`. The team heartbeat reuses the GHE account's token, and L24 reuses whichever account tokens you have set.

### GitHub Enterprise (GHE)

Create a **classic personal access token** at:
`https://YOUR-GHE-HOST/settings/tokens`

**Required scopes:**
- `repo` — full repository access (read PRs, list repos, read PR file diffs for language detection)
- `read:org` — list organization repositories

**If your org uses SSO:** after creating the token, click **Authorize** next to your org on the token page. Without SSO authorization, repo-level API endpoints (PR details, file diffs) return 403 even if the token has the correct scopes. Search endpoints still work with an unauthorized token, so PR discovery works but language detection does not.

Add to `.env`:
```
TOKEN_GHE=ghp_xxxxxxxxxxxx
```

---

### GitHub.com

Create a **classic personal access token** at:
`https://github.com/settings/tokens`

**Required scopes:**
- `repo` — read PRs and list repositories

Add to `.env`:
```
TOKEN_GITHUB=ghp_xxxxxxxxxxxx
```

---

### Bitbucket Cloud

App passwords are being removed (brownout June 2026, permanent removal July 28, 2026). Use **Atlassian API tokens with scopes** instead.

Create a scoped API token at:
`https://id.atlassian.com/manage-profile/security/api-tokens`

**Required scopes (select during token creation):**
- **Repositories: Read**
- **Pull requests: Read**

> `Account: Read` is not required. The scripts never read your profile.

Add to `.env`:
```
TOKEN_BITBUCKET=ATATT3xxxxxxxxxxx
```

---

## Disabling an Account

Comment out the token in `.env`. The account entry in `accounts.json` is preserved and the account is silently skipped at runtime.

```sh
# TOKEN_BITBUCKET=ATATT3xxx  ← commented out = skipped
```

---

## Usage

### Weekly Summary

Finds all weeks without a summary file, most recent first, and generates them. Stops when it reaches a week that already has a summary.

```sh
# Process all unsummarised weeks, oldest first
node src/chronicle/weekly.mjs

# Process a specific week
node src/chronicle/weekly.mjs --week 2026-W25

# Process only the most recent unsummarised week
node src/chronicle/weekly.mjs --latest

# Rebuild all existing summaries (re-fetches from API, regenerates AI summaries)
node src/chronicle/weekly.mjs --rebuild

# Rebuild a specific week
node src/chronicle/weekly.mjs --rebuild --week 2026-W25
```

`--rebuild` processes weeks that already have a summary file, overwriting them. Use it when:
- Token permissions were upgraded and you want accurate language data
- `reviewed_pr_count` or `authored_pr_count` frontmatter is wrong
- The frontmatter schema changed and existing files need to be brought up to date
- New features have been added and you need retrofitting

**Frontmatter fields written:**

| Field | Description |
|---|---|
| `summary` | Per-account one-sentence AI summary |
| `week` | ISO week number |
| `year` | Year |
| `date_range` | `YYYY-MM-DD – YYYY-MM-DD` |
| `repos` | Unique repos with authored PRs |
| `authored_pr_count` | Total authored PRs |
| `reviewed_pr_count` | Total reviewed PRs |
| `languages` | Top-5 languages by lines changed (from PR file diffs). Omitted if the token lacks repo-read scope. |
| `tags` | `[summary, weekly]` |

Language detection uses file extensions from PR diffs (`pulls.listFiles`). Requires `repo` scope and, on GHE with SSO, org authorization. If the token lacks access, the field is omitted rather than written as empty.

### Quarterly Summary

Reads existing weekly summary files and checked TODO items from daily journal notes, then generates a unified quarterly narrative with Mermaid charts (activity by week, language mix, and per-repo lines of code).

```sh
# Current quarter
node src/chronicle/quarterly.mjs

# Specific quarter
node src/chronicle/quarterly.mjs --quarter 2026-Q2

# Overwrite an existing quarterly file
node src/chronicle/quarterly.mjs --quarter 2026-Q2 --force
```

Requires weekly summaries to exist for the quarter first. Output: `VAULT/{year}/{year}-Q{q}-Summary.md`

---

## Team Heartbeat

A separate pipeline (`team-weekly.mjs` / `team-quarterly.mjs`) summarises **authored PRs for a roster of engineers** from the GHE org, grouped by **domain** instead of by person. The narrative is domain-level ("The UI domain shipped…"); engineers appear only as light attribution metadata.

**Domain is a property of the PR, not the repo.** One repo (`web-map`) holds both UI and Infrastructure PRs; one domain (Infrastructure) spans many repos. So each PR is **classified by the AI** — from its title, description, and changed file paths — into a **fixed taxonomy of domain names you define**. Only the label set is fixed; the per-PR assignment is inferred. Fixing the vocabulary is what keeps weekly→quarterly aggregation coherent (invented names would drift week to week).

The work is staged into small, bounded AI calls so a busy week (dozens of PRs) never overflows a single call's output budget or a local model's context window: **(1)** classify PRs in batches, **(2)** write one domain-level summary paragraph per domain, **(3)** synthesize one team-wide summary line. `TEAM_BATCH_SIZE` (default 15) caps PRs per classification call — lower it for small local models. Any PR the model fails to place lands in **Uncategorized** (logged); grow the taxonomy or sharpen `hint`s if that bucket is large.

Each domain section is a short summary paragraph followed by a plain list of PR links (`- [title](url)`) — no per-PR prose. Non-merged PRs are marked inline (`_(open)_`, `_(draft)_`, `_(closed, unmerged)_`); merged PRs have no marker. **PRs created *or updated* during the week are included**, so a PR opened earlier but still in progress this week is reported (not just PRs born that week).

Two optional touches:

- **House style** — if a writing-style guide exists at `.github/instructions/writing-style.instructions.md` (or `TEAM_STYLE_FILE`), its conventions are injected into the summary prompts so the prose matches your style.
- **Taxonomy suggestions** — a trailing, advisory `## Taxonomy Suggestions` section proposes new or split domains when one domain dominates the week or Uncategorized shows a recurring theme. It stays silent when the taxonomy looks coherent. Disable with `TEAM_SUGGEST_DOMAINS=false`.

### How it differs from the personal pipeline

| | Personal | Team heartbeat |
|---|---|---|
| Subject | One person, all accounts | A roster of engineers, GHE only |
| Grouping | By account | By **domain**, via per-PR AI classification |
| PRs | Authored + reviewed | Authored only |
| Auth | One token per account | **Single shared read token** — reuses the `ghe` account in `accounts.json` |
| Output | `VAULT/{year}/{ww}/…-Summary.md` | `TEAM/{year}/…-Heartbeat.md` |

### Configure `team.json`

Copy `team.example.json` to `team.json` (gitignored — it lists people). Two keys:

```json
{
  "engineers": ["jbob", "jdoe", "jsmith"],
  "domains": [
    { "name": "UI",             "hint": "components, styling, UX, accessibility" },
    { "name": "Infrastructure", "hint": "CI/CD, deploys, build tooling, cloud config" },
    { "name": "Mapping",        "hint": "geospatial features, tiles, routing" }
  ]
}
```

- **`engineers`** — list of GHE logins. This is the fetch roster; display names are resolved automatically from the GHE API, so you only supply usernames.
- **`domains`** — the taxonomy each PR is classified into. `name` is required and must stay stable across weeks (the quarterly rollup aggregates by it). `hint` is an optional one-liner that guides classification. No repos — a repo's PRs can land in different domains.

A PR that fits no domain is placed in **Uncategorized** (logged). If that bucket grows, add a domain. Note that classification is AI-inferred and imperfect — refine the `hint`s if PRs land in the wrong bucket.

Host, org, and token are **not** in `team.json` — they are reused from the `"type": "ghe"` account in `accounts.json` and its `tokenEnvVar`. Point that token at a shared read-only account if you don't want to use your personal one.

Add to `.env` (defaults shown; both optional):
```
OBSIDIAN_TEAM_PATH=~/Documents/Obsidian/Team/Heartbeat   # defaults to <vault parent>/Team/Heartbeat
TEAM_SUMMARY_FILENAME_SUFFIX=Heartbeat
```

### Usage

```sh
# Last completed week
node src/chronicle/team-weekly.mjs

# A specific week
node src/chronicle/team-weekly.mjs --week 2026-W27

# Backfill the 4 most recent weeks
node src/chronicle/team-weekly.mjs --weeks 4

# Overwrite existing heartbeat files
node src/chronicle/team-weekly.mjs --week 2026-W27 --rebuild

# Quarterly rollup (needs weekly heartbeats to exist first)
node src/chronicle/team-quarterly.mjs --quarter 2026-Q2
node src/chronicle/team-quarterly.mjs --quarter 2026-Q2 --force
```

Weekly output: `TEAM/{year}/{year}-W{ww}-Heartbeat.md` (directly in the year folder, alongside the quarterly rollup), with a `## Domain` section per active domain, a synthesised team-wide `summary`, and a structured `domains:` frontmatter block (per-domain PR count, LOC, contributors, repos) that the quarterly rollup reads to build its Mermaid charts (activity rhythm, language mix, domain distribution).

Quarterly output: `TEAM/{year}/{year}-Q{q}-Heartbeat.md`.

---

## L24 (Daily Digest)

`l24.mjs` produces a "last 24 hours" digest of your own work and drops it into your journal note. It reads your AI coding conversations and authored PRs for the previous business day, then writes an `## L24` section — at most 10 prioritized, terse bullets — into **today's** note. Meetings from your Outlook calendar are attached as a `### Meetings` sub-list (not counted toward the 10).

### What it reads

- **AI conversations** — Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) and VS Code Copilot Chat (`workspaceStorage/**/chatSessions/*.{json,jsonl}`), filtered to the day by each message's own timestamp (your local day).
- **Authored PRs** — via the same connectors as the weekly summary, day-scoped (search only, no repo-enumeration fallback, no reviewed PRs — fast).
- **Checked TODOs** — the `## TODO` `- [x]` items from the summarized day's own note, treated as first-class accomplishments (reused verbatim when they stand alone, merged when they overlap PR/chat work).
- **Meetings** — the calendar `.ics` feed (`CALENDAR_ICS_URL`), recurrences expanded, filtered to the day.

### Day model

L24 = last 24 hours. It writes into the **note date** (default: today) but summarizes the **previous business day** — so Monday's note reaches back to Friday. Everything (conversations, PRs, TODOs, meetings) comes from that previous business day.

```sh
# Summarize the previous business day → today's note
node src/chronicle/l24.mjs

# Fill a specific day's note (summarizes the business day before it)
node src/chronicle/l24.mjs --date 2026-07-02

# Print to stdout instead of writing the note
node src/chronicle/l24.mjs --print
```

The `## L24` section is inserted/replaced idempotently; if you keep a `## L24` heading in your daily-note template it fills that in place (stopping at the next `##` or `---`), preserving the rest of the note. Env vars: `CALENDAR_ICS_URL` (secret), `L24_MAX_BULLETS` (default 10), and optional `CLAUDE_PROJECTS_DIR` / `VSCODE_STORAGE_DIR` overrides.

Only Claude Code and Copilot are read today; other assistants need their own extractor.

---

## AI Provider

Set `AI_PROVIDER` in `.env` to `anthropic` (default), `openai`, or `ollama`.

| Provider | Model default | Base URL default | Key var |
|---|---|---|---|
| Anthropic | `claude-sonnet-4-6` | — | `ANTHROPIC_API_KEY` |
| OpenAI-compatible | `gpt-4o` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| Ollama (local) | `llama3.1` | `http://localhost:11434/v1` | none needed |

Override the model with `AI_MODEL=model-name`. For OpenAI-compatible hosts (GitHub Models / Copilot) set `OPENAI_BASE_URL`.

### Ollama (local inference)

Runs fully offline against [Ollama](https://ollama.com) — free, no API key, no rate limits. Slower than cloud, so it suits unattended backfills (`--weeks N`) left to grind. Just:

```
AI_PROVIDER=ollama
AI_MODEL=qwen2.5:14b
```

The base URL and a placeholder key are defaulted for you (override `OPENAI_BASE_URL` only if Ollama runs elsewhere). Notes on quality for the team heartbeat's classify-and-narrate step:

- **Classification** (PR → domain) is robust even on 8–14B models; the parser tolerates errors (unknown labels and dropped PRs fall to `Uncategorized`).
- **Narrative prose** is where small models lag — expect blander bullets and occasional format drift below ~14B. Larger models (`qwen2.5:32b`, `llama3.3:70b`) close the gap. Test one week and eyeball before committing to a model.

---

## Vault Folder Structure Expected

```
VAULT/
  2026/
    24/
      2026-05-18-Monday.md     ← daily notes (quarterly summary reads TODOs from these)
      2026-W24-Summary.md      ← written by weekly.mjs
    25/
      ...
    2026-Q2-Summary.md         ← written by quarterly.mjs
```

The week folder name must be the zero-padded ISO week number (`24`, not `Week 24`).

The team heartbeat writes to its own tree (created automatically); weekly digests and the quarterly rollup sit together in the year folder:

```
TEAM/                                   ← OBSIDIAN_TEAM_PATH
  2026/
    2026-W27-Heartbeat.md               ← written by team-weekly.mjs
    2026-Q2-Heartbeat.md                ← written by team-quarterly.mjs
```
