# MBTI ペルソナ・ブレインストーミング(クラウド API 版)開発計画

**版**: v1.0(2026-08-05)
**本文書の目的**: AI エージェントが本計画のみを根拠に、MBTI ペルソナ・ブレインストーミングツールを一から開発できるよう、仕様・設計・手順・完了条件を自己完結的に定義する。

---

## 1. プロジェクト概要

16Personalities(MBTI 16 型)の性格を反映した複数の LLM エージェントにブレインストーミングを行わせ、単一モデルでは得られない多彩な意見を引き出す**ローカル専用 WebUI ツール**を構築する。

### 前提条件(ハード制約)

| # | 制約 |
|---|------|
| C1 | **クラウド LLM API のみ使用**。OpenAI / Anthropic / Google / xAI / Mistral を LiteLLM 経由で統一呼出する |
| C2 | **ローカル LLM 対応は実装しない**(Ollama 等のローカル推論・ローカル埋め込みモデルは対象外) |
| C3 | **torch / sentence-transformers 等の重量級 ML 依存を持ち込まない**。埋め込みが必要な処理はクラウド埋め込み API または純 Python(numpy のみ)で実現する |
| C4 | 外部公開しないローカルツール。**各 LLM の API キーはローカルマシンの環境変数から取得**し、DB・ログ・UI に一切保存・表示しない |
| C5 | **ブレインストーミング機能(後述 §3 の設計)は仕様を維持**する。削ってよいのはローカル LLM 関連のみ |

## 2. スコープ

### In Scope(実装するもの)

- 4 フェーズのブレインストーミング・オーケストレーション(§3)
- MBTI 16 型の詳細ペルソナ定義と再プライミング機構(§4)
- クラウド LLM マルチプロバイダ対応(LiteLLM、環境変数キー自動検出)
- 集団思考対策(独立発散の隔離・匿名化・初期判断非開示・悪魔の代弁者)
- 収束処理(dedup → 再合成 → LLM ジャッジのプレランク → 人間の最終決定)
- 多様性メトリクス(NDR / セマンティック分散 / collapse アラート)
- 日本語 WebUI(セッション作成 / 実行ライブビュー / 結果 / 履歴)
- SSE による逐語ストリーミング
- SQLite 永続化、Markdown/JSON エクスポート
- Mock プロバイダ(API キーなしで全機能を検証可能)
- テスト(pytest、Mock のみで完走)、README、Dockerfile、requirements.txt

### Out of Scope(実装しないもの)

- ❌ Ollama / llama.cpp / vLLM 等、ローカル推論ランタイムへの対応
- ❌ torch, sentence-transformers, transformers 等のローカル ML ライブラリ(C3)
- ❌ 認証・ユーザー管理・外部公開機能(HTTPS 終端、ドメイン割当等)
- ❌ クラウド DB / サーバレスデプロイ(SQLite で十分)

## 3. ブレインストーミング設計(維持する仕様)

研究知見に基づく設計。変更禁止。

### 3.1 セッション構造(4 フェーズ)

```
[Phase 0] Framing(ファシリテータ)
  ユーザー入力テーマ → 目的・制約・評価軸を構造化。
  Osborn の「判断遅延」ルールを全エージェントに明示
      │
[Phase 1] 独立発散(Independent Divergence)★最重要
  各ペルソナが互いの出力を見ずに N 件ずつアイデア生成(production blocking の遮断)
  生成直後にプール確定(以降の議論で上書きしない)
      │
[Phase 2] 協働議論(Collaborative Discussion)
  tit-for-tat 強度 1.0(直前の他者発言に返答)× 最大 R ラウンド(既定 2)
  匿名表示(Persona A/B…)・初期スコア非開示・悪魔の代弁者を 1 名指名
  停滞検知(全発言が短い / 同意率 90% 超)で早期終了
  目的は「洗練と新規派生」のみ。独立プールは保持
      │
[Phase 3] 収束(Convergence)
  ① embedding dedup(§6.3、cos ≥ 0.8)
  ② 再合成(ファシリテータ LLM が重複クラスタを統合・対立軸を明示)
  ③ LLM ジャッジのプレランク(Novelty/Feasibility/Clarity 1–10)
  ④ 人間が最終選定・採択メモを記録
```

### 3.2 設計の根拠(抜粋)

| 設計決定 | 根拠 |
|---|---|
| 独立発想を議論に先行 | production blocking(Diehl & Stroebe 1987)。単一 LLM の連続生成は多様性が低い(Lu et al. 2024) |
| 議論は最大 2〜3 ラウンド | 3+ ラウンドで飽和・逆効果(Estornell & Liu, ICML 2024)。tit-for-tat が安定解(Smit et al. 2023) |
| 4〜6 名の多様選抜 | 異質 2 名が同質 16 名に勝る(ahmia et al. 2025)。16 全員モードは任意機能 |
| 詳細ペルソナ + 再プライミング | 空の MBTI ラベルは性能を下げる(Tseng et al. 2024)。ドリフト対策(PersonaDrift, EACL 2026) |
| ジャッジは参考値 | LLM 採点の人間一致率は約 5 割。最終決定は人間 |

## 4. ペルソナ設計

### 4.1 ペルソナ JSON(16 型完備)

`backend/personas/mbti_16.json` に 16 型すべてを日本語で定義。各型に以下の 11 フィールド(MBTI-in-Thoughts 7 セクション準拠):

```json
{
  "type": "INTJ",
  "name_ja": "建築家",
  "core_traits": "…",
  "strengths": "…",
  "weaknesses": "…",
  "cognitive_style": "…",
  "motivations": "…",
  "behavioral_tendencies": "…",
  "communication_style": "…",
  "scenario_hint": "…(ブレスト場面での具体的振る舞い指示)",
  "output_format": "…(アイデアは箇条書き・各1〜2文・根拠1行)"
}
```

### 4.2 プロンプト構成(各ターン冒頭に再注入 = re-priming)

1. 役割宣言(「あなたは INTJ(建築家)として振る舞う」+ 7 セクション要約)
2. 場面のコンテキスト(ブレインストーミング、判断遅延ルール)
3. 具体シナリオ(セッションのテーマと制約)
4. 行動指示(フェーズごとのタスク)
5. 出力形式
6. 少量の例(任意)

### 4.3 選抜ロジック

- 手動選択 or「バランス選抜」(E/I・T/F・J/P 軸の偏り最小で 4〜6 名)
- 「16 全員モード」は任意(UI にコスト警告を表示)
- 各ペルソナに異なるプロバイダ/モデルを割当可能(モデルファミリー分散 = 多様性戦略の中核)

## 5. 技術スタック

| 層 | 採用 | 備考 |
|---|---|---|
| バックエンド | Python 3.11+, FastAPI, LiteLLM, SQLite(stdlib sqlite3) | SSE は自前実装(sse-starlette 不使用) |
| LLM 呼出 | LiteLLM `acompletion`(モデル文字列: `openai/…`, `anthropic/…`, `gemini/…`, `xai/…`, `mistral/…`) | **litellm は関数内で遅延 import**(Mock だけの動作確認環境でも起動できるように) |
| 埋め込み | ① クラウド埋め込み API(LiteLLM `aembedding`、既定 `openai/text-embedding-3-small`。利用可能キーがある場合)② なければ numpy のみの文字バイグラム TF-IDF にフォールバック | **torch 系は一切使わない(C3)** |
| フロントエンド | React 19 + Vite + TypeScript + Tailwind CSS v3 + shadcn/ui | ビルド後の静的ファイルを FastAPI が配信(SPA) |
| パッケージ | requirements.txt / Dockerfile / README.md / .env.example | Docker イメージも重量依存なしで軽量 |

## 6. プロバイダ・メトリクス・セキュリティ

### 6.1 プロバイダと環境変数(クラウドのみ)

| プロバイダ | 環境変数 | モデル例 |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | gpt-5.6-luna |
| Anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-5, claude-haiku-4-5 |
| Google | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | gemini-3.6-flash |
| xAI | `XAI_API_KEY` | grok-4.5 |
| ZAI | `ZAI_API_KEY` | GLM-5.2 |
| **Mock** | キー不要 | キー未設定時の動作確認用(§8.3) |

- 起動時/リクエスト時に環境変数を検査し、検出済みプロバイダ一覧を API で返す
- **ローカル推論の項目(Ollama 等)はプロバイダ一覧に含めない**

### 6.2 セキュリティ

- バインドは既定 `127.0.0.1`(環境変数で上書き可)
- CORS は `http://localhost:*` / `http://127.0.0.1:*` のみ
- API キーは env 参照のみ。ログにキーを出さない、DB に保存しない
- セッション実行は同時 1 件に制限

### 6.3 メトリクス(torch 不使用の実現方法)

- `dedup_ideas(texts, threshold=0.8)`:
  - 利用可能なクラウドキーがあれば LiteLLM `aembedding` で埋め込みを取得し cos 類似度でクラスタリング(モデルは環境変数 `EMBEDDING_MODEL` で上書き可、既定 `openai/text-embedding-3-small`)
  - キーがなければ **numpy のみの文字バイグラム TF-IDF** cos 類似度にフォールバック(日本語対応のため文字 n-gram)
- `semantic_dispersion`: 埋め込み重心からの平均距離(TF-IDF 時も同様)
- `non_duplicate_ratio`(NDR)、`collapse_alert`(NDR < 0.5 または分散極小)

## 7. API 契約(凍結 — フロント⇔バック並列実装の基準)

### 7.1 型(両端共通。TS interface / Pydantic model で同一形)

```ts
ProviderInfo = { id: string; label: string; available: boolean; env_var: string|null; models: string[] }
Persona = { type: string; name_ja: string; summary: string }
AgentConfig = { persona_type: string; provider: string; model: string; role: "participant" | "devils_advocate" }
SessionCreate = {
  theme: string; constraints: string;
  ideas_per_agent: number;      // 1..10, default 3
  discussion_rounds: number;    // 0..3, default 2
  agents: AgentConfig[];        // 2..16
  facilitator: { provider: string; model: string };
  enable_judge: boolean;        // default true
}
Session = {
  id: string; theme: string; constraints: string;
  status: "framing"|"divergence"|"discussion"|"convergence"|"done"|"error";
  phase_progress: string; agents: AgentConfig[]; created_at: string;
  metrics: SessionMetrics|null;
}
SessionMetrics = {
  total_ideas: number; unique_ideas: number;
  non_duplicate_ratio: number; semantic_dispersion: number; collapse_alert: boolean;
}
Idea = {
  id: string; session_id: string; persona_type: string;  // 議論由来は "DISCUSSION:<型>"
  phase: "divergence"|"discussion"; content: string;
  cluster_id: number|null; synthesized: string|null;
  scores: IdeaScores|null; decision: "pending"|"adopted"|"held"|"rejected"; note: string;
}
IdeaScores = { novelty: number; feasibility: number; clarity: number; total: number }
DecisionUpdate = { decision: "pending"|"adopted"|"held"|"rejected"; note?: string }
```

### 7.2 REST エンドポイント

| メソッド | パス | 入力 | 出力 | 説明 |
|---|---|---|---|---|
| GET | `/api/providers` | — | `{ providers: ProviderInfo[] }` | 環境変数検出結果 |
| GET | `/api/personas` | — | `{ personas: Persona[] }` | 16 型一覧 |
| POST | `/api/sessions` | `SessionCreate` | `Session`(201) | 作成 |
| POST | `/api/sessions/{id}/start` | — | 202 | 実行開始(非同期) |
| GET | `/api/sessions/{id}` | — | `Session` | 状態・メトリクス |
| GET | `/api/sessions/{id}/ideas` | — | `{ ideas: Idea[] }` | アイデア全件 |
| PATCH | `/api/ideas/{id}/decision` | `DecisionUpdate` | `Idea` | 人間の最終決定 |
| GET | `/api/sessions` | — | `{ sessions: Session[] }` | 履歴 |
| GET | `/api/sessions/{id}/export` | `?format=md|json` | ファイル | エクスポート |

### 7.3 SSE ストリーム

`GET /api/sessions/{id}/stream` — `text/event-stream`。イベント(すべて JSON data):

```jsonc
{ "type": "phase",       "phase": "divergence", "label": "独立発散フェーズ" }
{ "type": "agent_start", "agent": "INTJ", "round": 1, "task": "ideate" }
{ "type": "token",       "agent": "INTJ", "round": 1, "delta": "…" }
{ "type": "agent_done",  "agent": "INTJ", "round": 1 }
{ "type": "idea",        "idea": Idea }                    // 確定時 + 収束での更新時の2回送られる
{ "type": "message",     "round": 2, "from": "Persona A", "content": "…" }
{ "type": "metrics",     "metrics": SessionMetrics }
{ "type": "phase",       "phase": "done" }
{ "type": "error",       "message": "…" }
```

- 接続はセッション 1 つにつき 1 本。`done`/`error` で終了
- **完了済みセッションへの接続時は DB から phase/ideas/messages/metrics をリプレイ**して終了
- 進行中セッションは購読者ごとのキューに履歴シード + ライブ転送(§9 の落とし穴 P1 参照)

### 7.4 DB スキーマ(SQLite)

```sql
sessions(id TEXT PK, theme TEXT, constraints TEXT, config_json TEXT,
         status TEXT, phase_progress TEXT, metrics_json TEXT, created_at TEXT);
ideas(id TEXT PK, session_id TEXT, persona_type TEXT, phase TEXT, content TEXT,
      cluster_id INT, synthesized TEXT, scores_json TEXT, decision TEXT, note TEXT,
      created_at TEXT);
messages(id TEXT PK, session_id TEXT, round INT, anon_name TEXT, persona_type TEXT,
         content TEXT, created_at TEXT);
```

## 8. 画面仕様(日本語 UI、4 ビュー)

1. **セッション作成** `/`: テーマ・制約入力、16 型ペルソナグリッド(4 グループ色チップ: 分析家 #88619a / 外交官 #33a474 / 番人 #4298b4 / 探検家 #e4ae3a)、バランス選抜ボタン、16 全員モード(コスト警告付き)、ペルソナごとのプロバイダ/モデル割当(available のみ選択可、未検出は「環境変数 XXX 未設定」グレー表示)、パラメータ(ideas_per_agent 1..10 既定3 / discussion_rounds 0..3 既定2 / enable_judge 既定ON / ファシリテータ)
2. **セッション実行** `/session/:id`: フェーズステッパー(日本語 5 段階)、エージェント別カードに token 逐語追記、議論ログ(匿名名・ラウンド表示)、確定アイデア逐次追加、メトリクスタイル、collapse 時の警告バナー
3. **結果** `/session/:id/results`: クラスタ別アイデア一覧、再合成テキスト、スコアバッジ + 「LLM採点は参考値(人間一致約5割)」注記、採択/保留/却下 + メモ(PATCH)、md/json エクスポート
4. **履歴** `/history`: セッション一覧(テーマ・日時・ステータス・メトリクス概要)

### 8.1 デザイン方針

ローカル作業ツールの機能美。低彩度・暖色ニュートラル基調・余白多め・青紫グラデーション禁止。shadcn/ui 活用。

### 8.2 フロントエンドの API 実装

- `src/lib/api.ts` に §7.1 の型と fetch/EventSource ラッパ
- API ベースは相対パス `/api`。Vite dev 時は `server.proxy` で `http://127.0.0.1:8787` へ
- SSE 切断時 1 回だけ自動再接続(再接続時は逐語/ログ系 state をリセット)

### 8.3 Mock プロバイダ仕様

- 常時 available。モデル名 `mock`
- ペルソナ型・テーマ・アイデア番号・ラウンドを組み込んだ**決定論的な日本語ダミー応答**(アイデア間で十分に異なる文面にし、dedup で全滅しないこと)
- トークン分割して 0.01 秒間隔で yield(ストリーミングの検証用)

## 9. 実装上の落とし穴(先行開発で実際に発生したバグ — 必ず回避すること)

| # | 落とし穴 | 回避策 |
|---|---|---|
| P1 | **SSE の共有キュー 1 本方式**だと複数接続・再接続時にイベント取り合い/欠落し、DB リプレイとの二重送信も起きる | セッションごとに履歴リスト + 購読者ごとのキューへファンアウト。購読時は履歴シード済みの専用キューを発行。完了後は履歴破棄 → DB リプレイに切替 |
| P2 | **idea イベントは作成時 + 収束更新時の 2 回**送られる | フロントは id で upsert する(初回は追加、2 回目は cluster_id/scores を更新) |
| P3 | **SPA の深いリンク(/session/:id)が 404** | FastAPI の StaticFiles フォールバックは `starlette.exceptions.HTTPException`(404)を catch して index.html を返す(fastapi.HTTPException では starlette 側を捕まえられない) |
| P4 | **Vite の `base: './'`** だと深いルートで assets が相対解決され JS が読めず白紙 | `base: '/'` にする |
| P5 | **完了セッションのリプレイで phase=done が先頭**に来るのに、フロントが done 受信で即 `EventSource.close()` → 後続の ideas/messages/metrics が破棄される | done/error 受信時はフラグを立てるだけで close しない(サーバ側の切断に任せる) |
| P6 | litellm 未インストール環境で Mock すら動かない | litellm は呼出関数内で遅延 import |
| P7 | 完了済みセッション再表示でエージェントカードが「待機中」のまま | フェーズ done 時はカード状態を「完了」扱いにし、「逐語再生なし」の注記を出す |

## 10. 開発フェーズ(AI エージェントへの作業指示)

### Phase A: 基盤整備

- リポジトリ初期化(git)、`docs/実装方針.md` 相当として本計画 §3〜§7 を `SPEC.md` として配置
- フロントエンド雛形(Vite + React + TS + Tailwind + shadcn/ui)を `frontend/` に構築
- **完了条件**: 雛形がビルドできる、SPEC.md がリポジトリにある

### Phase B: バックエンド実装

- `backend/`: models.py(§7.1)、db.py(§7.4)、personas.py + personas/mbti_16.json(§4)、providers.py(§6.1、litellm 遅延 import、Mock)、metrics.py(§6.3)、orchestrator.py(§3、§9-P1)、main.py(§7.2、§7.3、SPA 配信 §9-P3)
- **完了条件**: `python -m pytest backend/tests -q` が全パス(§11 のテスト仕様)

### Phase C: フロントエンド実装

- §8 の 4 ビュー + `src/lib/api.ts`(§7.1 を TS 化)+ デザイン(§8.1)
- **完了条件**: `npm run build` 成功(TS エラーなし)

### Phase D: 統合・E2E 検証

- フロントをビルドし FastAPI から配信。Mock のみでセッション作成 → 実行 → 結果 → 履歴 → エクスポートまで通す
- 実ブラウザ(または相当の手段)で 4 ビューの描画と SSE ライブ動作を確認
- **完了条件**: §11.2 の E2E チェックリスト全項目 OK

### Phase E: パッケージング

- README.md(起動手順・環境変数表・Mock 動作・Docker・テスト・既知の制限)、.env.example、Dockerfile(marstage: node でフロントビルド → python:3.12-slim で配信)、requirements.txt
- **完了条件**: クリーン環境で README 手順どおりに起動できる

## 11. テスト計画

### 11.1 pytest(Mock のみで完走。外部 API・litellm 不要)

1. プロバイダ検出: Mock は常時 available、env 未設定のクラウド各社は unavailable、キー設定で available 化
2. ペルソナ JSON: 16 型 × 必須 11 フィールド完備
3. バランス選抜: E/I・T/F・J/P 軸の偏りが最小化される
4. E2E: セッション作成(3 名 Mock、ideas 2、rounds 2)→ start → done → divergence アイデア 6 件以上・全件スコア/クラスタ付き・メトリクスあり → decision PATCH → export md/json
5. SSE: 進行中接続で idea イベントが各 id 最大 2 回(作成+更新)で DB 最終状態と一致 / 2 購読者で同一集合を受信(§9-P1)
6. SPA フォールバック: 存在しないパスで index.html が返る(§9-P3)

### 11.2 E2E チェックリスト(Mock プロバイダ、実ブラウザ)

- [ ] セッション作成画面でバランス選抜 → 全員 Mock 割当 → 開始
- [ ] 実行画面: ステッパー進行・逐語ストリーム・匿名議論ログ・メトリクス表示
- [ ] 結果画面: クラスタ/再合成/スコアバッジ/採択ボタン/エクスポート
- [ ] 履歴画面: 完了セッションが表示され、再訪で DB リプレイが正しく描画される

## 12. ディレクトリ構成

```
mbti-brainstorm/
├─ SPEC.md                # 本計画 §3〜§7 相当
├─ backend/
│  ├─ main.py             # FastAPI(静的配信 + API + SSE)
│  ├─ orchestrator.py     # 4 フェーズ進行(ファンアウト SSE)
│  ├─ providers.py        # LiteLLM ラッパ(遅延 import) + env 検出 + Mock
│  ├─ personas.py         # ペルソナ読込・バランス選抜
│  ├─ metrics.py          # クラウド埋め込み / numpy TF-IDF フォールバック
│  ├─ db.py               # SQLite(stdlib sqlite3)
│  ├─ models.py           # Pydantic モデル(§7.1)
│  ├─ personas/mbti_16.json
│  └─ tests/test_backend.py
├─ frontend/              # Vite + React + TS + Tailwind + shadcn/ui
├─ requirements.txt       # fastapi, uvicorn[standard], pydantic, numpy, litellm
├─ .env.example
├─ Dockerfile
└─ README.md
```

## 13. 納品物

1. 上記構成のソース一式(zip または git リポジトリ)
2. README.md(日本語、起動手順・環境変数表)
3. テスト実行結果(§11.1 全パス)
4. E2E チェックリスト(§11.2)の実施記録

## 14. 補足: 元版からの差分(変更点の明示)

| 項目 | 元版 | 本計画(クラウド API 版) |
|---|---|---|
| ローカル推論 | Ollama 対応あり | **削除** |
| 埋め込み | sentence-transformers(all-MiniLM-L6-v2、torch 依存)→ TF-IDF フォールバック | **クラウド埋め込み API(LiteLLM aembedding)→ numpy TF-IDF フォールバック** |
| 依存 | sentence-transformers を含む | **torch 系なし。requirements は 5 パッケージのみ** |
| ブレインストーミング機能 | 4 フェーズ/ペルソナ/議論/集約/評価 | **同一仕様を維持(§3)** |
