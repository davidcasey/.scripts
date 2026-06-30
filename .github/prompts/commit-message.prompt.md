---
description: Generate a single-line conventional commit message for staged or modified files.
---

Run `git diff --staged --stat` to find staged files.
If nothing is staged, run `git diff --stat` to find modified files.
Then run the appropriate diff (`git diff --staged` or `git diff`) to read the actual changes.

Write one commit message following these rules (derived from `@commitlint/config-conventional`):

- Format: `type(optional-scope): subject` — scope is almost never needed; omit it
- Valid types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`
- All lowercase — type and subject
- Imperative mood: "add" not "adds" or "added"
- Under 100 characters total
- No period at the end
- No filler words: do not start with "update," "modify," or "change"
- No AI attribution, co-authored-by, or meta-commentary
- Base the message on what the diff actually does, not just the filenames
- If this prompt is running in an active coding session, also use the conversation context to capture intent that the diff alone doesn't express

Output the final message wrapped in a fenced code block — no explanation.
