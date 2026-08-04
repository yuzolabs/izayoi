---
description: Markdownファイルが新規作成、編集された時に整形を行う
mode: subagent
model: github-copilot/gemini-3-flash-preview
permissions:
  read: allow
  list: allow
  bash: {
    "*": "deny",
    "ls": "allow",
    "bun install": "allow",
    "bun install --frozen-lockfile": "allow",
    "bunx markdownlint-cli2": "allow",
    "bunx markdownlint-cli2 --fix": "allow",
    "bunx textlint": "allow",
    "bunx textlint --fix": "allow",
  }
  edit: allow

---

指定された Markdown ファイルに対して、markdown-format スキルを使用してフォーマットを実行します。
