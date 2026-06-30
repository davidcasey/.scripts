/**
 * connector-ghe.mjs
 * Fetches PRs for GitHub Enterprise accounts.
 * GHE uses the same API as GitHub.com — the host difference is handled
 * inside connector-github.mjs via account.host.
 */

export { fetchAccountPRs, fetchPRLanguages } from "./connector-github.mjs";
