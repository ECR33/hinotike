# スキャン機能拡張: 記録モード(配布・チェックイン・任意の確認)設計案

対象: `/home/kenji/dev/hinotike`(Nuxt 4 + Supabase + Google Sheets)
目的: QRスキャンを「照会」だけでなく「確認した証跡の記録」にも使えるようにする。
状態: **実装済み(2026-11-16)**. Phase1〜4まで入った(実装の最終状態は下の §10)。README の方針(シートが正・RLS は登録ユーザ・Secret key 不使用)はそのまま踏襲している。

---

## 1. 要求と既存の土台

| 要求 | 既存で使えるもの | 追加するもの |
|---|---|---|
| 配布時にQRを読んで「配布した」マーク | `/scan` + `app/components/QrScanner.vue`(qr-scanner の連続スキャン、12 scans/s、50%/25%枠) | 検出1回で停止する挙動を**連続モード**にする(同一コードの重複除外＋クールダウン) |
| 来場時にQRを読んで「来場した」記録 | 同上 | 記録モード用の API と画面の状態(カウンタ・件リスト) |
| QRを読み取って確認した証跡を記録 | `items` / `users` / RLS(`is_registered_user()`) | **`scan_events`**(誰が・いつ・どのモード・結果。シートセルは1値しか残らないので履歴の正はDB) |
| モードにより連続して次々読み込む | ライブラリはもともと連続スキャン(停止処理だけが `handled` フラグで入っている) | `continuous` prop + 重複除外 + in-flight 中の同一コード無視 |
| 記録を spreadsheet のカラムに書き戻す | `server/utils/googleSheets.ts` の `updateCellValue`(values.update / RAW・編集スコープ)、`server/api/remark-update.post.ts` の **code → 行番号探索**(`normalizeHeaders` / `sourceColumnFor` / `a1Cell`) | **ヘッダー＋code→行番号のキャッシュ**(1回だけシートを読む)と **バッチ書き込み**(`values:batchUpdate`) |
| どの機能としてどのカラムに書くかを設定し、動的に増減 | `public.sync_settings`(singleton行・UI編集・`updated_by` 監査)と同じ形 | **`scan_modes`**(1行1モード、RLS は `sync_settings` と同じポリシー形状、行の insert/delete で増減) |
| 済/未 の文字列と日時を両方残す(表示は簡単、履歴は日時付きで監査) | payload の任意キー表示・絞り込み(`GET /api/items-keys` のキー発見)がそのまま追随する | **済/未列 + 日時列**をシートと payload に書く。表示の正規化は `recordState()`、日時付き履歴は `scan_events` → `/records`・`/result` |
| シートに無い列を管理者追加だけでなくスキャン画面から作れる | `sync_settings.include_columns` の UI 編集、シートの読み取り(`/api/sync-preview` の headers) | `POST /api/scan-columns`(`spreadsheets.batchUpdate` の `appendDimension` + ヘッダーの `values.update`)と `/scan` の「新しい記録を作る」パネル / `/scan-settings` の「シートの列を追加」 |
| 来場は氏名表示＋「確認/記録」ボタン、棚卸しは確認なしで次々 | `/register` の preview→確認→approve の二段階 UI が「氏名/情報を確認してから確定」の既存 precedent | モードの `confirm_before_record` フラグ(pending card の「記録」/「見送り」 vs 自動記録) |

### 作らなくてよいもの
- チケット専用テーブル。QRの値は `items.code`(=`sync_settings.code_column` の値)としてそのまま扱える。配布/来場は「シートのカラム」で表現し、`items.payload` に同じキーを反映すれば `/items` の絞り込み・表示キー選択と `/result` の表示が**コード変更に追随して**使える(既存の任意 payload キーの仕組みがそのまま流用できる)。
- 新しい認証・権限系統。`requireRegisteredUser` と RLS をそのまま使う。

---

## 2. データモデル(マイグレーション 0006_scan_modes.sql 案)

実行順は既存と同じ(テーブル → ポリシー → grant → シード)。`is_registered_user()` は 0001 で作成済み。

```sql
-- スキャンの記録モード(1行 = 1モード。/scan の選択と管理画面から増減する)
create table if not exists public.scan_modes (
  id serial primary key,
  name text not null unique,
  -- [{ column, column_at, literal, payload_key, payload_at_key }]
  --   column        : 済/未 フラグ列のシートヘッダー名(rename 前の実名。remark-update と同じ基準)
  --   column_at     : 読み込み日時を書く列のシートヘッダー名(省略 = フラグ列のみ)
  --   literal       : 固定値で書くときの値(既定は '済'。未に戻すときは clear で空にする)
  --   payload_key   : items payload に反映するフラグキー(省略 = シートだけ)
  --   payload_at_key: items payload に反映する日時キー(省略 = シートだけ)
  -- 書く値は「日時 + 済/未 の2本」を既定とする(§10 の確定回答)。
  -- フラグ列を持たないモードは日時だけ書き、表示側は「日時があれば済」で導出する(`recordState()`)。
  actions jsonb not null default '[]'::jsonb,
  -- 重複QRの扱い: 'warn'(記録しつつ警告) | 'skip'(記録しない) | 'allow'(記録する)
  dedupe text not null default 'warn' check (dedupe in ('warn','skip','allow')),
  -- true = 氏名を確認してから記録(来場・チェックイン)。false = 読み取った順にそのまま記録(棚卸し・配布)
  confirm_before_record boolean not null default false,
  -- items に見つからない code を拒否するか(false = シート行があれば書き込み可)
  require_found boolean not null default true,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.scan_modes enable row level security;
create policy "scan_modes_select_registered" on public.scan_modes for select
  to authenticated using (public.is_registered_user());
create policy "scan_modes_insert_registered" on public.scan_modes for insert
  to authenticated with check (public.is_registered_user());
create policy "scan_modes_update_registered" on public.scan_modes for update
  to authenticated using (public.is_registered_user()) with check (public.is_registered_user());
create policy "scan_modes_delete_registered" on public.scan_modes for delete
  to authenticated using (public.is_registered_user());
grant select, insert, update, delete on table public.scan_modes to authenticated;

-- 証跡(不変の履歴。update/delete ポリシーを作らない)
create table if not exists public.scan_events (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  mode_id integer references public.scan_modes(id) on delete restrict,
  mode_name text not null,          -- モード削除後も証跡が読めるように写す
  actor_email text,
  status text not null check (status in ('ok','duplicate','not_found','sheet_missing','write_failed','skipped')),
  written jsonb not null default '{}'::jsonb,  -- { "来場済": "済", "来場日時": "2026-11-16 09:02 (JST)" }
  sheet_range text,
  at timestamptz not null default now()
);

alter table public.scan_events enable row level security;
create policy "scan_events_select_registered" on public.scan_events for select
  to authenticated using (public.is_registered_user());
create policy "scan_events_insert_registered" on public.scan_events for insert
  to authenticated with check (public.is_registered_user());
grant select, insert on table public.scan_events to authenticated;
create index if not exists scan_events_code_at_idx on public.scan_events (code, at desc);
```

### シード(既定の2モード)

```sql
insert into public.scan_modes (name, actions, dedupe, confirm_before_record)
values
  ('チケット配布',  '[{"column":"配布済","column_at":"配布日時","literal":"済","payload_key":"配布済","payload_at_key":"配布日時"}]'::jsonb, 'warn', false),
  ('チェックイン',  '[{"column":"来場済","column_at":"来場日時","literal":"済","payload_key":"来場済","payload_at_key":"来場日時"}]'::jsonb, 'warn', true)
on conflict (name) do nothing;
```

シードの2モードは**既定のプリセット**で、管理者が列を事前に追加していてもいなくてもよい(§3 の列作成 API で `/scan` から列を作れる)。既定は「列が無いときは作成を提案する」(黙って 400 にしない)。

---

## 3. API 設計(preview / commit の二段階 — sync と同じ慣習)

### `GET/POST /api/scan-config`(既存 `/api/sync-config` と同じ形)
- `GET` → `{ modes: ScanMode[], serviceAccountConfigured, updatedBy, updatedAt }`
- `POST` → モードの保存(新規は id なし、削除は `deleteModeId`。normalize は項目単位で補正し throw しない = sync-config と同じ方針)

### `POST /api/scan-check`(読み取り専用。連続スキャンの即時フィードバック)
body `{ modeId, code }` →
```
{ code, status: 'ok'|'duplicate'|'not_found'|'sheet_missing', name, written?: {...} }
```
- items を code で照会(`found` と 氏名)、payload の該当キーで**重複判定**
- シートの code→行番号マップ(キャッシュ)で `sheet_missing` を判定(**書き込まない**)
- 1件あたり DB 照会 + 初回のみシート読み → 数百件でも数秒で回る

### `POST /api/scan-flush`(確定。シート書き込み + 証跡)
body `{ modeId, codes: string[] }` → `{ results: [...], sheetTitle, ranges, dbUpdated, wrote: n }`
- 権限は `requireRegisteredUser`(認証を先に確認する順序は remark-update と同じ)
- シート読み → ヘッダー検証(モードの column が無い→ `column_missing` + ヘッダー一覧。列作成の案内を出す)
- `updateCells()`(`values:batchUpdate`、100 range/chunk)で**まとめて**書き込み(フラグ列と日時列を1リクエストにまとめる)
- 書き込み順は**シート → items payload**(シートが正。DB更新だけが失敗したら `dbUpdated: false` を返す = remark-update と同じ)
- `scan_events` を status ごとに insert(dedupe='skip' の重複は `skipped` を書くだけ)

### `POST /api/scan-columns`(シートに記録列を作る — `/scan` の「記録を作る」から叩く)
body `{ columns: string[], addToIncludeColumns?: boolean }` → `{ created: [...], existing: [...], sheetTitle, headers, includeColumnsUpdated }`
- 列追加は `spreadsheets.batchUpdate` の `appendDimension`(dimension=COLUMNS, length=本数)を自前 fetch で叩く(`server/utils/googleSheets.ts` に `appendColumns()` を追加。編集スコープの token を都度取得する既存 `updateCellValue` と同じ経路)。values.update の範囲外書き込みでグリッドが拡張される挙動に頼らず、**columnCount を読んでから明示的に拡張**する。`addDimensionRange` はこの endpoint のリクエストには存在しないので 400(Unknown name)になる(実測で確認した。シート単位の `sheets/{sheetId}:batchUpdate` の SheetContentRequest 側なので、spreadsheet 単位では `appendDimension` を使う)
- 追加後、その列のヘッダーセルを `values.update`(RAW)で書く
- `addToIncludeColumns: true` のとき `sync_settings.include_columns` に追記する(§5 の「次回同期で payload が消える」問題を防ぐ。既定 true で提案し、画面で選択できるようにする)
- 既存ヘッダーに同名があるときは `existing` を返して作らない(重複列を作らない)

### `GET /api/scan-history`(監査用の記録履歴)
- query `{ mode?, code?, from?, to?, cursor?, limit? }` → `{ rows: [{ code, mode_name, actor_email, status, written, at, sheetRange }], nextCursor }`
- 分页は `/api/items-list` と同じキーセットカーソル(`id` 降順で `id < cursor`)。日時は JST 表記を手計算で出す(README の SSR/クライアント一致方針)
- `/result` にも「このコードの記録履歴」小节を出す(`?code=` で絞る)。来場/配布の**いつ読み込んだか**の履歴はここが正(シートセルは1値しか残らない)

### 書く値と表示の変換(確定)
- シートには **済/未 のフラグ列** と **日時列** の2本を書く(日時列を省略するモードも可)
- payload にも同じ2キーを反映するので `/items` の任意キー絞り込み(有無・値 chip・部分一致)と `/result` の表示が**コード変更に追随して**使える
- 表示は `shared/utils/items.ts` に `recordState(payload, flagKey, atKey)` を追加して `済 | 未` に正規化する(フラグの値が '済'/'未'/`true`/空 どれでも済み扱い/未扱いになる)。日時があるのにフラグが空の行は「済(日時)」として出す
- 日時文字列は新 `shared/utils/scan.ts` の**手計算 JST**(`formatJstLocal(iso)` → `2026-11-16 09:02 (JST)`)で出す。`toLocaleString` は ICU 差で hydration mismatch の原因になるため使わない(README の既存方針)。DB の `scan_events.at` は timestamptz 保存で、表示だけ JST に揃える

---

## 4. クライアント(QrScanner と /scan)の改造

### `app/components/QrScanner.vue`
- `continuous?: boolean` prop を追加。true のとき `onDecode` で **stop しない**
- 重複除外: `lastCode` + `lastAt`(同一コードは 2.5s 間無視)、`inFlight` のコードも無視(書き込み中に同じQRを読んで二重記録するのを防ぐ)
- emit は `detected(code)` のまま(既存 `/register`・`/scan` の1回停止モードは default false で影響なし)
- 状態文言をモードに合わせて変える(`statusText(mode)`)/ 件数は上位ページが保持する
- 1回停止モードと連続モードの切替は `key` の再マウントで済ませる(`/register` の既存手法)

### `app/pages/scan.vue`
- モードチップ行を `/api/scan-config` から描画(「照会(従来)」を常に先頭に固定)
- 記録モードの画面構成:
  - カメラ枠(従来そのまま)+ 範囲選択50%/25%(従来そのまま)
  - **記録セッション欄**: `このセッション N件` / 最終読み取り時刻 / 直近の件リスト(氏名・code・状態 badge: 記録 / 重複(2回目) / 見つかりません / シート行なし)
  - 「書き込みを確定」ボタン + 自動flush(**連続モードは5件ためたら自動**。確認モードは記録ボタン押下時にその場で flush — 確認したのに5件ためになるまで書されないのは不自然なので)
  - 停止ボタンで停止時 flush
- **記録の作り直し(`/scan` から)**: 「新しい記録を作る」パネルで 名前 + 済/未列名 + 日時列名 + 連続/確認 を決める → 列がシートのヘッダーに無いときは「シートに列を追加」(`/api/scan-columns`)を提案し、追加後にそのまま連続スキャンを開始できる(「こういうことを記録していく」をその場で開始する運用)
- **確認モード(`confirm_before_record = true`)**: 読み取ると** pending card** が出る(氏名・年組・code・現在の状態「未」or「済み(日時)」)。「記録」/「見送り」ボタンで確定(**記録ボタンで1件を確定したら即 flush**してシートに書く)。次のQRを読むと pending は置き換わる(置き換えた pending は未記録のまま = 見送り扱い)。来場者を1人ずつ確認しながら進める運用はこれ
- **連続モード(`confirm_before_record = false`)**: 読み取った順にそのまま pending 無しで記録して次々進む(棚卸し・配布)。重複QRは警告だけ出し、自動では上書きしない(dedupe 設定に従う)
- 状態は `useState` + `definePageMeta({ keepalive: true })`(既存 `/items` と同じ)で、`/items` や `/result` に回ってもセッションが残る
- 照会モードは従来どおり `/result` へ遷移する。記録モードは遷移せず連続
- `hinotike-registration:` のQRは記録モードでは弾く(`shared/utils/registration.ts` の `parseRegistrationCode` を再利用)

### 記録履歴の閲覧(監査)
- `/records`(記録履歴)ページを新規追加(保護はグローバル middleware が自動で守る)。モード・code・期間で絞り込み、1行に `氏名 / code / モード / 状態 / 日時(JST) / 記録した人 の email` を出す
- `/result` に「このコードの記録履歴」小节を出す(来場・配布をいつ読んだかの履歴がそのまま見える)
- BottomNav の「管理」dropdown に「記録履歴(`/records`)」と「スキャン記録の設定」を追加する(常駐バーの項目数は増やさない — 既存の dropdown 集約方針どおり)

### BottomNav
項目は増やさない(`/scan` 内のモード選択なので記録もスキャンの延長 = 点灯は `/scan` のまま)。管理 dropdown に「スキャン記録の設定」を入れるか、`/sync` に「記録モード」欄を追加する(§5)。

---

## 5. 設定画面(動的増減)

`app/pages/sync.vue` に「スキャン記録」欄を増やすか、`app/pages/scan-modes.vue` を作る(保護はグローバル middleware が自動で守る)。

- モードのリスト(行の追加/削除が可能 = **動的増減**)
- 各モード: 名前 / 済/未列(シートヘッダー名を select or 入力)/ 日時列(省略可)/ payload に反映するキー2つ / 確認の有无(来場・チェックイン=確認, 棚卸し・配布=連続)/ 重複の扱い / items に見つからない code を拒否
- カラム候補は `/api/scan-preview` の `headers` と同じシート読みから出す(既存プレビューが既にヘッダー一覧を返している)。**候補に無い名前を選ぶと「列を追加」を選択できる**(`POST /api/scan-columns`)
- 保存は `/api/scan-config` POST、`updated_by` に email を記す(sync_settings と同じ監査)
- **入口は2つ**: 管理画面(`/sync` の「スキャン記録」欄 or `app/pages/scan-modes.vue`)と、`/scan` の「新しい記録を作る」パネル(その場で記録を始めてよい運用なので、こちらが主入口)。同じ API を両方から叩く

### payload への反映と同期の相互作用(重要)
`upsertRows` は payload を**丸ごと**書き換える。したがって記録したキーを次回同期後も残すには、その列を `sync_settings.include_columns` に追加する必要がある(既存UIの改行リストで1行足すだけ)。追加しないと「シートには残るが、確定同期で payload から消える」状態になる。画面ではモード保存時に「この列は取り込みカラムにありません」と注記を出す(黙って消える状態を作らない)。

---

## 6. 想定した運用イメージ

### A. チェックイン(確認付き: 1人ずつ氏名を見て記録)

```
/scan → モード「チェックイン」選択 → カメラ連続
  読み取り1    : pending「山田太郎 (1年3組) — 未」 → 「記録」 → 来場済=済 / 来場日時=2026-11-16 09:02 (JST)   [1件]
  読み取り2    : pending「鈴木花子 (2年1組) — 未」 → 「記録」                                                  [2件]
  読み取り3    : pending「山田太郎 — 済み(09:02)」 → 警告「2回目」 + 「上書き」/「見送り」                    [2件・重複1]
  読み取り4    : XXXXXXXX → 見つかりません(再同期が必要)                                                      [2件・不明1]
  「書き込みを確定」 → シート 'フォームの回答 1'!D12,E12 他 / scan_events 4行(履歴は /records で閲覧)
```

### B. 棚卸し・配布(連続: 確認なしで次々と)

```
/scan → モード「チケット配布」選択(連続) → カメラ連続
  読み取り1    : 山田太郎 → 記録(配布済=済 / 配布日時=10:24 (JST))    [1件]
  読み取り2    : 鈴木花子 → 記録                                      [2件]
  読み取り3    : 山田太郎 → 重複(skip 設定なら記録しない・warn なら上書きしない警告のみ)
  自動flush(連続は5件 / 確認モードは記録ボタンで即時) → シートへ一括書き込み / scan_events に記録
  終了 → /records でこのセッションの件数と時刻を確認
```

任意モードは「こういうことを確認した」をその場で作る(名前 + 済/未列 + 日時列 + 連続/確認)→ 列が無ければ追加 → 連続スキャン開始。

---

## 7. 制約・リスク(正直な一覧)

- **シートの編集権限**: 備考編集と同じく、サービスアカウントが対象シートを編集者以上で共有していないと 403。README の制約そのまま。
- **レイテンシ**: check は DB 照会中心で速い。flush はバッチで 1〜2秒程度。シート全読みを1件ごとにやる案は却下(1件 0.5〜1s × 数百件で quota と待ち時間がきつい)。
- **同時スキャン**: 2人が同じチケットを読むとシートは後勝ち(シートはトランザクション非対応)。`scan_events` に両方の履歴が残るので証跡としては壊れない。
- **`prune_on_commit`**: シートから行が消えると items 行も削除されるため、配布/来場記録(payload)も消える。シートは残るので再同期で復活するが、運用ルールとして「記録後にシート行を削除しない」を明記する。
- **列がヘッダーに無い**: `/api/scan-columns` で列を作る(`appendDimension` + ヘッダーの `values.update`)。values.update の範囲外書き込みによるグリッド自動拡張には頼らない(明示的に columnCount を読んで拡張する)。列名が既存ヘッダーと衝突する場合は作らず `existing` を返す
- **オフライン**: 現在 SW は API をキャッシュしない方針なので、通信失敗時はクライアントのメモリ上の待機列で再送する(既定)。localStorage に永続待機列を作る案は任意の追加
- **連続スキャンの誤読**: ライブラリは壊れたQRを swallow する(既存)が、隣のQRを捉える誤りは残る。確認モード(氏名を出してから記録)が誤読の安全弁になる。棚卸し的な連続運用では誤読がそのまま記録になるので、終了時に `/records` で確認する運用を推奨
- **タイムゾーン**: シートに書く日時文字列は JST で統一し、DB の `scan_events.at` は timestamptz 保存。レポートでは JST 表記に揃える

---

## 8. 段階導入と工目

| Phase | 内容 | 目安 |
|---|---|---|
| 1 | 連続スキャン(`continuous`) + モード選択 + 記録(済/未 + 日時) + `scan_modes`/`scan_events` + flush(バッチ) | 2〜3日 |
| 2 | `/scan` から記録モードを作る(動的増減)+ シート列の作成(`appendColumns`)+ include_columns への追記 | 2日 |
| 3 | 確認モード(pending card の「記録」/「見送り」)+ 重複の扱い | 1日 |
| 4 | 記録履歴 `/records` + `/result` の履歴小节(`GET /api/scan-history`) | 1〜2日 |
| 任意 | オフラインの待機列、記録の CSV エクスポート | 1〜2日 |

### テスト案
- 単体(`test/unit/scan.test.ts`): モードの normalize(actions の不正補正)、JST 文字列の手計算、dedupe の時間窓ロジック、QR値の namespace 判定
- Supabase 統合(`test/supabase/scan-flow.test.ts`): `scan_modes` の RLS(登録ユーザのみ閲覧・増減)、`scan_events` の insert+select、モード削除後も event が残る(restrict)
- UI 検証(`scripts/verify-scan-record.mjs`): `verify-scan-detect.mjs` の fake カメラ(canvas.captureStream でQR画像を流す)を**複数 code の連続投入**に拡張し、件カウンタ・重複警告・flush後のシート参照を確認

---

## 9. 決定事項(2026-11-16 の回答に基づく確定)

1. **書く値 = 日時 + 済/未 の2本**。シートは済/未列と日時列を持ち、payload にも2キーを反映する。表示は `recordState()` で `済 | 未` に正規化する(表示時変換で足りる場合は日時列のみのモードも作れる)。読み取り履歴は日時付きで閲覧できる必要がある(監査目的)= `scan_events` が正 → `/records` と `/result` の履歴小节。
2. **列は管理者の手動追加だけでなく、`/scan-settings`(と `/scan` の「新しい記録を作る」)から作れる**。列作成は `appendDimension` + ヘッダーの `values.update`(自前 fetch)。追加と同時に `include_columns` への追記を選択する。「これからこういうことを記録していく」をその場で開始できる運用を一次目標にする。
3. **書き込みタイミング = まとめ(5件・停止・確定)** を既定にする(§3 の `/api/scan-check` で即時フィードバック、`/api/scan-flush` で確定)。
4. **確認の有無はモード単位**。来場・チェックインは氏名表示 + 「記録」/「見送り」(confirm_before_record = true)。棚卸し・配布は確認なしで次々と記録(confirm_before_record = false)。
5. **履歴の閲覧場所**: `/records`(専用一覧・監査)+ `/result` の該当コードの履歴。一覧の行にも済/未を出せる(既存の任意 payload キーの表示選択で `来場済` / `配布済` を選べばコード変更に追随して出る)。

---

## 10. 実装状況(2026-11-16)

Phase1〜4まで実装した。設計案(§2〜§5)との対応は次の通り。

| 区分 | 実体 |
|---|---|
| スキーマ | `supabase/migrations/0006_scan_modes.sql`(`scan_modes` + `scan_events` + RLS + index + シード2モード)。`scan_events` は §2 の案に `seq bigserial unique` を追加(uuid は time-order でないのでカーソルに使えない) |
| 共有ロジック | `shared/utils/scan.ts`(型の正規化 `normalizeScanModes`/`normalizeScanMode`、DB の snake_case ↔ camelCase、`recordState` の済/未、`formatJst` の手計算、`isSameScan` の重複窓、分页の `historyNextCursor`/`clampHistoryLimit`、上限定数) |
| シート | `server/utils/googleSheets.ts` に `sheetColumnsInfo` / `appendColumns`(`appendDimension`)/ `updateCells`(`values:batchUpdate`、`SHEETS_BATCH_MAX`=100)を追加。既存の `updateCellValue`(単一セル)は温存 |
| サーバーロジック | `server/utils/scanRun.ts`(`loadScanModes`/`saveScanModes` = リストが正、履歴のあるモードの削除は400案内、code→行番号の索引キャッシュ TTL 60秒、`resolveActionColumns`、`lookupItemRow`、`checkScanCode`、`flushScan`、`createScanColumns`) |
| API | `/api/scan-config`(GET/POST)、`/api/scan-check`、`/api/scan-flush`、`/api/scan-columns`、`/api/scan-history`(§3 の形そのまま。from/to は JST の壁時計を受け取り server が +09:00 を補う) |
| 画面 | `app/components/QrScanner.vue`(`continuous` / `busy` props + 読み取り件数の表示)、`app/pages/scan.vue`(モードチップ・「新しい記録を作る」欄・pending card・セッションの待機列・確定ボタン、`keepalive`)、`app/pages/scan-settings.vue`(モードの追加・変更・削除・有効無効・シートの列追加。既定の2モードも DB の行なので同じように編集・削除できる)、`app/pages/records.vue`(絞り込み + seq カーソルの追記)、`app/pages/result.vue`(このコードの履歴小节)、`app/components/BottomNav.vue`(管理 dropdown に記録の設定と記録履歴) |
| テスト | `test/unit/scan.test.ts`(35件)、`test/supabase/scan-flow.test.ts`(6件、`npm run test:local`)、`scripts/verify-scan-record.mjs`(連続投入の UI 検証)、`scripts/verify-scan-confirm.mjs`(確認モードの氏名確認→記録→即 flush の UI 検証)、`scripts/verify-scan-settings.mjs`(設定の増減・変更・削除と導線の UI 検証。シートに列を書かない)、`scripts/verify-scan-return.mjs`(照会→結果→「スキャンに戻る」の自動再開と、ユーザーの停止は再開しないことの UI 検証。シートに一切書かない) |

設計案から実際に寄せた点:

- **証跡の不変性**: `scan_events` に authenticated の update/delete ポリシーを作らない。PostgREST は RLS で弾かれた update/delete を error にせず「0件」で返すので、テストは値が変わらないことで不変性を確認している。
- **履歴の分页**: `seq` 降順のキーセットカーソル(offset と違い、絞り込みを変えても先頭がずれない)。
- **連続スキャンの重複**: スキャン側(`isSameScan`, 2.5秒)とモードの `dedupe`(warn/skip/allow)の2段。確認モードの「上書き」だけ `overwrite` を送る。直前の読み取りは `useState('qr-last-scan')` に置くので、スキャナーを再マウントしても窓がリセットされない(= 照会モードで結果画面から戻った直後に手元の同じQRを再読しない)。
- **シート索引のキャッシュ**: 読み取り専用的な check を連続で叩くとシートを毎回読みになるため、コード→行番号の索引をプロセス内キャッシュ(TTL 60秒)。列追加後は捨てる。
- **既定の2モードは「コードに埋めた値」ではなく DB の行**: シードはマイグレーションの insert なので、他のモードと同じように編集・削除できる。`scan_modes` が空のときだけ `DEFAULT_SCAN_MODES` を画面に表示し(`rowMissing=true`)、保存で行を作る。
- **設定の導線**: `/scan-settings`(一覧・変更・削除・列追加)を追加し、`/scan` のモード行・`/records`・bottom nav の管理 dropdown から到達できる。`/scan` の「新しい記録を作る」欄も残す(その場で運用を始められる導線)。
- **列の不足を先に伝える**: `GET/POST /api/scan-config` はシートの実ヘッダー(`sheetHeaders`)も返す(読み取り失敗・未設定は `null`。SSR がシート読み取りの失敗で落ちないようにする)。`/scan-settings` は欠け列と「シートのヘッダーにありません」+ 列追加ボタンを出し、`/scan` は選択中のモードの欠け列を error で出す(flush の 400 をスキャンしてから教えない)。
- **照会 → 結果 → 「スキャンに戻る」は自動再開する**(運用の修正): 照会モードは検出1回で `stop()` して `/result` へ遷移し、`/scan` は keepalive で生存するため、戻るとカメラが止まったまま(「スキャン開始」を再度押す)だった。§1 の運用(照会→結果の確認→次のQR)に反するので、戻ったら `remountScanner()` で再マウントし自動再開する。遷移は `router.afterEach` で拾う(`useRoute()` を `watch` すると keepalive のページでは発火しない — 実測で戻り後に走らなかった)。「スキャン停止」ボタンの停止はユーザーの意思なので `useState('qr-scan-stopped')` で引き継ぎ、戻っても自動再開しない。§5 の「照会モードは1読み取りごとに stop」はそのまま(止まること自体は仕様、**戻ったときに再開する**のが追加)。
- **未実装(任意 Phase)**: オフラインの待機列、記録の CSV エクスポート。連続スキャンの誤読はシートにそのまま残るため、終了時に `/records` で確認する運用(§7)をそのまま推奨する。

検証の実測結果(ローカル Supabase + dev シート): 読み取り側(`VERIFY_SCAN_FLUSH` 未使用)は「チケット配布」モードで 1004 → 1018 → 1023 を順に流すと読み取り3件・未確定3件が待機列に氏名で並び、同じQRの窓内再読は積み上がらない(件数が3件のまま)。シート側(`VERIFY_SCAN_FLUSH=1`)は 3件を `配布済`(列 AT)に書き、`scan_events` に `ok` と `'フォームの回答 1'!AT6` 等の range が残り、`/api/scan-check` の状態が `済` / `recordedAt` が `2026-11-16 11:40 (JST)` になることを確認した(dev シートの列 配布済/配布日時/来場済/来場日時 は `/scan-settings` の「シートの列を追加」で実作成: ヘッダー45→49、`include_columns` 17→21)。確認側は「チェックイン」で 1018 を読み取り → pending card に氏名 → 「記録」で即 flush → 状態 `済` / `/records` に チェックイン の履歴。**実測で2つ直した**: (a) 列追加のリクエスト名(`addDimensionRange` は spreadsheet 単位の batchUpdate に無い → `appendDimension`)、(b) 確認モードの flush タイミング(5件閾値だけで即 flush していなかった)。flush は dev シートに 配布済/配布日時 と 来場済/来場日時 を書くので、本番データに対しては実行しない。
設定画面の実測(`scripts/verify-scan-settings.mjs`): 使い捨てのモードを作成(シートに列を書かない)→ `/scan` のチップに現れる → 改名と重複の扱い(`allow`)が DB に反映される → 削除で行が消える → `/scan`・`/records`・bottom nav の dropdown から設定画面へ到達できる。既定プリセットの2モードは消えない。欠け列の注記(`/scan-settings` の「シートのヘッダーにありません」、`/scan` の「このモードの列がシートにありません」)も実際に出ることを確認した。
戻り後の自動再開の実測(`scripts/verify-scan-return.mjs`): 照会モードで 1004 を読む → `/result?code=1004` → 「スキャンに戻る」→ 開始ボタンを押さずに「スキャン中」の表示と映像が戻る(再マウント+自動開始)→ 戻った直後に同じ 1004 を2秒映しても `/scan` のまま(窓内の再読は無視)→ 別の 1018 はそのまま `/result?code=1018` になる → 「スキャン停止」で止めて画面を戻っても「停止しました。開始ボタンで再開できます。」のまま(ユーザーの停止を尊重)。この検証はシートへ一切書かない(照会のみ)。
