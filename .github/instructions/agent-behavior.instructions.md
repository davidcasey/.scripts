---
applyTo: '**/*'
---

## Agent Behavior

### Git and publishing

- **Never run `git commit`, `git push`, or any destructive or hard-to-reverse git operation without explicit user confirmation.** Generate a commit message and stop — the user commits and pushes.
- Treat `git push`, `git reset --hard`, `git push --force`, and branch deletion the same as `rm -rf`: always ask first.
- Never use `--no-verify` on git commands. Do not bypass husky hooks or commitlint.
- Never run `pnpm publish` or `npm publish` without explicit confirmation.

### File and directory operations

- Never delete files or directories without explicit confirmation.
- Never comment on PRs, issues, or any shared communication without explicit confirmation.

### Terminal and scripts

- Never run `pnpm install`, builds, or scripts with side effects (deploy scripts, manifest updates, port assignments) unless directly asked or clearly required by the immediate task.
- When a terminal command would affect a shared file (`ports.json`, `mfe-manifest.json`, CI config), flag the blast radius before running it.
- Do not chain commands that go further than the immediate task.

### Scope

- Only change what was asked. Do not refactor, reformat, or improve adjacent code unless explicitly requested.
- Do not touch files outside the direct scope of the task — even if they seem related.
- When "make it work" is ambiguous, do the minimum necessary change and confirm before going further.
