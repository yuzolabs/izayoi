# Agent Instructions

## Commit

Don't use `git commit --no-verify`.

## Commit Message

Commit messages must be written in **English** and follow the Conventional Commits.

Format:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

- `type`: one of `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`
- `scope`: optional, a noun describing the affected area of the codebase
- `description`: a short summary of the change in the imperative mood (e.g. "add feature", not "added feature")
- `body`: optional, explain *what* and *why* (not *how*), wrap at ~72 characters
- `footer`: optional, e.g. `BREAKING CHANGE: <description>` to note breaking changes, or `Closes #123` for issue references

Examples:

```
feat(api): add endpoint to export user data
```

```
fix: prevent crash on empty input

Closes #42
```

```
refactor(parser)!: rename `parseTokens` to `lex`

BREAKING CHANGE: the public `parseTokens` function is now `lex`.
```
