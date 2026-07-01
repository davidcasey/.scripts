/**
 * lib/obsidian.mjs — shared helpers for reading/writing the Obsidian vault.
 */

// Checked items under a note's "## TODO" section: "- [x] ...".
export function parseCheckedTodos(content) {
  const items = [];
  let inTodo = false;
  for (const line of content.split("\n")) {
    if (/^## TODO\s*$/.test(line)) { inTodo = true; continue; }
    if (inTodo && /^## /.test(line)) break;
    if (inTodo && /^- \[x\]/i.test(line)) items.push(line.replace(/^- \[x\]\s*/i, "").trim());
  }
  return items.filter(Boolean);
}
