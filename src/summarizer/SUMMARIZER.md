# Summarizer

Generates weekly and quarterly statements of work from PRs across GitHub, GitHub Enterprise, and Bitbucket Cloud. Writes output as Markdown files into your Obsidian journal vault.

---

## Requirements

- Node.js 18 or later (native `fetch` required)
- pnpm
- An Obsidian vault organized with year and week folders: `VAULT/2026/25/`

---

## File Structure

```
src/summarizer/
  summary-weekly.mjs       — weekly summary orchestration
  summary-quarterly.mjs    — quarterly summary (reads weekly files + daily TODOs)
  connector-github.mjs     — GitHub.com and GHE API connector
  connector-ghe.mjs        — GitHub Enterprise re-export of connector-github
  connector-bitbucket.mjs  — Bitbucket Cloud API connector
  accounts.json            — account definitions (gitignored)
  accounts.example.json    — template with placeholder values (committed)
  .env                     — secrets (gitignored)
  .env.example             — template (committed)
```

---

## Setup

### 1. Copy `.env.example` to `.env`

```sh
cp src/summarizer/.env.example src/summarizer/.env
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

## Usage

### Weekly Summary

Finds all weeks without a summary file, most recent first, and generates them. Stops when it reaches a week that already has a summary.

```sh
# Process all unsummarised weeks, oldest first
node src/summarizer/summary-weekly.mjs

# Process a specific week
node src/summarizer/summary-weekly.mjs --week 2026-W25

# Process only the most recent unsummarised week
node src/summarizer/summary-weekly.mjs --latest

# Rebuild all existing summaries (re-fetches from API, regenerates AI summaries)
node src/summarizer/summary-weekly.mjs --rebuild

# Rebuild a specific week
node src/summarizer/summary-weekly.mjs --rebuild --week 2026-W25
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

Reads existing weekly summary files and checked TODO items from daily journal notes, then generates a unified quarterly narrative.

```sh
# Current quarter
node src/summarizer/summary-quarterly.mjs

# Specific quarter
node src/summarizer/summary-quarterly.mjs --quarter 2026-Q2
```

Requires weekly summaries to exist for the quarter first. Output: `VAULT/{year}/{year}-Q{q}-Summary.md`

---

## AI Provider

Set `AI_PROVIDER` in `.env` to `anthropic` (default) or `openai`.

| Provider | Model default | Key var |
|---|---|---|
| Anthropic | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| OpenAI-compatible | `gpt-4o` | `OPENAI_API_KEY` |

Override the model with `AI_MODEL=model-name`. For GitHub Models / Copilot, also set `OPENAI_BASE_URL`.

---

## Disabling an Account

Comment out the token in `.env`. The account entry in `accounts.json` is preserved and the account is silently skipped at runtime.

```sh
# TOKEN_BITBUCKET=ATATT3xxx  ← commented out = skipped
```

---

## Vault Folder Structure Expected

```
VAULT/
  2026/
    24/
      2026-05-18-Monday.md     ← daily notes (quarterly summary reads TODOs from these)
      2026-W24-Summary.md      ← written by summary-weekly.mjs
    25/
      ...
    2026-Q2-Summary.md         ← written by summary-quarterly.mjs
```

The week folder name must be the zero-padded ISO week number (`24`, not `Week 24`).
