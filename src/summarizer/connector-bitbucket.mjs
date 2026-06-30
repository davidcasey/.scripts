/**
 * connector-bitbucket.mjs
 * Fetches authored PRs for Bitbucket Cloud accounts.
 *
 * Expected account fields: { name, workspace, username, email, token }
 * Auth: Atlassian API token — Basic base64(email:token)
 */

function fmtDate(d) { return d.toISOString().slice(0, 10); }

const FILE_EXT_LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python',
  '.java': 'Java',
  '.cs': 'C#',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.scss': 'SCSS', '.sass': 'SCSS',
  '.css': 'CSS',
  '.html': 'HTML', '.htm': 'HTML',
  '.sh': 'Shell', '.bash': 'Shell',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
};

function makeAuth(account) {
  const authUser = account.email || account.username;
  return Buffer.from(`${authUser}:${account.token}`).toString("base64");
}

async function bbFetch(url, auth, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });

    if (res.ok) return res.json();

    if (res.status === 429) {
      // Respect Retry-After header if present, otherwise exponential backoff
      const retryAfter = res.headers.get("retry-after");
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : Math.pow(2, attempt + 1);
      console.warn(`  [rate limit] Bitbucket 429 — waiting ${waitSec}s before retry (attempt ${attempt + 1}/${retries})…`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }

    const text = await res.text().catch(() => "");
    throw new Error(`Bitbucket API ${res.status}: ${url}\n${text}`);
  }
  throw new Error(`Bitbucket API 429: max retries exceeded for ${url}`);
}

async function listRepos(account, auth) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = fmtDate(cutoff);

  const repos = [];
  let url = `https://api.bitbucket.org/2.0/repositories/${account.workspace}?pagelen=100&sort=-updated_on&q=updated_on>="${cutoffStr}"`;
  while (url) {
    const data = await bbFetch(url, auth);
    repos.push(...data.values);
    url = data.next || null;
  }
  return repos;
}

// Process repos in batches to avoid Bitbucket rate limits (429s)
async function withConcurrency(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      results.push(await fn(item));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchAuthoredPRs(account, auth, repos, start, end) {
  console.log(`  [authored] checking ${repos.length} repos (max 5 concurrent)…`);
  const startStr = fmtDate(start);
  const endStr   = fmtDate(end);
  const authored = [];

  // Prefer account_id (stable UUID) over nickname (display name, can change)
  const authorFilter = account.accountId
    ? `author.account_id="${account.accountId}"`
    : `author.nickname="${account.nickname}"` ;

  await withConcurrency(repos, 5, async repo => {
    try {
      const q = encodeURIComponent(
        `${authorFilter} AND created_on>="${startStr}" AND created_on<="${endStr}"`
      );
      let url = `https://api.bitbucket.org/2.0/repositories/${account.workspace}/${repo.slug}/pullrequests?q=${q}&state=MERGED&state=OPEN&state=DECLINED&state=SUPERSEDED&pagelen=50`;
      while (url) {
        const data = await bbFetch(url, auth);
        authored.push(...data.values.map(pr => ({ ...pr, _repoSlug: repo.slug })));
        url = data.next || null;
      }
    } catch (e) {
      console.log(`  [authored] skipping ${repo.slug}: ${e.message}`);
    }
  });

  return authored;
}

export async function fetchAccountPRs(account, start, end) {
  console.log(`\nFetching: ${account.accountDisplayName} (${account.nickname ?? account.email} @ ${account.workspace})`);
  const auth  = makeAuth(account);
  const repos = await listRepos(account, auth);
  console.log(`  repos active in last 90d: ${repos.length}`);

  const raw = await fetchAuthoredPRs(account, auth, repos, start, end);
  console.log(`  authored: ${raw.length}`);

  // Normalise shape for summary scripts
  const authored = raw.map(pr => ({
    number:   pr.id,
    title:    pr.title,
    state:    pr.state,
    body:     pr.description || "",
    html_url: pr.links?.html?.href || "",
    _repoName: pr._repoSlug || pr.source?.repository?.name || "unknown",
  }));

  // Bitbucket Cloud has no global "reviewed by" query
  return { authored, reviewed: [] };
}

export async function fetchPRLanguages(account, prs) {
  const auth = makeAuth(account);
  const langChanges = {};
  const repoChanges = {};

  await Promise.all(prs.map(async pr => {
    try {
      const data = await bbFetch(
        `https://api.bitbucket.org/2.0/repositories/${account.workspace}/${pr._repoName}/pullrequests/${pr.number}/diffstat?pagelen=100`,
        auth
      );
      for (const entry of (data.values || [])) {
        const path  = entry.new?.path || entry.old?.path || '';
        const dot   = path.lastIndexOf('.');
        const delta = (entry.lines_added || 0) + (entry.lines_removed || 0) || 1;
        repoChanges[pr._repoName] = (repoChanges[pr._repoName] || 0) + delta;
        if (dot === -1) continue;
        const lang = FILE_EXT_LANG[path.slice(dot).toLowerCase()];
        if (lang) langChanges[lang] = (langChanges[lang] || 0) + delta;
      }
    } catch (e) {
      console.warn(`  [languages] ${account.workspace}/${pr._repoName}#${pr.number}: ${e.status ?? e.message}`);
    }
  }));

  return { langChanges, repoChanges };
}
