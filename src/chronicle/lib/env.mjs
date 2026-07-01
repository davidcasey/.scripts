/**
 * lib/env.mjs — .env loading, path roots, and small config helpers shared by all
 * chronicle entrypoints. Call loadEnv() once at startup, then read process.env.
 */
import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

// lib/ sits one level below the chronicle project root; the repo root is two more up.
export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(PROJECT_ROOT, "..", "..");

export function expandHome(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p);
}

export function loadEnv() {
  const envPath = join(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) {
    console.error(`Missing .env at ${envPath}\nCopy .env.example and fill it in.`);
    process.exit(1);
  }
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    process.env[t.slice(0, eq).trim()] ??= t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

export function required(key) {
  if (!process.env[key]) { console.error(`Missing required env var: ${key}`); process.exit(1); }
  return process.env[key];
}

// Accounts defined in accounts.json, filtered to those whose token env var is set.
export function loadAccounts({ requireToken = true } = {}) {
  const p = join(PROJECT_ROOT, "accounts.json");
  if (!existsSync(p)) {
    if (requireToken) { console.error(`Missing accounts.json at ${p}`); process.exit(1); }
    return [];
  }
  const raw = JSON.parse(readFileSync(p, "utf8"));
  return raw.flatMap(a => {
    const token = process.env[a.tokenEnvVar];
    if (!token) {
      if (requireToken) console.log(`Skipping ${a.accountDisplayName} (${a.type}) — ${a.tokenEnvVar} not set.`);
      return [];
    }
    return [{ ...a, token }];
  });
}
