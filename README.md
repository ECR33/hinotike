# Hinotike

Nuxt 4 + Supabase + Google 認証の QR 照会 Web アプリの雛形。
認証は slack2mail の設計(simply: モジュール委譲・グローバルミドルウェア・email 事前登録+自動紐付け・SQL関数集約)を単一テナント版として取り入れています。テナント対応はありません。

ディレクトリ構成は Nuxt 4 の srcDir に従う: エントリ・ページ・components・composables・middleware・types は `app/` 配下(`app/app.vue`, `app/pages`, `app/components`, `app/composables`, `app/middleware`, `app/types`)。ルート直下の `components/` や `app.vue` は srcDir 外なので読み込まれない。サーバーコードは `server/`、共有ユーティリティは `shared/`(ルート直下、`#shared` で参照)。

## 構成

| 画面 | 認証 | 用途 |
|---|---|---|
| `/` | 不要 | トップページ。状態に応じてログイン/QRリンク |
| `/login` | 不要 | ログインページ(未認証時はグローバルミドルウェア从这里へ) |
| `/scan` | 必要 | QRコードをカメラで連続スキャン(@zxing/library) |
| `/result` | 必要 | QRの値(または一覧の行)で Supabase `items` を照会し、カード形式で結果表示 |
| `/items` | 必要 | `items` のレコード一覧(スクロールで追記 + code/氏名のインクリメンタル検索 + 折りたたみできる年・組の絞り込み[単独 chip / 年×組マトリクス] + 条件リセット) |
| `/unauthorized` | 不要(案内用) | Google認証済みだが users に紐付けがない場合の案内 + 許可依頼QR |
| `/register` | 必要(登録済み) | 利用者登録画面: 許可依頼QRを読んで依頼者のemail確認 → 許可 |
| `/share` | 必要(登録済み) | アプリ共有: アプリのトップURLのQRを表示。別のスマホのカメラ/QRリーダーで読むとトップが開き、未登録なら許可依頼フロー(/unauthorized)へ自動接続される。QRはドットスタイル描画(`app/components/QrDots.vue`、qrcode-vue3 の dot style 参考。既存の qrcode ライブラリの BitMatrix を SVG に描き直すだけ。finder は走査線比率 1:1:3:1:1 を保つ rounded 形なので jsQR/zxing/native リーダーで読める) |
| `/sync` | 必要(登録済み) | Spreadsheet 同期の管理画面(設定保存 → プレビュー → 確定 upsert) |

### Bottom navigation(`app/components/BottomNav.vue`)

全ページ下部に常駐する固定バー(`app/app.vue` が `NuxtPage` と一緒に描く)。項目は認証状態跟着出す(`app/middleware/auth.global.ts` と同じ `useState('auth-state')` を読む):

| 状態 | 表示項目 |
|---|---|
| 未認証 | トップ / ログイン(`/login`) |
| 認証済み・未登録 | トップ / 許可依頼(`/unauthorized`) / 管理(dropdown: ログアウト) |
| 認証済み・許可済み | トップ / QRスキャン(`/scan`) / 一覧(`/items`) / 管理(dropdown: アプリ共有`/share`・利用者登録`/register`・同期`/sync`・ログアウト) |

- 管理系項目は「管理」ボタンの dropdown menu にまとめて常駐バーの項目数を抑える(dropdown はバーの上に開く。外側クリック / Escape / ルート変更で閉じる。格納先ルート(`/share`・`/register`・`/sync`)にいるとき「管理」が点灯し、menu 内の現ページは `aria-current="page"`)。許可依頼は未登録ユーザの主動作なのでバーに直接残す。
- ログアウトはルートではなく action(`useLogout()` → `POST /api/logout` → `/`)。ページ内の「ログアウト」ボタンは重複なので撤去した(`/index`・`/login`・`/scan`・`/register`・`/unauthorized`)。バー時代のログアウトは dropdown 内(dropdown 項目は route を変わらないので選択時に自前で閉じる)。
- `/result` では QRスキャン が点灯する(スキャンの延長という扱い)。
- 未認証時に保護リンクを出さない理由: ミドルウェアが `/login?returnTo=` に誘導するため、押しても遷移しない(出すと「動かないリンク」になる)。
- `app.vue` の render はミドルウェア(NuxtPage の setup)より先に走るため、BottomNav は SSR で未缓存の `auth-state` を自分で解決して缓存に入れる。ページ(`index`/`login`/`unauthorized`)も同じ缓存を再利用するので `/api/me` の重複照会にならない。
- バーは `position: fixed` なので `.page` の下端 padding を `calc(90px + env(safe-area-inset-bottom))` にしてコンテンツを隠れないようにする。

### レコード一覧(`/items`)

- **API**: `GET /api/items-list`(`requireRegisteredUser` → RLS `items_select_registered_users` と同じ根)。応答は `{ rows, nextCursor, total }`(`total` は exact count の一致総件数)。
- **分页は code(PK)昇順のキーセットカーソル**: `code > cursor` を次ページとして読む。offset と違い、検索条件を変えても既存ページの先頭がずれない(スクロール追記で重複・取りこぼししない)。1バッチは `ITEM_PAGE_SIZE`(25、API側で 1〜100 に補正)。
- **検索は部分一致(ilike)**: code は `code` カラム、氏名は payload のキーを jsonb パス `payload->>"氏名"` で照会する。入力の `%` `_`(と `\`)はリテラルにエスケープし、任意文字扱いにならない(`shared/utils/items.ts` の `containsPattern`)。長い入力は上限で切る(高コストな照合防止)。
- **全件を一括で出さない UI**: 末尾の sentinel が画面に出た時点で IntersectionObserver が次のページを読み、sentinel がまだ見えている限り自己継続して追記する(1バッチで viewport が埋まらない場合も続く)。IntersectionObserver が無い環境は「次の25件を表示」ボタンにフォールバックする。IO の有無はクライアントでしか分からないので、判定は `ref(false)` の初期値(SSR とクライアントの初回描画を一致させる)+ `onMounted` で実際の判定という2段にしている(単なる `typeof` 判定だと SSR がフォールバックボタンを描いて hydration mismatch になる)。
- **インクリメンタル検索**: 入力は 250ms のデバウンスでまとめ、条件が変わるたび reset + 1ページ目から取り直す。応答は generation で比較し、後発の検索に負けた古い応答は適用しない(連打の乱順応答で古い条件の結果に戻るのを防ぐ)。URL とは同期しない(`?code=&name=&years=&groups=&pairs=` は初期値としてだけ読む)。
- **入力の消去**: `app/components/ClearableInput.vue`(値があるときだけ右端に消去ボタンが出て、押すと空にする。Vuetify の `clearable` 相当)。このプロジェクトには Vuetify を入れていないので自前部品で同じ挙動を出す。
- **年・組の絞り込み(2モード)**: 絞り込み欄は折りたたみできる(`aria-expanded` のトグルボタン、閉じても選択状態はラベルに残る。縦に場所を取る年9×組5のマトリクスを普段は畳むため)。`app/pages/items.vue` のモード切替で「年・組を単独で」と「年と組の組み合わせ」を選ぶ。**単独モード**は `app/components/FacetChipGroup.vue` の chip 多选択で、同一 facet 内は OR(`in.()` に複数値)、年と組の間は AND(`in.()` を2つ重ねる)。**組み合わせモード**は `app/components/YearGroupMatrix.vue`(行=年、列=組のマスを選び、選んだ「その年 + その組」だけを対象にする)。マスの件数は `facets.pairs` から、0件のマスは `disabled`(`–`)。
- **ペアの照会**: `GET /api/items-list?pairs=1:3,2:1`(`shared/utils/items.ts` の `parsePair`/`normalizePairs`/`pairConditions`)。各ペアは 年 AND 組、ペア同士は OR。PostgREST の nested logic は `or=(and(payload->>"学年".eq."1",payload->>"クラス".eq."3"),and(...))` の形で、`and=(...)` ではなく `and(...)` の構文が必要(nested の `and=` は PGRST100 エラー)。パスは `payloadTextColumn(key)` の引用形(`payload->>"学年"`)で組み立て、値も `quoteInValue` で引用する(`.` `,` `"` を含む値でも安全)。単独選択(years/groups)と同時に送ると単独条件とペアの AND になるが、UI はモード切替でもう一方の選択を消すので同時に送らない(見えない選択が条件に残らない)。ペア上限は `ITEM_PAIR_MAX`(60)。
- **選択肢(facets)**: `GET /api/items-facets` が items 全体の値と件数を返す(`GET /api/items-list` と同じ guard)。応答は `{ years, groups, pairs, missingPairs, scanned, truncated }`(`pairs` は 年と組の両方がある行のペア件数、`missingPairs` はどちらかが空の行の件数)。chip とマトリクスはこれだけで作り、現在の絞り込み結果には連動しない(絞り込みで選択肢が消えると「選べなくなった理由」が分からなくなるため)。年 or 組 が空のレコードはマトリクスで選べないが黙って減らさない(`missingPairs` を注記で出す)。スキャン上限(`ITEM_FACET_SCAN_LIMIT`)に達したら `truncated` を返し、UI に静かに注記する。SSR で解決して `useState` で hydration に引き継ぐ(初期条件が一致する時だけ 1ページ目を再利用する)。
- **条件のリセット**: 「条件をリセット」ボタンで code・氏名・年・組・ペアを一度に消す(chip・マス・リセット・モード切替はデバウンスを待たずに即適用)。条件がなければボタンは無効。モード自体は維持する(絞り込み欄を開き直して続きを選ぶ)。
- **行部品**: `app/components/ItemRow.vue`(年/組/氏名/code の4要素)。表示列を増やしたいときはこの部品に `payloadValue(payload, key)` を足すだけで、ページと API は変更不要(API は payload をそのまま返す)。行全体が `/result?code=…` のリンク(行の中は span だけにして入れ子のリンクを作らないので、行まるごとタップでスキャンと同じ照会結果画面へ遷移する。当たり面积は min-height 44px)。
- **payload キーの集中**: 表示・検索に使うキーは `shared/utils/items.ts`(`ITEM_YEAR_KEY`/`ITEM_GROUP_KEY`/`ITEM_NAME_KEY`)。`scripts/columns.config.json`(rename 含む)と一致させること。
- `/scan` の「手入力(テスト用)」欄は撤去した(dev 限定の gating はなく、本番でも常に表示されていた)。code を直接照会したい用途は `/items` の code 検索が同じ役割を果たす。

### 照会結果(`/result`)

- **入口**: QRスキャンの検出(`/scan` の `navigateTo`)と、`/items` の行タップ(行リンク)。どちらも `/result?code=…` の SPA 遷移。
- **API**: `POST /api/lookup`(`requireRegisteredUser`)は `{ found, code, row }` を返すだけ(表示の整形は画面側)。SSR で解決して `useState` で hydration に引き継ぎ、client-side遷移で code が変われば再照会する(旧結果の残存防止)。
- **カード表示**: 1枚のカードに見出し(氏名を大きく + 年組のタグ + 入金状況のタグ + コード)を作り、その下に **まとまりの枠** を並べる。
  - `.money-panel`: 購入金額・入金額・支払い方法を1つの枠に格子で並べる(3セル揃うとき3列、欠けるセルは2列 + 支払い方法が狭い画面で1行占有)。個数系や入金状況は枠に入れない。
  - `.product-panel`: 商品と個数を1つの枠にまとめる。見出しに `合計 N個` と `1商品あたり最大6個`、各行は 商品名 + 星のスロット6個(`★` が個数、`☆` が残り)+ 数字の個数(`N個`)。星は飾りなので `aria-hidden` を付け、スクリーンリーダーには数字だけを読む。0個は星を薄くして数字で 0個 を出す。想定外の6個超の値は星を6個まで埋めて数字はそのまま表示する。
  - 残りは `.result-list`(`dl` の `.result-row`)のラベル/値のリスト。狭い画面(<460px)ではラベルを値の上に回す。
- **縦詰め**: 見出し・金額枠・商品枠・残り項目をカード1枚に詰め、390×720 の viewport で結果画面はスクロールしない(検証: `node scripts/verify-items-page.mjs` の `縦詰め` 行)。枠の padding と行の padding は狭めに固定する。
- **並びと整形**: 見出しに出すキー(氏名/学年/クラス)、枠に出すキー(購入金額・入金額・支払い方法)、入金状況のタグ、個数系キーはリスト側で重複表示しない(`entries` の `taken` で除外)。リストは 領収書 → その他(元の順) → 備考 → 取り込み日時。金額系は 3桁区切り + 円、空の値は行を出さない。キー名は `scripts/columns.config.json` と合わせる(`shared/utils/items.ts` の定数を使う)。
- **SSR/クライアントで同じ文字列にする**: `toLocaleString` や `localeCompare` は ICU の挙動差で hydration mismatch の原因になるので使わない(3桁区切りは正規表現、個数系の並びは code point 順、取り込み日時 JST 表記は手計算)。
- **code が無い/見つからない**: code 無しは照会しない(API は 400 を返すだけ)し、案内カードを出す。見つからない場合もコードを添えた案内カードを出す。戻るボタンは「スキャンに戻る」と「一覧に戻る」の2つ。

## 認証の仕組み

- **モジュール**: `@nuxtjs/supabase`。クライアント/サーバーの cookie・セッション運用を1系統に統一(自前 browser plugin と自前 server client は撤去)。
- **ルート保護**: `app/middleware/auth.global.ts` — デフォルト拒否 + 公開ルートホワイトリスト(`publicRoutes`)。新しいページは自動的に保護される。
- **SSR cookie 転送**: SSR の内部 fetch はブラウザ cookie を自動では持たないため、`$fetch('/api/me', { headers: useRequestHeaders(['cookie']) })` で明示転送する。
- **権限判定の集約**: 「登録済み」判定は SQL 関数 `is_registered_user()` に集約。RLS(`items_select_registered_users`)と API guard(`server/utils/authguard.ts`)が同じ根で判定する。
- **ログイン開始**: サーバー側 `GET /api/auth/login`(`serverSupabaseClient` + `skipBrowserRedirect` → 自側 `sendRedirect`)。ブラウザ client で OAuth を開始しない。
- **OAuth callback**: `GET /api/auth-callback` で code→セッション交換(PKCE verifier は cookie)→ RPC `link_my_user()` で自動紐付け → 検証済み `returnTo` へリダイレクト。エラーは固定コード(`shared/utils/auth.ts` の `AUTH_ERROR_CODES`)のみ URL に載せ、内部メッセージはログに出す。
- **リダイレクト検証**: `isSafeLocalPath()` — `/` で始まり `//` と `/\\` を拒否(プロトコル相対 URL による外部リダイレクト防止)。
- **ログアウト**: サーバー側 `/api/logout` のみ(モジュール signOut + `sb-*` cookie 削除)。クライアント signOut との二重ログアウトは撤去。

## 利用権限と登録運用

許可リストは `users` テーブル。登録経路は2つ(どちらも検証済み email + ドメイン制限の条件と同じ)。

### A. 管理者による email 事前登録(最初の利用者はこちら)
1. 管理者が `users` に **email を事前登録**(初回ログインの前。UUID は不要):
   ```sql
   insert into public.users (email, name) values ('user@example.com', '太郎');
   ```
   (ダッシュボードの SQL Editor で実行可。**最初の利用者**は必ずこの経路 — QRによる許可には
   すでに許可済みの利用者が1人必要なので)
2. ユーザが初回ログイン → callback が `link_my_user()` を呼び、**検証済み email 完全一致**の未紐付け行に `auth_user_id` を自動紐付け。

### B. QRによる許可依頼(2人目以降の運用)
1. 新しい利用者がアプリで Google ログイン → 未紐付けなら `/unauthorized` に「許可を求める」ボタンが出る。
2. ボタンが RPC `create_registration_request()` で依頼行(1人1行・15分有効・一回用 nonce)を作り、
   QRの中身 `hinotike-registration:<nonce uuid>` を画面に表示する。
3. 許可済みの利用者が `/register`(利用者登録画面)でそのQRを読む →
   `POST /api/approval-preview` が依頼者の email を表示 → 確認して「許可する」→
   `POST /api/approval-approve` が RPC `approve_registration_request()` を呼ぶ
   (検証済み email + ドメイン許可を再検証 → users 行の紐付け/作成 → nonce 消費 + `approved_by` 記録)。
4. 依頼者側は `/api/me` を polling(2.5秒)し、`authorized: true` になると自動で `/scan` へ遷移する
   (ミドルウェアの `auth-state` 缓存を更新してから遷移するので缓存の旧判定で戻されない)。

安全面の設計:
- QRに uid / email を直接載せない。nonce は依頼者自身のセッションでしか作れず、
  撮影したQRは有効期限切れ・消費済み・再生成で無効になる(replay・無承認の許可防止)。
- 承認は preview→確認→approve の二段階。スキャンした人は**誰を許可するか**を email で確認してから承認する。
- 承認者も依頼者と同じ条件(検証済み email、`user_email_domains` のドメイン制限)が適用される。
  QR経路がドメイン制限のバイパスにならない。
- 再生成で古いQRは無効化(依頼は1人1行)。消費済み/期限切れ/登録済みは固定文言で idempotent に扱う。
- items照会用のQRコードとは namespace が別(`hinotike-registration:` 接頭辞)。
  `/scan` で登録QRを照会しても items に見つからないだけで、`/register` で itemコードは 400。
- ドメイン制限(任意): `user_email_domains` に行がある場合はそのドメインのみ紐付け許可。0 行 = 制限なし。

## セットアップ

1. `npm install`
2. `.env.example` をコピーして `.env` を作り、値を設定:
   - `NUXT_PUBLIC_SUPABASE_URL` / `NUXT_PUBLIC_SUPABASE_KEY`(sb_publishable_...)
   - `NUXT_PUBLIC_APP_URL`(本番の公開 baseUrl。tunnel 等を使う場合)
   - 開発ホスト許可は `DEV_ALLOWED_HOSTS` / `NUXT_VITE_ALLOWED_HOST`(nuxt.config にホストをハードコードしない)
   - アプリサーバーは Secret key を使わない(items の insert/update は RLS の `is_registered_user()` で許可する。Secret key は CLI の同期だけ)
3. Supabase 側:
   - `supabase/migrations/0001_init.sql` → `supabase/migrations/0002_registration_requests.sql` → `supabase/migrations/0003_sync_settings.sql` を SQL Editor でこの順に実行(users / items / ドメイン表 / RLS / 関数 + 許可依頼の依頼テーブルと RPC + 同期設定テーブル `sync_settings` とシード行。関数が RLS ポリシーより先に作成される順になっている)
     - 旧スキーマからの移行は drop して再作成(items は再同期で復元)
   - Authentication → Third-party providers → Google を有効化
   - Authentication → URL Configuration:
     - Site URL: `<site-url>`
     - Redirect URLs: `<site-url>/api/auth-callback` を**アクセスするホスト全部**で登録
       例: `http://localhost:3000/api/auth-callback`,
       `https://your-tunnel-host.example.com/api/auth-callback`
     - 未登録ホストの redirectTo は Site URL ルートに `?code=` を付けてフォールバックされる
       (server/middleware/oauth-root-callback.ts が `/api/auth-callback` に救済するが、
       PKCE verifier はオリジンの cookie にあるため別オリジンでは交換できない → 必ず登録)
   - 利用許可ユーザの email を `users` に事前登録(ダッシュボード or Secret key)。
     **少なくとも1人**は必ずこの経路で登録しておく(QRによる許可運用には許可済みの利用者が必要)
4. スプレッドシート同期(UI から発動 / `/sync`):
   - 取り込み設定は DB の `public.sync_settings`(singleton 行 id=1)が正。`/sync` 画面でスプレッドシート ID・
     ワークシート・code カラム・取り込みカラム(空 = 全カラム)・除外・rename・対象テーブルを編集し、
     「設定を保存」→「プレビュー」→「取り込みを確定」の順で実行する(確定は `confirm: true` 必須、5000行超は拒否)
   - シート読み取りは Worker 側で行う(googleapis 不使用): サービスアカウント鍵から JWT(RS256)を自前署名し
     oauth2 の jwt-bearer grant で access token を取り、Sheets REST API(v4)を fetch で読む
   - 鍵は Worker の secret `GOOGLE_SERVICE_ACCOUNT_JSON`(鍵 JSON の文字列)に置く。本番の Worker は
     Supabase の Secret key を持たない(items の書き込みは RLS の `is_registered_user()` で許可する)
   - 開発中に Worker で同期を試すなら `.dev.vars` に同じ鍵 JSON を置く(`wrangler dev` は `.dev.vars` を読む。コミットしない)
   - 手動/CLI の同期(ローカル Supabase に本番データを反映するなど): `npm run sync:sheets`(tsx → `scripts/sync-sheets.ts`)。
     同じ `sync_settings` 行を読み、行が無い/ID が空なら env の `GOOGLE_SPREADSHEET_ID` を使う。
     鍵は `GOOGLE_SERVICE_ACCOUNT_JSON_PATH`(パス指定、既定 `scripts/service-account.json`)か JSON 文字列の `GOOGLE_SERVICE_ACCOUNT_JSON`。
     `npm run sync:sheets:local` は `.env.development` が指すローカル Supabase へ同期する(`--env <file>` で任意の環境ファイルを指定可)
   - 注意: `npm run dev` は `.env.development`(ローカル Supabase)を読むため、ローカルで
     データを見たい場合は `sync:sheets:local` が必要。本番データをローカルに反映したい場合もこれを使う
5. `npm run dev` → http://localhost:3000
6. `npm test` — 単体テスト(`isSafeLocalPath` / エラーコード / 登録QRのコード検証)。ローカル Supabase が起動していれば `npm run test:local` で登録→紐付け→照会フローと QR許可フロー(依頼作成→preview→approve→consumed・再利用拒否)の統合テストが実際に実行される(env がない場合は自動スキップ)。dev サーバが動いていれば `node scripts/verify-registration-flow.mjs` で API 一式の実挙動検証もできる(devログイン使用)

## 本番デプロイ(Cloudflare Workers + GitHub Actions)

このアプリは Cloudflare Workers 単独で動く(仮想マシン/Node サーバー不要)。nitro の preset を
`cloudflare-module` にして、`.output/server/index.mjs`(fetch ハンドラ)と `.output/public`(静的資産+SW)を
Workers + Assets としてデプロイする。`nodejs_compat` を有効にする(同期の JWT 署名が `node:crypto` に
フォールバックする経路を持つため)。

- ビルド+デプロイ: `npm run deploy:cf`(`nuxt build` → `npx wrangler deploy`)。 Workers の設定はルートの `wrangler.jsonc`
  (worker 名 `hinotike`、main=`.output/server/index.mjs`、assets=`.output/public`、`compatibility_date` 2026-11-01 + `nodejs_compat`、
  `vars` に `NUXT_PUBLIC_APP_URL`)。ローカルで Workers の挙動を見るなら `npm run preview:cf`(`.dev.vars` を読む)。
- 公開値はビルド時に焼き込む(`NUXT_PUBLIC_SUPABASE_URL` / `NUXT_PUBLIC_SUPABASE_KEY` は publishable key なので公開してよい)。
  `NUXT_PUBLIC_APP_URL` は `wrangler.jsonc` の vars で設定し、変更は `wrangler v1` の再デプロイで反映する。
- シークレット(リポジトリに置かない): Workers の Secret `GOOGLE_SERVICE_ACCOUNT_JSON`(鍵 JSON の文字列)。
  初回は Cloudflare ダッシュボード → Workers & Pages → `hinotike` → Settings → Secrets → Add secret に貼る
  (または `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON`)。再デプロイでも残る。
  改行が `\n` エスケープのまま渡っても `server/utils/googleSheets.ts` の `normalizePrivateKey` が実改行に戻す。
- GitHub Actions(`.github/workflows/deploy.yml`): main の push → `npm ci` → `npm test` → `npm run typecheck` →
  (必須変数が空ならビルド前に失敗するガード)→ `npm run build` → `npx wrangler deploy`。
  リポジトリ側で設定する値(Settings → Secrets and variables → Actions):
  - vars: `NUXT_PUBLIC_SUPABASE_URL`(例 `https://<project-ref>.supabase.co`)、`NUXT_PUBLIC_APP_URL`(本番ホスト)
  - secrets: `NUXT_PUBLIC_SUPABASE_KEY`(publishable key で可)、`CF_API_TOKEN`(Workers を deploy できる権限の token)、`CF_ACCOUNT_ID`
  Actions から `wrangler secret put` はしない(鍵 JSON を Actions に載せないため)。
- 配信ドメイン: 本番ホストは `https://hinotike.hinogakuenpta.org`。Cloudflare ダッシュボードの Workers →
  `hinotike` → Settings → Custom domains に追加する(DNS レコードは自動作成される)。
  同じホストを `wrangler.jsonc` の `vars.NUXT_PUBLIC_APP_URL` と GitHub の vars `NUXT_PUBLIC_APP_URL` に書く。
- Supabase の URL Configuration は本番ホストで登録する: Site URL `https://hinotike.hinogakuenpta.org`、
  Redirect URLs `https://hinotike.hinogakuenpta.org/api/auth-callback`(Google OAuth 側でも同じホストを
  Authorized origins に含める)。未登録ホストからの認証は完結しない(PKCE verifier はオリジンの cookie にある)。
- カメラ(PWA / `getUserMedia`)は HTTPS 必須 → Cloudflare の自動 TLS で満たされる。

## ローカル Supabase での開発・検証(Docker が使える環境)

```bash
npm run supabase:start   # 初回はイメージ取得。API http://127.0.0.1:54321 / Studio http://127.0.0.1:54323 / Mailpit(メール) http://127.0.0.1:54324
npm run supabase:reset   # マイグレーション変更後にローカル DB を再作成(supabase/migrations/*.sql を適用)
npm run supabase:stop
```

- `npm run dev` は `nuxt dev --dotenv .env.development` でローカル Supabase の dev デフォルトキーを読み、本番用の `.env` は dev では使わない(hosted Supabase の認証テストをしたいときは shell の env 変数で上書きできる)。
- スキーマは start/reset で `supabase/migrations/*.sql`(0001→0002→0003 の順)が自動適用される。ホスト版には同じファイルをこの順で SQL Editor に貼って実行するか、`supabase db push` を使う。
  hosted への `db push` は `npx supabase db push --remote=<project-ref>` で、**Supabase の access token(scoped: database_write)か DB のパスワード(`--password`)が必要**(service_role key では DB に繋がらない)。まず `--dry-run` で適用されるマイグレーションを確認する。
- 統合テスト: `npm run test:local`(email 事前登録 → 初回ログインの `link_my_user()` 自動紐付け → `is_registered_user()` / items 閲覧 / 未登録拒否 + QR許可フロー: 依頼作成・再生成で旧nonce失効・preview/approve・ドメイン制限・consumed 再利用拒否を検証)。
- **ローカルでは Google OAuth は使えない**(ローカル gotrue はサードパーティプロバイダ非対応)。UI 検証は dev 限定のパスワードログインで行う:
  ```bash
  npm run supabase:dev-user          # 許可側テストユーザ(users 事前登録行あり)→ dev ログインで /scan に直达
  node scripts/create-dev-user.mjs newcomer@example.com dev-password-2026 --no-registration
                                     # 依頼側(新利用者)テストユーザ: auth ユザのみ → dev ログインで /unauthorized に誘導
  npm run dev                        # → /login の「dev ログイン」フォーム → セッション cookie が張られ /scan・/result が閲覧できる
  ```
  QR許可フローの UI 検証は**別 cookie jar の2ウィンドウ**(通常ウィンドウ=許可者 / シークレットウィンドウ=依頼者)で行う:
  依頼者ウィンドウの /unauthorized の「許可を求める」で QR 表示 → 許可者ウィンドウの /register でカメラ読み(別画面の QR を Webcam で写す)→ email 確認 → 許可 → 依頼者側は polling で自動 /scan 遷移。
  API 一式の実挙動確認は `node scripts/verify-registration-flow.mjs`(dev サーバ + ローカル Supabase が必要)。
  bottom navigation の項目・アクティブ表示・コンテンツとの重なりは `node scripts/verify-bottom-nav.mjs` をヘッドレス Chrome で確認する(未認証 / 許可済み / 未登録の3状態。未登録テストユーザがないときはそのシナリオはスキップされる)。
  `/items` のスクロール追記・インクリメンタル検索・行の code リンク・nav との重なり、絞り込み欄の折りたたみ、chip の OR/AND、マトリクスのペア(1年3組+2年1組 の件数と交差0件)は `node scripts/verify-items-page.mjs` をヘッドレス Chrome で確認する(dev サーバ + ローカル Supabase の items が必要)。
  dev フォームと `/api/auth/dev-login` は本番ビルドでは無効(NODE_ENV=production で 404、UI 非表示)。hosted Supabase を指す dev(`npm run dev:tunnel`)でも無効になる(dev ユーザはローカルにしか存在しないため)。
- メール確認リンクの確認は Mailpit (http://127.0.0.1:54324)。

## スマホ(Android / iOS)

- カメラは HTTPS 必須。本番は HTTPS で配信するか、開発中は ngrok/Cloudflare tunnel 等経由。
  (localhost はブラウザが安全とみなすため PC ではカメラ可、スマホからは HTTPS が必要)
- `/scan` のカメラは「スキャン開始」ボタンを押して起動する(`getUserMedia` はユーザー操作が必要)。ヘッドレス Chrome(fake device)での起動検証は `node scripts/verify-camera.mjs`。
- iOS Safari: `playsinline` の video でカメラ連続読み取りに対応(zxing)。
- 背面カメラ優先: `facingMode` は zxing のデフォルトデバイス選択。必要なら QrScanner を調整。

### Cloudflare tunnel で `desktop1.sakurastyle.jp` として開発する

Supabase はブラウザから直接見に行かない(認証・照会すべてサーバー側)ため、**Supabase 自体を tunnel に載せる必要はない**。tunnel が付ける `X-Forwarded-Host` / `X-Forwarded-Proto` から公開 origin を導くので、リダイレクトと OAuth の `redirect_to` はトンネルのホスト名で正しい URL になる(優先順: 設定した `appUrl` → 隧道ヘッダー → リクエストの Host)。2モードどちらでも Supabase が正しく動く:

- **ローカル Supabase + dev パスワードログイン**(UI・カメラ検証用): 通常どおり `npm run dev` + tunnel を dev サーバー(port 3000)へ。「dev ログイン」フォームが出る(`.env.development` の `DEV_ALLOWED_HOSTS` に desktop1 を許可済み)。ローカル gotrue は Google プロバイダ非対応なので Google ボタンは完結しない。
- **hosted Supabase + Google 認証の実検証**: `npm run dev:tunnel`(`.env` の hosted キーを使い、`NUXT_PUBLIC_APP_URL`/`DEV_ALLOWED_HOSTS` を desktop1 に固定)。dev フォームは非表示、`/api/auth/dev-login` は 404。ダッシュボードの Redirect URLs に `https://desktop1.sakurastyle.jp/api/auth-callback` を登録しておくこと。

ローカル Supabase を tunnel に載せるのは避ける(ローカルスタックは dev の共用キーで運用されており、公開するとkeyが漏れる)。

## PWA

モジュールは `@vite-pwa/nuxt`(vite-plugin-pwa ベース、generateSW)。方針は「インストール可能 + アプリシェルキャッシュのみ」。

- **manifest**(`nuxt.config.ts` の `pwa`): name/short_name `Hinotike`、`theme_color`/`background_color` はテーマと同じ `#0f172a`、`display: standalone`、`start_url`/`scope` は `/`。
- **head注入**: `<link rel="manifest">` は `app/app.vue` の `<VitePwaManifest />`(SSR head に出る)。favicon(`public/favicon.svg`、文字なしのQRマーク)と apple-touch-icon は `app.head.link`(Nuxt4に `app.favicon` は無い)。
- **アイコン**: `public/icons/*.png`(192/512、maskable 含む)。元SVGは `docs/icon-drafts/icon-512.svg` / `icon-maskable-512.svg`(案Aのスキャン枠+QRを横帯の上下に配置し、中央に「ひのチケ」を横帯として通す)。再生成は `npm run icons`(`scripts/render-icons.mjs`、chromium でSVG→PNG)。maskable版は全面背景+safe zone(中央80%)にコンテンツを収める。
- **オフライン**: precache はビルド静的資産+manifestのみ。`workbox.navigateFallback: null` — SSRページはネットワーク必須なので SW がフォールバックページを返さない(オフライン時は素直に通信エラー)。API(`/api/*`)と Supabase はキャッシュしない(認証付き動的データ)。
- **SW登録**: モジュールの autoRegister(vite-plugin-pwa の `virtual:registerSW` が client に注入される)。`registerType: autoUpdate` → skipWaiting+clientsClaim。dev では SW 無効(モジュール既定)。
- インストールには HTTPS 配信が必要(localhost は例外扱い)。Android は manifest の maskable icon、iOS は apple-touch-icon でホーム画面アイコンが決まる。

## 必要に応じた調整

- items を jsonb payload ではなく実カラムにしたい場合: マイグレーションと `scripts/sync-sheets.ts`(upsert 部分)と result.vue を調整(一覧側は `shared/utils/items.ts` のキー定数と `payload->>` パス照会も実カラム名に直す。取り込みカラム名は `sync_settings` の include_columns / rename を同じ名前に合わせる)。
- 一覧の表示列を増やしたい場合: `app/components/ItemRow.vue` に `payloadValue(payload, key)` を追加する(`server/api/items-list.get.ts` は payload をそのまま返すので API は変更不要)。
- users の登録をスプレッドシートから行いたい場合: users 用の同期処理を追加(email 事前登録方式と相性好)。
