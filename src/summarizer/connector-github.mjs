/**
 * connector-github.mjs
 * Fetches authored and reviewed PRs for GitHub.com accounts.
 * Also used by connector-ghe.mjs for GitHub Enterprise (same API, different host).
 *
 * Expected account fields: { name, username, org, token, host }
 */

function fmtDate(d) { return d.toISOString().slice(0, 10); }

// ─── Concurrency + rate limit helpers ────────────────────────────────────────

// Process items in batches to avoid secondary rate limits
async function withConcurrency(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Pause if we're running low on remaining requests.
// Octokit doesn't expose headers directly, so we track via a shared state
// object updated by a throttling plugin.
async function checkRateLimit(octokit, account) {
  try {
    const { data } = await octokit.rateLimit.get();
    const { remaining, reset } = data.rate;
    if (remaining < 100) {
      const waitMs = (reset * 1000) - Date.now() + 2000; // 2s buffer
      if (waitMs > 0) {
        const waitSec = Math.ceil(waitMs / 1000);
        console.warn(`  [rate limit] ${account.accountDisplayName} has ${remaining} requests left — waiting ${waitSec}s for reset…`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  } catch { /* non-fatal */ }
}

async function makeOctokit(account) {
  const { Octokit } = await import("@octokit/rest");
  return new Octokit({ auth: account.token, baseUrl: account.apiBase });
}

function repoNameFromPR(pr, account) {
  if (pr._repoFullName) return pr._repoFullName;
  // Extract owner/repo from any GitHub API URL: .../repos/{owner}/{repo}
  const match = pr.repository_url?.match(/\/repos\/([^/]+\/[^/]+)/);
  if (match) return match[1];
  // Fallback: strip known bases
  return pr.repository_url
    .replace(`${account.apiBase}/repos/`, "")
    .replace("https://api.github.com/repos/", "");
}

function shortRepoName(fullName) {
  return fullName.includes("/") ? fullName.split("/")[1] : fullName;
}

async function searchPRs(octokit, account, startStr, endStr) {
  try {
    const orgClause = account.org ? ` org:${account.org}` : "";
    const q = `is:pr author:${account.username} created:${startStr}..${endStr}${orgClause}`;
    console.log(`  [search] ${q}`);
    const results = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.search.issuesAndPullRequests({
        q, per_page: 100, page, sort: "created", order: "asc",
      });
      results.push(...data.items);
      if (data.items.length < 100) break;
      page++;
    }
    return results;
  } catch (e) {
    console.log(`  [search] failed (${e.status ?? e.message}), will use fallback`);
    return [];
  }
}

async function enumerateActiveRepos(octokit, account) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString();

  let repos = [];
  let page = 1;
  try {
    while (true) {
      const { data } = account.org
        ? await octokit.repos.listForOrg({ org: account.org, per_page: 100, page, sort: "pushed" })
        : await octokit.repos.listForAuthenticatedUser({ per_page: 100, page, sort: "pushed" });
      const active = data.filter(r => r.pushed_at > cutoffStr);
      repos.push(...active);
      if (data.length < 100 || active.length < data.length) break;
      page++;
    }
  } catch (e) {
    if (e.status === 403 || e.status === 401) {
      console.warn(`  [fallback] cannot list repos for ${account.accountDisplayName} (${e.status}) — search results only.`);
      console.warn(`  → Check that your token has read:org scope and is SSO-authorized for "${account.org}".`);
      return null; // signal: fallback unavailable
    }
    throw e;
  }
  return repos;
}

async function enumerateAuthoredPRs(octokit, account, repos, start, end) {
  console.log(`  [fallback] checking ${repos.length} active repos for authored PRs (max 5 concurrent)…`);
  const authored = [];

  await withConcurrency(repos, 5, async repo => {
    try {
      await checkRateLimit(octokit, account);
      let prPage = 1;
      while (true) {
        const { data: prs } = await octokit.pulls.list({
          owner: repo.owner.login, repo: repo.name,
          state: "all", per_page: 100, page: prPage,
          sort: "created", direction: "desc",
        });
        const inRange = prs.filter(pr => {
          const created = new Date(pr.created_at);
          return pr.user.login === account.username && created >= start && created <= end;
        });
        inRange.forEach(pr => authored.push({
          ...pr,
          repository_url: `${account.apiBase}/repos/${repo.owner.login}/${repo.name}`,
          _repoFullName: `${repo.owner.login}/${repo.name}`,
        }));
        if (prs.length < 100 || (prs.length > 0 && new Date(prs[prs.length - 1].created_at) < start)) break;
        prPage++;
      }
    } catch { /* skip inaccessible repos */ }
  });

  return authored;
}

async function enumerateReviewedPRs(octokit, account, repos, start, end) {
  console.log(`  [fallback] checking ${repos.length} active repos for reviewed PRs (max 5 concurrent)…`);
  const reviewed = [];

  await withConcurrency(repos, 5, async repo => {
    try {
      await checkRateLimit(octokit, account);
      let prPage = 1;
      while (true) {
        const { data: prs } = await octokit.pulls.list({
          owner: repo.owner.login, repo: repo.name,
          state: "all", per_page: 100, page: prPage,
          sort: "created", direction: "desc",
        });

        const candidates = prs.filter(pr => {
          const created = new Date(pr.created_at);
          return pr.user.login !== account.username && created >= start && created <= end;
        });

        // Sequential review checks to avoid bursting requests
        for (const pr of candidates) {
          try {
            await checkRateLimit(octokit, account);
            const { data: reviews } = await octokit.pulls.listReviews({
              owner: repo.owner.login, repo: repo.name, pull_number: pr.number,
            });
            const didReview = reviews.some(r => r.user?.login === account.username);
            if (didReview) {
              reviewed.push({
                ...pr,
                repository_url: `${account.apiBase}/repos/${repo.owner.login}/${repo.name}`,
                _repoFullName: `${repo.owner.login}/${repo.name}`,
              });
            }
          } catch { /* skip */ }
        }

        if (prs.length < 100 || (prs.length > 0 && new Date(prs[prs.length - 1].created_at) < start)) break;
        prPage++;
      }
    } catch { /* skip inaccessible repos */ }
  });

  return reviewed;
}

async function searchReviewedPRs(octokit, account, startStr, endStr) {
  try {
    const orgClause = account.org ? ` org:${account.org}` : "";
    const q = `is:pr reviewed-by:${account.username} -author:${account.username} created:${startStr}..${endStr}${orgClause}`;
    console.log(`  [reviewed search] ${q}`);
    const results = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.search.issuesAndPullRequests({
        q, per_page: 100, page, sort: "created", order: "asc",
      });
      results.push(...data.items);
      if (data.items.length < 100) break;
      page++;
    }
    return results;
  } catch {
    return [];
  }
}

async function enrichAuthored(prs, octokit, account) {
  return Promise.all(prs.map(async pr => {
    const repoName = repoNameFromPR(pr, account);
    const [owner, repo] = repoName.split("/");
    try {
      const { data } = await octokit.pulls.get({ owner, repo, pull_number: pr.number });
      return { ...pr, body: data.body || "", _repoFullName: repoName };
    } catch {
      return { ...pr, _repoFullName: repoName };
    }
  }));
}

export async function fetchAccountPRs(account, start, end) {
  const host    = (account.host || "https://github.com").replace(/\/$/, "");
  const isGHE   = host !== "https://github.com";
  const apiBase = isGHE ? `${host}/api/v3` : "https://api.github.com";
  const resolved = { ...account, apiBase };

  console.log(`\nFetching: ${account.accountDisplayName} (${account.username})`);
  const octokit   = await makeOctokit(resolved);
  const startStr  = fmtDate(start);
  const endStr    = fmtDate(end);

  let authored = await searchPRs(octokit, resolved, startStr, endStr);
  let repos = null;
  if (authored.length === 0) {
    repos = await enumerateActiveRepos(octokit, resolved);
    if (repos !== null) {
      authored = await enumerateAuthoredPRs(octokit, resolved, repos, start, end);
    }
  }
  authored = await enrichAuthored(authored, octokit, resolved);
  console.log(`  authored: ${authored.length}`);

  let reviewed = await searchReviewedPRs(octokit, resolved, startStr, endStr);
  if (reviewed.length === 0) {
    if (repos === null) repos = await enumerateActiveRepos(octokit, resolved);
    if (repos !== null) {
      reviewed = await enumerateReviewedPRs(octokit, resolved, repos, start, end);
    }
  }
  console.log(`  reviewed: ${reviewed.length}`);

  // Normalise shape for summary scripts
  return {
    authored: authored.map(pr => ({
      number: pr.number,
      title:  pr.title,
      state:  pr.state,
      body:   pr.body || "",
      html_url: pr.html_url,
      _repoName: shortRepoName(repoNameFromPR(pr, resolved)),
    })),
    reviewed: reviewed.map(pr => ({
      number:   pr.number,
      title:    pr.title,
      html_url: pr.html_url,
      _repoName: shortRepoName(repoNameFromPR(pr, resolved)),
    })),
  };
}

// ─── PR language detection ───────────────────────────────────────────────────

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

function extToLang(filename) {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? null : (FILE_EXT_LANG[filename.slice(dot).toLowerCase()] ?? null);
}

export async function fetchPRLanguages(account, prs) {
  const host    = (account.host || 'https://github.com').replace(/\/$/, '');
  const isGHE   = host !== 'https://github.com';
  const apiBase = isGHE ? `${host}/api/v3` : 'https://api.github.com';
  const octokit = await makeOctokit({ ...account, apiBase });
  const owner   = account.org || account.username;

  const langChanges = {};
  const repoChanges = {};
  await withConcurrency(prs, 5, async pr => {
    try {
      const { data: files } = await octokit.pulls.listFiles({
        owner, repo: pr._repoName, pull_number: pr.number, per_page: 100,
      });
      for (const file of files) {
        const delta = file.changes || 1;
        const lang = extToLang(file.filename);
        if (lang) langChanges[lang] = (langChanges[lang] || 0) + delta;
        repoChanges[pr._repoName] = (repoChanges[pr._repoName] || 0) + delta;
      }
    } catch (e) {
      // 403 on GHE means the token lacks repo-read scope — expected, suppress noise
      if (e.status !== 403) {
        console.warn(`  [languages] ${owner}/${pr._repoName}#${pr.number}: ${e.status ?? e.message}`);
      }
    }
  });

  return { langChanges, repoChanges }; // line-change counts — caller normalises to %
}
