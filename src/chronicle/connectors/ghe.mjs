/**
 * connectors/ghe.mjs
 * Fetches PRs for GitHub Enterprise accounts.
 * GHE uses the same API as GitHub.com — the host difference is handled
 * inside connectors/github.mjs via account.host.
 */

export {
  fetchAccountPRs,
  fetchPRLanguages,
  fetchTeamAuthoredPRs,
  fetchUserDisplayNames,
  fetchPRFileData,
} from "./github.mjs";
