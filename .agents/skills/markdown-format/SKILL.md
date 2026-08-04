---
name: markdown-format
description: markdownlint-cli2とtextlintを繰り返し実行して、Markdownファイルをフォーマットします。
---

## 役割

このスキルは、リポジトリ内の Markdown ファイルを対象に、構文エラーの修正と日本語スタイルの校正を自動的に行います。

## 使用タイミング

- Markdown ファイルを新規作成したとき
- 既存の Markdown ファイルを編集したとき
- Markdown ファイルのフォーマットやリンターの実行を求められたとき

## 実行手順

1. 対象となる Markdown ファイルを特定します。
2. 以下のコマンドを実行して、Markdown の構文エラーを自動修正します。

   ```bash
   bunx markdownlint-cli2 --fix <path/to/file.md>
   bunx textlint --fix <path/to/file.md>
   ```

3. 以下のコマンドを実行して、手動では修正できない日本語の文章の問題を取得します。

   ```bash
   bunx textlint <path/to/file.md>
   ```

4. 手動で修正が必要な箇所を特定し、適切に修正します。

5. `markdownlint-cli2`による変更や、`textlint`によるエラー報告があった場合は、手順2と3を繰り返し実行（最大3回程度）してください。エラーが解消するか、自動修正が適用されなくなるまで繰り返します。
