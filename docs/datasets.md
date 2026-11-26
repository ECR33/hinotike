# データセット化: 複数 Spreadsheet を端末に取り込み、シートへ書き戻す設計

対象: `/home/kenji/dev/hinotike`(Nuxt 4 + Supabase + Google Sheets)
目的: 「1つの Spreadsheet を Supabase に取り込み、必要な部分を Spreadsheet へ書き戻す」を
**「複数の Spreadsheet を定義として DB に持ち、作業前に選んで端末(IndexedDB)へ取り込み、
任意のタイミングでシートへ書き戻す」**に変える。
状態: **実装済み(2026-11-22)**。マイグレーション 0007(定義) + 0008(記録モードの紐づけ) + 0009(レガシーの drop)。2026-11-26 に server のシート照会 endpoint を撤去し、一覧・照会・項目キー・スキャンの照合は**端末の IndexedDB のミラー**で行う(通信経由の照会が無い)。
README の方針(シートが正・RLS は登録ユーザ・Supabase Secret key 不使用・サービスアカウントは Worker の secret)はそのまま踏襲している。

---

## 1. 変更の要点(旧 → 新)

| 旧 | 新 |
|---|---|
| 旧の同期設定テーブル(singleton 行 id=1)= 1つのシート | `public.sync_sources`(**複数行**、1行 = 1データセット)。`/sync` で追加・編集・削除 |
| シートを Supabase のデータ本体テーブルに upsert(`POST /api/sync-commit`) | シートを **端末の IndexedDB** に保存(`GET /api/import` の分页)。データ本体のテーブルは 0009 で drop(DB にデータを置かない) |
| `/items`・`/result` は DB のデータ本体を照会(PostgREST の jsonb パス照会) | **端末のミラー**を照会(`shared/utils/offline.ts` の `offlineItemsQuery` / `offlineFacets` / `datasetKeys` / `offlineGetItem` / `offlineScanCheckResponse`)。server にシート照会 endpoint は無い |
| 記録・備考の書き込みは シート → データ本体 payload の2段 | **シートのみ**へ書く(旧の2段目の整合は廃止=ズレる窗口が無い。応答の `dbUpdated` も廃止) |
| オフラインモードは「1つのスナップショット」(code キー) | 「作業中のデータセット」(key = `sourceId|code`)。複数データを同じストアに住ませる |
| 記録モードはシートを unknown で書く | モードは `scan_modes.source_id` で**1データセットに紐づく**(`scan_events.source_id` も denormalize で残す) |

撤去した API: `POST /api/sync-commit`、`POST /api/sync-preview`(→ `POST /api/source-preview` に置換)、server 側のシート照会 endpoint(一覧・年組の選択肢・項目キーの発見・code の照会)とスキャンの照合 endpoint(→ 端末ミラーの `offlineItemsQuery` / `offlineFacets` / `datasetKeys` / `offlineGetItem` / `offlineScanCheckResponse` が担う)。
撤去したスクリプト: `scripts/sync-sheets.ts`(→ `scripts/import-sheets.ts`。CLI は取り込み**せず**シートを dump するだけ)。
残るシート読み取りは `GET /api/import`(取り込みと検証用のシート読み)と `POST /api/source-preview`(取り込み前プレビュー)だけ。設定の読み書きは `GET/POST /api/sync-config`、記録は `POST /api/scan-flush` / `POST /api/scan-offline-flush` / `POST /api/scan-columns`、備考は `POST /api/remark-update`、証跡は `GET /api/scan-history`。

## 2. データモデル

### `public.sync_sources`(マイグレーション 0007)
1行 = 1データセット。取り込み**定義だけ**を DB に置く。データ本体は置かない。

| 列 | 意味 |
|---|---|
| `id serial primary key` | 画面の選択・モードの紐づけ・IndexedDB の key prefix に使う |
| `name text not null unique` | 選択に出す表示名(重複は `normalizeSources` が最初の1つだけ残す) |
| `spreadsheet_id text not null default ''` | 未設定(`''`)のときは取り込み・書き戻しは 400 で拒否。**保存時は ID かシートのリンクのどちらでも受け付ける**(`spreadsheetIdFrom` がリンクから ID を取り出して保存する。DB に載るのは ID のまま) |
| `worksheet text` | null/空 = 最初のワークシート(`sheetTitleFor` は不一致時にも最初へフォールバック) |
| `code_column text not null default 'ID'` | QR 照会キーになるヘッダー名(常に保持される) |
| `include_columns text[]` | 空 = 全カラム。非空 = この許容リストのみ取り込む |
| `exclude_columns text[]` | `include_columns` が空のときだけ除外 |
| `filter_column text` / `filter_values text[]` | 行フィルタ。`filter_values` 空 = 「その列の値が非空なら有効」 |
| `rename jsonb` | `{ 元カラム名: 新キー名 }`(payload キーは rename 後、シート書き込みは逆引き `sourceColumnFor`) |
| `enabled boolean` | false = 画面の選択に出さない(削除せずに運用停止) |
| `updated_at` / `updated_by` | 監査(最後に編集した email) |

RLS は他の管理テーブルと同じ「登録済みユーザのみ」(`public.is_registered_user()`)で select/insert/update/delete。
シード行は `shared/utils/sync.ts` の `DEFAULT_SOURCE` と同じ値(片方を変えたらもう片方も直す)。


### `public.scan_modes.source_id` / `public.scan_events.source_id`(マイグレーション 0008)
- `scan_modes.source_id → sync_sources(id)` **on delete restrict**(記録モードが載るデータセットは消せない → 400 で「無効化してください」)。
- 既存モードは最初のデータセットへバックフィル(紐なしのモードは API が 400 にする = 黙って別シートに書かない)。
- `scan_events.source_id` は denormalize の監査値(モード削除後も「どのシートへの記録か」が読める)。
- データ本体のテーブルと旧の同期設定のテーブルは **0009 で drop**(`supabase/migrations/0009_drop_legacy.sql`。履歴整合のため 0003〜0005 のファイルは残す)。残るテーブル: `users` / `user_email_domains` / `registration_requests` / `sync_sources` / `scan_modes` / `scan_events`。

## 3. API

| endpoint | 内容 |
|---|---|
| `GET/POST /api/sync-config` | データセット一覧の取得・保存。POST は**リストを丸ごと**送る(無い id は削除、id 無しは insert)。全部削除は 400。紐づく記録モードがあれば削除は 400 |
| `POST /api/source-preview` | 1データセットの取り込み前プレビュー(シート実測: 実際のワークシート名・ヘッダー・対象カラム・payload キー・行数・code 空スキップ・行フィルタ除外・上限打ち切り・先頭サンプル)。書き込まない。読み取り失敗は `ok:false` + `error`(API を落とさない) |
| `GET /api/import?sourceId=&cursor=&limit=` | 取り込みの分页。**取り込み対象行の offset** をカーソル(文字列)にする。応答 `{ sourceId, sheetTitle, headers, columns, total, rows, nextCursor, skipped, filtered, truncated, importedAt }`。画面が完走して IndexedDB に保存する。**検証スクリプトのシート読みもこれを使う**(取り込み応答が唯一の sheet 読み。一覧・照会・照合の通信 endpoint は無い) |
| `POST /api/remark-update` `{code, remark, sourceId}` | **シートのみ**へ書く(応答は `{ok, code, remark, sheetTitle, range, sourceId}`)。端末ミラーへの反映は画面側(`offlineSetPayloadKey`) |
| `GET/POST /api/scan-config` | モード一覧 + **データセット一覧**(`sources`)+ `serviceAccountConfigured` + `rowMissing` + `sourceMissing` + `sheetTitle`/`sheetHeaders`(?sourceId= の実測)。POST は各モードの `sourceId` 必須(未指定は 400) |
| `POST /api/scan-flush` `{modeId, codes:[{code,overwrite,at?}]}` | シートへバッチ書き + `scan_events` 証跡(**書く先はシートだけ**)。応答 `{modeId, sheetTitle, results, wrote, auditWritten}` |
| `POST /api/scan-columns` `{sourceId, columns, addToIncludeColumns}` | そのデータセットのシートに列を作り、**そのデータセットの** include_columns に追記 |
| `GET /api/scan-history` | 変わらない(監査。`/records` はオフライン非対応) |
| `POST /api/scan-offline-flush` `{entries:[{modeId,code,at,overwrite}]}` | 端末にためた記録の確定(**氏名は送らない**)。サーバーは**その時点のシート**を読み直して行位置と現在の状態を確定し、`at`(端末での読み取り時刻)をシート日時と証跡にそのまま載せる。dedupe(warn/skip)で済だった行は注記で数える(`skipped`)。`write_failed` はキューに残す |

`server/utils/dataset.ts` がシート由来の行一覧(`mapSheetRows` 適用済み)を返し、
`server/utils/scanRun.ts` の `loadSheetIndex`(TTL 60秒、cache key は `sourceId|spreadsheetId|worksheet|codeColumn`)を共有する。**スキャンの照合は server を通らない**(画面の `offlineScanCheckResponse` が端末ミラーの payload から氏名・済/未・記録日時を出す)。

## 4. 端末側(IndexedDB / localStorage)

- DB `hinotike-offline`(version 1)、stores: `snapshot`(メタ1行) / `items`(**key = `sourceId|code`**) / `queue`。
  別のシートの同じ code が別人を指す可能性があるので code 単独の key は使えない。旧 key(code 単独)の行は取り込み時の clear で消える。
- `OfflineMeta`: `{ enabled, sourceId, uid, sourceName, source(定義のスナップショット), snapshotAt, itemCount, config(ScanConfigResponse), capped }`。
  localStorage(`hinotike-offline-meta`)には有効フラグ+メタを置く。SSR は storage を読めないので初回描画は「無効」、`useOfflineState` が onMounted で復元する。
  **旧形のメタ(sourceId / uid 無し)は `parseOfflineMeta` が null にする** = 無効扱いで再取り込みを促す(移行の安全弁)。
- **uid 紐づけ(端末での漏洩防止)**: 取り込み時の `auth.uid()` を `OfflineMeta.uid` に写す(`server/api/me.get.ts` が返す `uid` を `/scan`・`/sync` の取り込みで読む。解決できないときは取り込みしない)。
  ローカル作業の条件は `shared/utils/offline.ts` の `mirrorBelongsToUser(meta, authState.uid)` / `localWorkAllowed(meta, uid)`(どちらの uid が欠けていても false)。
  不一致(別利用者が取り込んだミラー)は `/scan`・`/items`・`/result`・`/scan-settings` でローカルミラーを使わない(**通信の照会経路は無い**ので、照会・一覧・スキャンは走らず、画面に「別の利用者が取り込んだデータ」の注記と再取り込み/削除の案内を出す)。
  ミラーは**平文**なので OS のディスク暗号化・端末のロックに依存する(アプリ側の暗号化はしていない)。
- 「作業中のデータセット」の選択は localStorage(`hinotike-active-source`)にも残す。`/scan` の `selectSource()` は
  ミラーがあれば設定を引き直し、無ければ `/api/scan-config?sourceId=` を読む(取り込みは別ボタン)。モード選択はソースで絞る(`modesForSource`)。
- 待機キューの entry は `sourceId` を持つ(復旧時にモードが消えていても正しいシートへ書くための保険)。
- 取り込みの上限 `OFFLINE_ITEM_MAX`(20000件。超えたら打ち切って注記)。シート側の上限は `MAX_IMPORT_ROWS`(5000行)。
- 記録の確定や備考の保存後は `offlineMergePayload` / `offlineSetPayloadKey` でミラーに写す(シートが正なので、端末の値は「次の取り込みまで」の近似)。uid 不一致のミラーには書かない。
- **端末データの削除**(`app/utils/offlineStore.ts` の `purgeDeviceData()`): items+snapshot を clear、localStorage のメタと `hinotike-active-source` を削除、
  SW のページキャッシュ(`OFFLINE_PAGE_CACHE_NAME` の `caches.delete`)を削除、ためた記録は `offlineStripQueueNames()` で **氏名だけ null に書き換える**(確定の入力 `modeId/code/at/overwrite` は残す)。
  「端末のデータを完全に削除」ボタン(/scan・/sync)とログアウト(`useLogout`)が呼ぶ。ためた記録を捨てるときは `offlineClearQueue()`(画面の2段階確認)。

## 5. ローカル作業(旧「オフラインモード」)

取り込み済みなら**通信があってもなくても**照会・一覧・記録は端末内のミラーに対して走る
(`offlineActive()` = メタが有効 **かつ** メタの uid が現在の利用者の uid と一致 **かつ** メタの sourceId が作業中のデータセット)。通信が無い場所での
地下運用は同じ仕組みでそのまま使える。記録は `queue` に積むだけ(通信しない)。任意のタイミングで
「ためた記録を確定」が `/api/scan-offline-flush` を送る。解除はフラグ false(ミラーとキューは残るが、そのデータセットのスキャン・照会・一覧は走らない = 取り込みし直すか別のデータセットを選ぶ)、
「端末のデータを完全に削除」はミラー+localStorage+ページキャッシュを消す(ためた記録は氏名だけ除去して残る = 確定できる)。

## 6. メリット / デメリット(この設計のトレードオフ)

**メリット**
- シートが唯一の正になる → 「シートと DB のズレ」を直す処理(upsert・prune・dbUpdated 注記)が全部不要。
- データが端末にあるので通信が無い場所でも一覧・照会・記録が完結する(旧オフラインモードの能力が複数シートで使える)。
- 取り込みは**選べたデータだけ**端末に置く。1画面で複数現場(複数シート)を扱える。
- Supabase は「定義・モード・証跡」だけを持つ小規模 DB にできる(データ本体のテーブルは 0009 で drop。PostgREST の jsonb パス照会という高コスト・壊れやすい照会から解放される)。
- 照合ロジックが1実装になる(一覧・照会・項目キー・スキャン照合は端末の `shared/utils/offline.ts` の関数だけ)→ server と端末で意味のズレが起きない。

**デメリット / 注意**
- 端末のミラーは**取り込み時の値**なので、シート側が他で変わるとその値は古くなる(画面に注記を出す。確定時はサーバーがシートを読み直すので書き込みは正しい)。
- 取り込みはシートを全行読む(1シートあたり最大 `MAX_IMPORT_ROWS`=5000行)。複数シートを次々取り込むと端末のストレージと通信量が増える(ストアは clear してから書くので1データセットぶんが上限)。
- シート読み取りは取り込みとプレビュー(と書き戻し時の行索引)だけserver が打つ。一覧・年組の選択肢・項目キー・スキャン照合は端末ミラーなので通信しない。取り込みは最大 `MAX_IMPORT_ROWS`(5000行)を一度読む(小規模運用では問題なし。大規模なら分页と TTL・preload を調整する)。
- 記録モードはシート固有の列名を持つので**モードはデータセットごとに作る**(同じ「チェックイン」を2シートに作りたいときは2行)。
- 端末データは端末ごとに個別 → 端末を乗り替えると取り込み直後に待機キューが消える(端末の内側)。復旧確定は同じ端末で行う。
- 旧のデータ本体テーブルと旧の同期設定テーブルは 0009 で drop した(旧データの参照はシート側。DB に旧行は残らない)。

## 7. 検証

- 単体: `test/unit/sync.test.ts`(定義の正規化・選別・rename・A1 表記・分页)、`test/unit/offline.test.ts`
  (メタの往復と旧形の拒否、`offlineItemsQuery`/`offlineFacets`/`datasetKeys`、ローカル照合、キュー正規化)、
  `test/unit/scan.test.ts`(モードの `sourceId` とリスト保存)。
- 統合: `npm run test:local`(ローカル Supabase。`scan-flow.test.ts` はモードのデータセット紐づけと証跡の RLS、`registration-flow.test.ts` は `sync_sources` の RLS を見る。データ本体テーブルの照会テストは無い(テーブルを drop した)。
- 実測: `node scripts/verify-scan-offline.mjs`(取り込み → 通信を切って確認カード → 端末キュー → persistence →
  `/items` の端末一覧 → `VERIFY_OFFLINE_FLUSH=1` で確定と証跡(記録後の状態は `GET /api/import` の payload で読む)。`node scripts/verify-items-page.mjs` は取り込み済みの端末で**ミラーから**一覧・年組・項目が埋まることを確認し、撤去した通信照会 endpoint のリクエストが 0件であることを断言する。シート設定とサービスアカウント鍵が必要。
  鍵の置き場所: 本番は Worker の secret `GOOGLE_SERVICE_ACCOUNT_JSON`(JSON 文字列)、dev は `.dev.vars`(同じ)か
  `GOOGLE_SERVICE_ACCOUNT_JSON_PATH`(パス → fs から読む)。dev の `.env.development` は**パス側の名前**を使う
  (旧形: パスを `GOOGLE_SERVICE_ACCOUNT_JSON` に置いていて「鍵 JSON」と誤読され「鍵なし」→ 400 になっていた)。
  単体: `test/unit/google-credentials.test.ts` / `test/unit/dev-env-merge.test.ts`。
- 型: `npm run typecheck`。ビルド: `npm run build`(Cloudflare preset)。

## 8. デプロイ時に必要なのは「コード」だけではない(DB 側)

`npx wrangler deploy`(または main への push → GitHub Actions)だけでは**アプリは動かない**:
本番 Supabase にマイグレーション **0007/0008/0009** が適用されていないと `public.sync_sources` が無く
`loadSources` が 500(`sync_sources の読み込み失敗: Could not find the table ...`)になり、`/sync`・`/scan`・
`/scan-settings` が落ちる(実測: 2026-11-25 の本番がこの状態だった)。`/items`・`/result`・スキャンの照合は DB のデータ本体を読まない(端末ミラーを使う)ので、0009 の適用後も同じ画面で動く。
`scan_modes.source_id` / `scan_events.source_id` も 0008 側なので同じ。0009 は旧のデータ本体テーブルと旧の同期設定テーブルを drop する(旧行の復元はしない — シートが正なので、データは取り込みで端末に置く)。確認と適用:

```
npx supabase migration list --remote=<project-ref>     # 0007/0008/0009 が「未適用」に出る
npx supabase db push --remote=<project-ref> --yes      # 適用(0007 はシード行を作る。0009 はレガシーテーブルを drop する)
```

ローカルでも同じ確認ができる(`npm run supabase:start` → `npx supabase migration up` → `npm run test:local`)。
Workers の secret(`GOOGLE_SERVICE_ACCOUNT_JSON`)はダッシュボード側(`wrangler secret list` で確認)で、
 CI は secret を送らない(`.github/workflows/deploy.yml` のコメント)。

列追加・定義変更は `invalidateSheetIndexCache` で捨てる(古い行索引で別セルに書かない)。
`resolveSource`(未指定は有効な最初のデータセット)と `requireSource`(厳密。取り込み・書き込み側)の2系統を使う。