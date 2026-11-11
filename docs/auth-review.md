# 認証レビュー: hinotike × slack2mail(ECR33/slack2mail)比較

対象: `/home/kenji/dev/hinotike`(Nuxt 4 + `@supabase/ssr` を手動配線)
参考: https://github.com/ECR33/slack2mail.git(Nuxt 4 + `@nuxtjs/supabase`、Google 認証 + Slack OAuth + マルチテナント)

---

## 1. 実装アプローチの比較

| 観点 | hinotike(本アプリ) | slack2mail(参考) |
|---|---|---|
| Supabase 配線 | `@supabase/ssr` を直接利用。`createBrowserClient`(plugins) と `createServerClient`(server/utils) を自前実装 | `@nuxtjs/supabase` モジュール。`useSupabaseClient` / `useSupabaseUser` / `serverSupabaseClient` / `serverSupabaseUser` / `serverSupabaseServiceRole` を借りる |
| セッション保存 | SSR cookie(`sb-*`)。`getAll`/`setAll` は手書き | モジュールの cookie / chunked cookie 運用に委譲。`cookieget-chunked` 等のヘルパもあり |
| ルート保護 | ページ単位 middleware(`definePageMeta({ middleware:'auth' })` in scan/result/unauthorized)。認可判定は `$fetch('/api/me')` | **グローバル** middleware(`app/middleware/auth.global.ts`)。公開ルートをホワイトリストで除外し、デフォルト拒否 |
| 認可モデル | Google 認証済み AND `users` テーブルに `id = auth.uid()` の行があること(単一サイト) | Google 認証済み AND **テナント所属**(`tenant_users`)。`is_member_of_tenant()` を RLS と API 両方から共通利用 |
| ユーザ登録運用 | `users.id` は `auth.users.id` 依存なので、**ログイン前に登録できない**(初回ログイン後に管理者が ID を見て登録する必要がある) | `tenant_users.email_addr` を事前登録し、初回ログイン時に `link_my_tenant_user()`(SECURITY DEFINER)が email 一致で `user_id` を自動紐付け |
| OAuth コールバック | `GET /api/auth/callback` で `exchangeCodeForSession(code)`。`returnTo` をサポート | `GET /api/auth-callback` で交換 → 即 `link_my_tenant_user()` RPC。`returnTo` は無く常に `/select-tenant` |
| サイトルートへ戻るフォールバック | `server/middleware/oauth-root-callback.ts` で `/?code=` を `/api/auth/callback` へ引き継ぐ | Site URL/Redirect URLs を厳密に登録する運用。フォールバック処理なし |
| セカンド OAuth(Slack) | 該当なし | **HMAC 署名付き state**(tenantId, userId, nonce, exp, 5分) + **PKCE code_verifier を httpOnly/lax cookie に保存**、callback で署名・期限・セッション一致・cookie 使い捨てを全検証 |
| サーバ側の認証ガード | 各 API で `getSession()` → `users` 照会をeach実装(me/lookup で重複) | 各 API で `serverSupabaseUser(event)` による 1 行ガード + RLS + RPC 内の `auth.role()` ガード |
| service_role / secret key 運用 | `supabaseAdminClient()` は定義されているが主な API では未使用(RLS 前提) → 方針は一貫 | `serverSupabaseServiceRole` を使うが、DB 関数側で `if auth.role() <> 'service_role' then raise` を二重ガード |
| RLS | `users_self_select`(自分行のみ) / `items_select_for_registered_users`(`exists(users)`) | 全テーブルに `tenant_isolation_{select,insert,delete}`。policy は SQL 関数 1 本に集約 |
| エラーの見せ方 | `?error=<エラーメッセージ文字列>` をそのままクエリに載せ UI に表示 | `?slack_oauth_error=<固定エラーコード>` のホワイトリスト方式で UI 側で文言出し分け |
| ログ/診断 | なし | `server/api/debug-env.ts`(設定の有無のみ返す。Cloudflare env key 一覧も) |
| テスト | なし | `test/supabase/login-to-top-flow.test.ts` など、実ログイン → RPC → 所属チェックまで通す flow テスト、SQL 側テスト(`supabase/tests/*.sql`) |

### 参考リポジトリから学べる良い点
1. **グローバル middleware + 公開ルートホワイトリスト**: 新しいページを作ったときに守り忘れない(デフォルト拒否)。
2. **認可判定の共通関数化**(`is_member_of_tenant`): RLS と API ガードが同じ 1 本。方針が崩れない。
3. **email 事前登録 + 自動紐付け RPC**: 運用(登録作業)が現実的。`users.id` を人間が調べる運用が無い。
4. **state 署名 + PKCE cookie + セッション一致チェック**(`slack/oauth/*`): OAuth の CSRF / リプレイ / 取り違えに対する教科書的な実装。
5. **エラーはコードで返し UI で文言出し分け**: 内部メッセージを露出しない。
6. **コールバックで RPC を呼んで「ログイン確定時にやるべき処理」を 1 回だけ実行**する形。
7. **認証フローそのものをテスト**している(SQL + vitest)。

### 参考リポジトリにそのまま従いたくない点(アンチパターン)
- `auth.global.ts` の所属クエリで `.eq('user_id', user.value.id)` がコメントアウトされ、RLS だけに依存(line 33 付近)。
- `auth-callback.ts` が正常系でも `console.error('exchangeCodeForSession', error?.message)` を実行(情報レベルのログに error を使用)。
- コールバックが `returnTo` を無視して常に `/select-tenant`(UX は hinotike の方が前進)。
- `link_my_tenant_user()` は `SECURITY DEFINER` で `search_path` は固定しているが、**email 一致だけで他人の事前登録行を自分のものにできる**設計。メール検証・ドメイン制限が無いと危うい。
- `debug-env.ts` が Cloudflare の env key 一覧を無認証で返す(名前だけでも情報漏えい)。hinotike では作らない/認証を付ける。
- `loginWithGoogle` が返された `data.url` を見ず、呼び出し側の `window.location.href` 任せでリダイレクト判定が曖昧。

---

## 2. hinotike 側の問題点と改善案(重要度順)

### P0-1 SSR 時に認証 API へ Cookie が渡らず、ログイン済みでも「未認証」扱い
- `middleware/auth.ts:8` と `pages/index.vue:6` の `$fetch('/api/me')` は、SSR(Nitro)から自前 API への**内部リクエストにブラウザの Cookie ヘッダーを引き継がない**。結果 `server/api/me.get.ts:12` の `getSession()` が null になり、`authenticated: false` を返す。
- 実害:
  - ログイン済みユーザが `/scan` を直接(リロード・ブックマーク)開くと SSR 中に `/` へ戻される。
  - トップでログイン済みなのに「Googleでログイン」ボタンが出て、押すと OAuth を一周して戻る。
- 改善(いずれか):
  1. 素直に直す: SSR では `useRequestHeaders(['cookie'])` を転送
     ```ts
     const me = await $fetch('/api/me', { headers: useRequestHeaders(['cookie']) })
     ```
     (middleware / page どちらでも共通の `useMe()` composable に寄せる)
  2. より良い形: **middleware 内で `$fetch` を呼ぶのではなく Nitro 側に `requireUser(event)` を作り、ページ初期化は server API 経由の useState で共有**。ミドルウェアは `event` を持たない Nuxt ルート middleware なので、認証状態は「SSR 初回に server が解決して useState に入れる → client はそれを継ぐ」が安定。
  3. 参考リポジトリ方式: `@nuxtjs/supabase` を使い `useSupabaseUser()` で SSR でも解決された状態を得る。

### P0-2 ブラウザクライアントと SSR クライアントの二重運用
- `plugins/supabase.client.ts` の `createBrowserClient` と `server/utils/supabase.ts` の `createServerClient` が同一ストレージキー(`sb-<ref>-auth-token`)を扱い、トークン不整合や更新失敗の原因になり得る。参考リポジトリはクライアント側もモジュール経由で 1 系統。
- `pages/index.vue:37` の `supabase.auth.signOut()`(ブラウザ側)と `/api/logout`(サーバ cookie 削除)の二重ログアウトは、まさにこの不整合を埋めるための対症療法になっている。
- 改善: **認可フローはサーバ側 1 系統に寄せる**。
  - ログイン開始も `GET /api/auth/login?returnTo=...` を作り、サーバ側 client で `signInWithOAuth(..., { options: { redirectTo } })` → 得た URL へ `sendRedirect`。`skipBrowserRedirect: true` を使う形に統一。
  - ログアウトは `/api/logout` のみ(`signOut()` の二重呼び出しを撤去)。ブラウザ client は QR スキャン以外の用途には使わない。

### P0-3 `returnTo` のオープンリダイレクト(相対指定が不十分)
- `server/api/auth/callback.get.ts:29`, `server/middleware/oauth-root-callback.ts:14`, `pages/index.vue:11` はいずれも `startsWith('/')` のみ。`//evil.example.com` や `/\evil.example.com` が通ってしまい、外部ドメインへリダイレクトし得る(コールバックは外部サイトから飛んでくる経路なので特に悪い)。
- 改善: アプリ全体で共通の検証関数を 1 本
  ```ts
  const isSafeLocalPath = (p: unknown): p is string =>
    typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\')
  ```
  参考リポジトリの Slack コールバックは「遷移先を DB から解決した slug に限定」しており、この発想(whitelist)が最も安全。

### P0-4 エラーメッセージをそのまま URL / UI に露出
- `server/api/auth/callback.get.ts:23,26` が `error.message` を `/?error=` に載せ、`pages/index.vue:47` が `認証エラー: {{ oauthError }}` で全文表示。Supabase / Google の内部メッセージがそのまま画面に出る。
- 改善: 参考リポジトリの `SlackOAuthErrorCode` 方式を見習い、`?error=not_configured|no_code|exchange_failed|access_denied|...` の固定コードに変換して UI で文言出し分け。元メッセージはサーバログのみ。

### P1-1 `setAll` で cookie の `maxAge` が失われ、セッション cookie 化している
- `server/utils/supabase.ts:23-33` は `options.expires` しか渡しておらず、`maxAge`(および `domain`)を無視している。Supabase が「記憶する」意図で出す有効期限がブラウザ終了まで失効しない cookie に化ける。スマホ(アプリ杀掉进程)で logout 相当になり得る。
- 改善: `maxAge: options.maxAge` を素直に渡す(または `@supabase/ssr` の `cookieToHeader` / 標準テンプレートを利用し、手書きパースをやめる)。

### P1-2 ルート保護の「つけ忘れ」リスク
- hinotike は `definePageMeta` のページ単位 middleware。参考リポジトリは `auth.global.ts` + 公開ルート配列でデフォルト拒否。
- 改善: `middleware/auth.global.ts` に移行し、`const publicRoutes = ['/', '/login', '/unauthorized']` 方式へ。`/unauthorized` は本来「認証済み・未登録」専用なので、middleware から直接飛ばすなら**ログイン状態を条件付きで公開扱い**にするなど、参考実装より一段丁寧に設計する。

### P1-3 サーバ API のガードが重複・手コピー
- `server/api/me.get.ts:11-27` と `server/api/lookup.post.ts:10-24` が session 取得 + `users` 照会を重複。追加 API でコピー漏れが起きると認証だけの穴になる。
- 改善: `server/utils/guard.ts` に `requireRegisteredUser(event)` を作り、`me`/`lookup` から呼ぶ。返り値で `session` と `userRow` を共有する。参考リポジトリの `is_member_of_tenant()` と同じ思想(SQL 側 1 本 + API 側 1 本)。

### P1-4 `oauth-root-callback.ts` のフォールバックは運用で消すべき
- Site URL ルートへ `?code=` が飛んでくるケースを救済しているが、README 自身が指摘するとおり別オリジンでは PKCE verifier が無いため交換できない。「動くが半分壊れる」状態を作るくらいなら、Redirect URLs 登録を厳しくし、フォールバックは **警告ログ + `/api/auth/callback` への 1 回だけの変換** に絞る(現状はほぼそれで OK。`returnTo` 検証は P0-3 に合わせて修正が必要)。

### P1-5 Supabase OAuth の `state` 系チェックが自前でない
- `@supabase/ssr` の PKCE(code_verifier cookie)に依存するのみで、`state` 相当の CSRF ガードや「認可開始時ユーザとコールバック時ユーザの一致」検証はない。参考リポジトリの Slack 実装(state HMAC 署名 + exp + nonce + `user.sub` 一致 + cookie 使い捨て)はこの点の模範解。
- 改善: 認証後の一般ユーザにとっての被害は限定的だが、`/api/auth/callback` が任意の `returnTo` を接受する現状(P0-3)と組み合わせるリスクとして、`skipBrowserRedirect: true` + 自前 state cookie(署名 + 短 TTL + 使用済み削除)を入れる価値がある。

### P1-6 users テーブル運用(登録オペレーション)が現実的でない
- `users.id` が `auth.users.id` 依存なので、**管理者が初回ログイン後の ID を調べてからでないと登録できない**。参考リポジトリは email 事前登録 + 自動紐付けでこれを回避している。
- 改善(hinotike でやるなら):
  - `users` を `id uuid references auth.users` + `email text unique` にし、`email` で事前登録できるようにする(Sheets からの同期なら相性が良い)。
  - 紐付けは DB 関数 `link_my_user()`(`SECURITY DEFINER`, `set search_path = public`, 認証済み前提、**verified email 一致のみ**、ドメイン制限を併用)をコールバックで 1 回呼ぶ。参考実装と同じ形。
  - 注意: email 一致の自動紐付けは「事前にメールを登録しておけば、そのアドレスの Google アカウントで誰でも入れる」構造になる。Google Workspace のドメイン制限、`auth.users.email_confirmed_at` 確認、または「ログイン後に確認コード」のいずれかとセットにする。
- 併用案(安全側): 事前登録は email で受け、`users` 本体への反映は `link_my_user()` で `id` を埋めるが、`email_verified` と許可ドメインのチェックを関数内に置く。

### P1-7 items RLS ポリシーの `users` 参照と自己参照の潜在リスク
- `supabase/schema.sql` の `items_select_for_registered_users` は `exists (select 1 from public.users u ...)`。`users` 側の `users_self_select` は自分自身の行を `users` から読む自己参照で、RLS ではトリガーの再帰が起き得る(Supabase は `auth.uid()` 系なら安全側へ倒すが、`users` を RLS 越しに読む形は避けたい)。
- 改善: 参考リポジトリと同じく SQL 関数 1 本に集約する。
  ```sql
  create or replace function public.is_registered_user()
  returns boolean language sql stable security invoker set search_path = public as
  $$ select exists (select 1 from public.users u where u.id = auth.uid()) $$;
  ```
  policy は `using (public.is_registered_user())`。関数化で評価が 1 段になり、API 側とも同じ 1 本を共有できる。あわせて `items` の `code` に index 確認、`payload` の秘匿レベル見直し。

### P2 追加で入れておきたいもの
- **設定ヘルスチェック API**(`server/api/health.get.ts`): 参考リポジトリの `debug-env.ts` 相当。ただし**値も key 名も出さず真偽のみ**、可能なら secret header 必須。Cloudflare env key 一覧は無認証で返さない。
- **`allowedHosts` のハードコード除去**(`nuxt.config.ts:16` の `desktop1.sakurastyle.jp`)。すべて `.env` の `DEV_ALLOWED_HOSTS` に寄せる。
- **`nuxt.config.ts` に `supabase` 系デフォルト値の起動時検証**(空なら dev では警告、prod では fail)。
- **テスト**: 参考リポジトリの `test/supabase/login-to-top-flow.test.ts` / `supabase/tests/*.sql` を模して、
  1. code 交換 → `/api/me` → `users` 未登録なら 403、
  2. `returnTo` に `//evil` を入れてもローカルに留まる、
  3. 未認証で `POST /api/lookup` → 401、
  4. RLS: 未登録ユーザが `items` を select できない、
  を押さえる。
- **secret key 運用の明確化**: `supabaseAdminClient()` は使われていない。同期スクリプト専用とコメントで明記し、API から呼ばない方針を固定(参考リポジトリの `auth.role()` ガードのような DB 側ガードは、hinotike では RLS 1 本で統一する方が単純)。

---

## 3. 推奨着手順

1. `isSafeLocalPath()` 共通化で P0-3 を潰す(1 行 × 3 箇所 + コールバック)。
2. エラーを固定コード化する(P0-4)。
3. `middleware/auth.global.ts` 化 + `useMe()` で Cookie 転送(P0-1)、`setAll` の `maxAge` 修正(P1-1)。
4. ログイン/ログアウトをサーバ側 1 系統に統一(P0-2)、`requireRegisteredUser(event)` 共通化(P1-3)。
5. `users` を email 事前登録 + `link_my_user()` に変更(P1-6)+ ドメイン制限。RLS 関数化(P1-7)。
6. health API / 設定検証 / テスト(P2)。
