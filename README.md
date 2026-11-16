# Hinotike

Nuxt 4 + Supabase + Google 認証の QR 照会 Web アプリの雛形。
認証は slack2mail の設計(simply: モジュール委譲・グローバルミドルウェア・email 事前登録+自動紐付け・SQL関数集約)を単一テナント版として取り入れています。テナント対応はありません。

ディレクトリ構成は Nuxt 4 の srcDir に従う: エントリ・ページ・components・composables・middleware・types は `app/` 配下(`app/app.vue`, `app/pages`, `app/components`, `app/composables`, `app/middleware`, `app/types`)。ルート直下の `components/` や `app.vue` は srcDir 外なので読み込まれない。サーバーコードは `server/`、共有ユーティリティは `shared/`(ルート直下、`#shared` で参照)。

## 構成

| 画面 | 認証 | 用途 |
|---|---|---|
| `/` | 不要 | トップページ。状態に応じてログイン/QRリンク |
| `/login` | 不要 | ログインページ(未認証時はグローバルミドルウェア从这里へ) |
| `/scan` | 必要 | QRコードをカメラで連続スキャン(`qr-scanner`)。**モード選択**で「照会」(従来: 1読み取りごとに `/result` へ遷移)と「記録」(連続で次々と読み、シートへ書く)を選べる。詳細は下の「スキャンの記録」 |
| `/records` | 必要(登録済み) | スキャンの記録履歴(`scan_events`)の閲覧。モード・状態・code・期間で絞り込み + seq 降順のカーソル分页。監査用(証跡は update/delete 不可) |
| `/scan-settings` | 必要(登録済み) | 記録モードの設定画面: 追加・変更(名前・書く列の組・フラグに書く値・payload キー・確認/連続・重複・見つからない code・有効無効)・削除・シートの列追加。既定の2モードも DB のシード行なので同じように編集・削除できる |
| `/result` | 必要 | QRの値(または一覧の行)で Supabase `items` を照会し、カード形式で結果表示。このコードのスキャン記録履歴(日時付き・新しい順)も同じカードに出す |
| `/items` | 必要 | `items` のレコード一覧(スクロールで追記 + code/氏名/備考のインクリメンタル検索 + 折りたたみできる年・組の絞り込み[単独 chip / 年×組マトリクス] + 折りたたみできる備考の絞り込み[有無の3ボタン + 部分一致] + 折りたたみできる任意 payload キーの絞り込み[キーの有無 + 値選択 + 部分一致] + 表示のみのキー選択 + 条件リセット + 行を開いても絞り込み状態を保持) |
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
| 認証済み・許可済み | トップ / QRスキャン(`/scan`) / 一覧(`/items`) / 管理(dropdown: アプリ共有`/share`・利用者登録`/register`・同期`/sync`・記録の設定`/scan-settings`・記録履歴`/records`・ログアウト) |

- 管理系項目は「管理」ボタンの dropdown menu にまとめて常駐バーの項目数を抑える(dropdown はバーの上に開く。外側クリック / Escape / ルート変更で閉じる。格納先ルート(`/share`・`/register`・`/sync`・`/scan-settings`・`/records`)にいるとき「管理」が点灯し、menu 内の現ページは `aria-current="page"`)。許可依頼は未登録ユーザの主動作なのでバーに直接残す。
- ログアウトはルートではなく action(`useLogout()` → `POST /api/logout` → `/`)。ページ内の「ログアウト」ボタンは重複なので撤去した(`/index`・`/login`・`/scan`・`/register`・`/unauthorized`)。バー時代のログアウトは dropdown 内(dropdown 項目は route を変わらないので選択時に自前で閉じる)。
- `/result` では QRスキャン が点灯する(スキャンの延長という扱い)。
- 未認証時に保護リンクを出さない理由: ミドルウェアが `/login?returnTo=` に誘導するため、押しても遷移しない(出すと「動かないリンク」になる)。
- `app.vue` の render はミドルウェア(NuxtPage の setup)より先に走るため、BottomNav は SSR で未缓存の `auth-state` を自分で解決して缓存に入れる。ページ(`index`/`login`/`unauthorized`)も同じ缓存を再利用するので `/api/me` の重複照会にならない。
- バーは `position: fixed` なので `.page` の下端 padding を `calc(90px + env(safe-area-inset-bottom))` にしてコンテンツを隠れないようにする。

### レコード一覧(`/items`)

- **API**: `GET /api/items-list`(`requireRegisteredUser` → RLS `items_select_registered_users` と同じ根)。絞り込み参数は `code` `name` `years` `groups` `pairs` `remark`(部分一致) `remarkState`(`present|absent`、省略=条件なし) + `filters`(任意 payload キーの絞り込み。`key|mode|value` 形式で mode は `present|absent|contains|in`。配列参数でもカンマ区切り文字列でも受け取る。詳細は下の「任意 payload キーの絞り込み」) + `cursor` `limit`。応答は `{ rows, nextCursor, total }`(`total` は exact count の一致総件数)。
- **分页は code(PK)昇順のキーセットカーソル**: `code > cursor` を次ページとして読む。offset と違い、検索条件を変えても既存ページの先頭がずれない(スクロール追記で重複・取りこぼししない)。1バッチは `ITEM_PAGE_SIZE`(25、API側で 1〜100 に補正)。
- **分页は code(PK)昇順のキーセットカーソル**: `code > cursor` を次ページとして読む。offset と違い、検索条件を変えても既存ページの先頭がずれない(スクロール追記で重複・取りこぼししない)。1バッチは `ITEM_PAGE_SIZE`(25、API側で 1〜100 に補正)。
- **検索は部分一致(ilike)**: code は `code` カラム、氏名と備考は payload のキーを jsonb パス `payload->>"氏名"` / `payload->>"備考"` で照会する。入力の `%` `_`(と `\`)はリテラルにエスケープし、任意文字扱いにならない(`shared/utils/items.ts` の `containsPattern`)。長い入力は上限で切る(高コストな照合防止)。
- **全件を一括で出さない UI**: 末尾の sentinel が画面に出た時点で IntersectionObserver が次のページを読み、sentinel がまだ見えている限り自己継続して追記する(1バッチで viewport が埋まらない場合も続く)。IntersectionObserver が無い環境は「次の25件を表示」ボタンにフォールバックする。IO の有無はクライアントでしか分からないので、判定は `ref(false)` の初期値(SSR とクライアントの初回描画を一致させる)+ `onMounted` で実際の判定という2段にしている(単なる `typeof` 判定だと SSR がフォールバックボタンを描いて hydration mismatch になる)。
- **インクリメンタル検索**: 入力は 250ms のデバウンスでまとめ(code・氏名・備考の3欄を同時に扱う)、条件が変わるたび reset + 1ページ目から取り直す。応答は generation で比較し、後発の検索に負けた古い応答は適用しない(連打の乱順応答で古い条件の結果に戻るのを防ぐ)。URL とは同期しない(`?code=&name=&years=&groups=&pairs=&remark=&remarkState=&filters=&showKeys=` は初期値としてだけ読む)。
- **入力の消去**: `app/components/ClearableInput.vue`(値があるときだけ右端に消去ボタンが出て、押すと空にする。Vuetify の `clearable` 相当)。このプロジェクトには Vuetify を入れていないので自前部品で同じ挙動を出す。
- **年・組の絞り込み(2モード)**: 絞り込み欄は折りたたみできる(`aria-expanded` のトグルボタン、閉じても選択状態はラベルに残る。縦に場所を取る年9×組5のマトリクスを普段は畳むため)。`app/pages/items.vue` のモード切替で「年・組を単独で」と「年と組の組み合わせ」を選ぶ。**単独モード**は `app/components/FacetChipGroup.vue` の chip 多选択で、同一 facet 内は OR(`in.()` に複数値)、年と組の間は AND(`in.()` を2つ重ねる)。**組み合わせモード**は `app/components/YearGroupMatrix.vue`(行=年、列=組のマスを選び、選んだ「その年 + その組」だけを対象にする)。マスの件数は `facets.pairs` から、0件のマスは `disabled`(`–`)。
- **ペアの照会**: `GET /api/items-list?pairs=1:3,2:1`(`shared/utils/items.ts` の `parsePair`/`normalizePairs`/`pairConditions`)。各ペアは 年 AND 組、ペア同士は OR。PostgREST の nested logic は `or=(and(payload->>"学年".eq."1",payload->>"クラス".eq."3"),and(...))` の形で、`and=(...)` ではなく `and(...)` の構文が必要(nested の `and=` は PGRST100 エラー)。パスは `payloadTextColumn(key)` の引用形(`payload->>"学年"`)で組み立て、値も `quoteInValue` で引用する(`.` `,` `"` を含む値でも安全)。単独選択(years/groups)と同時に送ると単独条件とペアの AND になるが、UI はモード切替でもう一方の選択を消すので同時に送らない(見えない選択が条件に残らない)。ペア上限は `ITEM_PAIR_MAX`(60)。
- **備考の絞り込み(折りたたみ欄)**: 条件指定領域を大きくしないため、備考も年・組と同じ折りたたみ欄にする。3つのトグル(年・組/備考/項目)は `.filter-toggles` の1行に並び(ラベルは「年・組 (…)」「備考 (…)」「項目 (…)」と短い状態語だけで mobile でも折り返さない。開閉の意味は `aria-label` で伝える)、閉じた状態では縦の増分は0で、閉じていても選択状態はラベルに出る(「すべて/あり/なし」+ 検索語があれば「「振込」」)。開くと **有無の3ボタン**(すべて=条件なし / あり / なし。`aria-pressed`、デバウンスを待たずに即適用)+ **備考の部分一致入力**(code・氏名と同じデバウンス)だけが増える。
- **備考の有無の照会**: 列は `payload->>"備考"`(`ITEM_REMARK_KEY`)。**あり** = `payload->>"備考".not.is.null` + `payload->>"備考".neq.""`(空文字を「なし」側へ寄せる)。**なし** = `shared/utils/items.ts` の `remarkAbsentConditions()`(=`keyAbsentConditions(ITEM_REMARK_KEY)` のラッパー) → `or=(payload->>"備考".is.null,payload->>"備考".eq."")`(キーの欠落・null・空文字を包含)。空白のみの備考は照合側で trim できないため「あり」側に残る(備考の保存は trim するので通常起きない)。なしの `or=` はペア指定の `or=` とは**別の `or=` として**重ねる(PostgREST は複数の `or=` を AND で結合するので、年×組の対応指定と同時に使える — `test/supabase/items-remark-filter.test.ts` で実挙動を確認する)。有無・文字検索・他の条件はすべて AND(「なし + 検索」は 0 件)。備考の有無の件数は facets API では返さない(選択肢は年・組だけ。有無は2択なので件数なしで絞れる)。
- **任意 payload キーの絞り込み(折りたたみ欄「項目」)**: ボランティアのように同期設定で決まる任意のキーを、コード変更なしで絞り込み・表示できるようにする。キーの候補は `GET /api/items-keys`(`requireRegisteredUser`)がunionで出す: `sync_settings` の `includeColumns`(空なら全カラム、`codeColumn` は除外、`rename` 適用後のキー名)+ payload をスキャンして実データに現れたキー(`ITEM_FACET_SCAN_LIMIT` 上限、`truncated` 付き)。応答は `{ keys: [{ key, presentCount, absentCount, options, fromConfig, seenInData }], scanned, truncated }`。同期設定にあってまだデータに無いキーは「(同期待ち)」badge で出る。UI は専用キー(学年/クラス/氏名/備考)を項目欄から除外する(二重コントロール防止)。各キーに **有無ボタン**(あり=present / なし=absent。再押で解除。件数付き)と **値 chip**(選択肢 ≤ `KEY_CHIP_MAX` なら `FacetChipGroup` で多选択=同一キー内 OR)と **部分一致**(キー select + 語入力。1キーのみ)。複数のキー条件はすべて AND で重ねる(URL では `filters=key|mode|value` を複数送れる。上限 `KEY_FILTER_MAX`=8)。照会はいずれも `payloadTextColumn(key)` のパス照会(present=`.not.is.null`+`.neq.""`、absent=`keyAbsentConditions` の `or=`、contains=`ilike`(リテラルエスケープ)、in=`in.()`)。**検索可能なキーの条件**は `shared/utils/items.ts` の `isFilterableKey`: キー名に `"` を含まない + 長さ ≤ `KEY_NAME_MAX_LENGTH`(40)。`"` を含むキーは PostgREST/supabase-js のパス照会が壊れる(`.or()` は parse エラー、`.not()` は黙って 0 件になる。`%22` エスケープでは救えない — `test/supabase/items-key-filter.test.ts` で実挙動を固定)ので、UI はボタンを disabled にして「表示のみ」に注記し、`parseKeyFilter` はそのキーの filters を null で捨てる(黙って全件になる条件を許さない)。長いキーも切断せず reject(別のキー名 の prefix に化けるのを防ぐ)。
- **表示のみのキー選択**: 「行に表示する項目」の chip で選んだキーの値が `app/components/ItemRow.vue` の `.item-extras`(「キー: 値」の span 群。年・組・氏名は本体に出ているので除外)に追加される。絞り込み条件ではない(総件数は変わらない)のでリセットでも消えず、`useState` + localStorage(`items-show-keys`)に保存し、`?showKeys=` は初期値としてだけ読む。
- **条件のリセット**: 「条件をリセット」ボタンで code・氏名・年・組・ペア・備考の有無と検索・任意キーの有無/値選択/部分一致を一度に消す(chip・マス・有無ボタン・リセット・モード切替はデバウンスを待たずに即適用)。条件がなければボタンは無効。モード自体は維持する(絞り込み欄を開き直して続きを選ぶ)。表示のみのキー選択は条件ではないのでリセットでも消えない(localStorage に残る)。
- **行を開いても絞り込み状態は消えない**: ページは `definePageMeta({ keepalive: true, scrollToTop: false })`。行タップで `/result` に開いて一覧に戻ると(「一覧に戻る」でもブラウザの戻るでも)、入力・chip・マトリクスの選択・備考の有無と検索入力・任意キーの有無/値/部分一致の選択・表示のみのキー選択・絞り込み欄の折りたたみ・読み込み済みの行・スクロール位置がそのまま復活する(`GET /api/items-list` の再fetch なし。絞り込み結果が複数あるとき1件ずつ開いて確認する用途)。keepalive はクライアント側の保持(component instance + DOM を deactivate するだけ)なので SSR の描画は毎回通常通り走る。表示/非表示の切替点は navigation guard で扱う — Nuxt は page component そのものを cache しない(Suspense/RouteProvider の vnode を cache する)ため、page 側の `onActivated`/`onDeactivated` は呼ばれない(Vue の KeepAlive は cache された instance の hook しか invoke しない)。`scrollToTop: false` は既定の「別ページへ遷移したら top にスクロール」を止めるので、去る時の位置を `scrollTo` で戻せる。去る時にデバウンス中の入力は確定させる(戻ったとき一覧の条件が入力欄とズレない)。非表示中は sentinel が detach 済みで「見えている」扱いになるため、`pageActive` の旗で追記を打ち切る(非表示中に全件を読み進めない)。条件は URL に写らないままなので、画面更新(再SSR)では URL の初期条件に戻る。
- **行部品**: `app/components/ItemRow.vue`(年/組/氏名/code の4要素 + `extraKeys` で追加した表示キーの値を `.item-extras` に「キー: 値」で並べる)。静的に表示列を増やしたいときはこの部品に `payloadValue(payload, key)` を足すだけで、ページと API は変更不要(API は payload をそのまま返す)。動的な追加は画面の「行に表示する項目」で選べる(上の「表示のみのキー選択」)。行全体が `/result?code=…` のリンク(行の中は span だけにして入れ子のリンクを作らないので、行まるごとタップでスキャンと同じ照会結果画面へ遷移する。当たり面积は min-height 44px)。
- **payload キーの集中**: 表示・検索に使う固定キーは `shared/utils/items.ts`(`ITEM_YEAR_KEY`/`ITEM_GROUP_KEY`/`ITEM_NAME_KEY`/`ITEM_REMARK_KEY`)。`scripts/columns.config.json`(rename 含む)と一致させること。一覧の備考検索と有無の絞り込みも同じキーを読むので、rename 後のキー名を変えたらこの定数だけ直せば追随する。**固定していないキー**(ボランティアなど)は定数を増やさない: パス組み立て(`payloadTextColumn`/`escapePayloadKey`)・条件語(`keyAbsentConditions`/`parseKeyFilter`/`normalizeKeyFilters`/`serializeKeyFilters`)・キー発見(`GET /api/items-keys` が `sync_settings` の includeColumns/rename と実データスキャンから導く)が `shared/utils/items.ts` と API に集約されているので、同期設定を変えるだけで新しいキーが絞り込み・表示に現れる。
- `/scan` の「手入力(テスト用)」欄は撤去した(dev 限定の gating はなく、本番でも常に表示されていた)。code を直接照会したい用途は `/items` の code 検索が同じ役割を果たす。

### 照会結果(`/result`)

- **入口**: QRスキャンの検出(`/scan` の `navigateTo`)と、`/items` の行タップ(行リンク)。どちらも `/result?code=…` の SPA 遷移。
- **API**: `POST /api/lookup`(`requireRegisteredUser`)は `{ found, code, row }` を返すだけ(表示の整形は画面側)。SSR で解決して `useState` で hydration に引き継ぎ、client-side遷移で code が変われば再照会する(旧結果の残存防止)。
- **カード表示**: 1枚のカードに見出し(氏名を大きく + 年組のタグ + 入金状況のタグ + コード)を作り、その下に **まとまりの枠** を並べる。
  - `.money-panel`: 購入金額・入金額・支払い方法を1つの枠に格子で並べる(3セル揃うとき3列、欠けるセルは2列 + 支払い方法が狭い画面で1行占有)。個数系や入金状況は枠に入れない。
  - `.product-panel`: 商品と個数を1つの枠にまとめる。見出しに `合計 N個` と `1商品あたり最大6個`、各行は 商品名 + 星のスロット6個(`★` が個数、`☆` が残り)+ 数字の個数(`N個`)。星は飾りなので `aria-hidden` を付け、スクリーンリーダーには数字だけを読む。0個は星を薄くして数字で 0個 を出す。想定外の6個超の値は星を6個まで埋めて数字はそのまま表示する。
  - 残りは `.result-list`(`dl` の `.result-row`)のラベル/値のリスト。狭い画面(<460px)ではラベルを値の上に回す。
- **縦詰め**: 見出し・金額枠・商品枠・残り項目をカード1枚に詰め、390×720 の viewport で結果画面はスクロールしない(検証: `node scripts/verify-items-page.mjs` の `縦詰め` 行)。枠の padding と行の padding は狭めに固定する。
- **並びと整形**: 見出しに出すキー(氏名/学年/クラス)、枠に出すキー(購入金額・入金額・支払い方法)、入金状況のタグ、個数系キーはリスト側で重複表示しない(`entries` の `taken` で除外)。リストは 領収書 → 備考 → その他(元の順) → 取り込み日時。金額系は 3桁区切り + 円、空の値は行を出さない(備考は下の編集行で必ず出す)。キー名は `scripts/columns.config.json` と合わせる(`shared/utils/items.ts` の定数を使う)。
- **備考のインライン編集**: 備考行だけ「編集」ボタンを添える(備考が空/欠落の行も必ず出し、空行の編集が「追加」の入口になる)。textarea に書いて「保存」すると `POST /api/remark-update`(`requireRegisteredUser`、body `{code, remark}`、上限 `REMARK_MAX_LENGTH`)へ。API は code から備考セルをその場で引く(ヘッダー=1行目、列名は rename の逆引き = `shared/utils/sync.ts` の `sourceColumnFor`、セル番地は `a1Cell`)し、Sheets の `values.update`(RAW)でシートへ書き、同じ値を items payload にも反映する(空の備考はキー削除 = 取り込み側の empty skip と同じ挙動)。シートが正なので書き込み順はシート→DB で、DB 更新だけが失敗したときは `dbUpdated: false` を返して画面に注記を出す(シートは保存済みなので次の同期で一致する)。保存成功後はローカルの result を更新して再fetchしない(画面に即反映)。code が変わったら編集状態は閉じる。
- **SSR/クライアントで同じ文字列にする**: `toLocaleString` や `localeCompare` は ICU の挙動差で hydration mismatch の原因になるので使わない(3桁区切りは正規表現、個数系の並びは code point 順、取り込み日時 JST 表記は手計算)。
- **code が無い/見つからない**: code 無しは照会しない(API は 400 を返すだけ)し、案内カードを出す。見つからない場合もコードを添えた案内カードを出す。戻るボタンは「スキャンに戻る」と「一覧に戻る」の2つ。

## スキャンの記録(`/scan` の記録モード、`/scan-settings` の設定、`/records` の履歴)(設計: `docs/scan-modes.md`)

QR読み取りを「照会」ではなく「記録」にも使えるようにする。モード単位で「何を・どの列に・確認してからか」を決め、記録はスプレッドシートへ書き、証跡は `scan_events` に残す。

- **モード(`public.scan_modes`、マイグレーション 0006)**: `{ name, actions(jsonb), dedupe(warn|skip|allow), confirm_before_record, require_found, enabled }`。`actions` は1モードに1〜3個(`SCAN_ACTIONS_MAX`)で、各 action は `{ column, columnAt, literal, payloadKey, payloadAtKey }`(シートに書く列と payload に載るキー)。シート/DB は snake_case、画面/API は camelCase なので `shared/utils/scan.ts` の `normalizeAction` が両方読む。
  - シードは2モード: 「チケット配布」(配布済 / 配布日時、`confirm_before_record=false` = 連続)と「チェックイン」(来場済 / 来場日時、`confirm_before_record=true` = 氏名を確認してから記録)。**この2つはマイグレーションの insert で作られた DB の行**なので、他のモードと同じように編集・削除できる(コードに埋めた既定値ではない。`scan_modes` が空のときだけ既定プリセットを画面に表示し、保存で行が作られる)。
  - 増減・変更は `/scan-settings`(設定画面)からまとめて行える。`/scan` の「新しい記録を作る」でもその場で作れる(スキャン画面から運用を始められる導線)。どちらも `POST /api/scan-config` に**ドラフトのリストを丸ごと**送る(リストが正 = 無い id は削除)。履歴のあるモードは FK が `on delete restrict` なので削除できず、400 で「無効化してください」を案内する(設定画面では有効/無効のトグルが並ぶ)。
  - RLS は `sync_settings` と同じ「登録済みユーザのみ」(select/insert/update/delete)。`scan_events` は select/insert のみ(update/delete ポリシーなし = 証跡は不変)。
- **API**: `GET/POST /api/scan-config`(モード一覧 + `serviceAccountConfigured` + `syncIncludeColumns` + `rowMissing` + `sheetTitle`/`sheetHeaders`。シートの実ヘッダーは設定画面の「列が無い」判定用に読むだけで、読み取り失敗・未設定は `null` にする(API は落ちない — SSR がシート読み取りの失敗で落ちないようにする)、`POST /api/scan-check`(`{modeId, code}` → 氏名・現在の済/未・読み取り時刻。シートへ書かない読み取り専用)、`POST /api/scan-flush`(`{codes: [{code, overwrite}]}` → シートへまとめて書き、items payload に反映、`scan_events` に証跡)、`POST /api/scan-columns`(`{columns, addToIncludeColumns}` → シートの列を `spreadsheets:batchUpdate` の `appendDimension` で追加しヘッダーを `values.update` で書く。既定 grid 拡張に頼らない。`addDimensionRange` は spreadsheet 単位の endpoint に無いリクエストなので 400 になる(シート単位の endpoint の SheetContentRequest)。`codeColumn` は載せない)、`GET /api/scan-history`(mode/status/code/from/to + `cursor`(seq)/`limit`、`{ rows, nextCursor, total }`)。
- **シートの値と表示**: フラグ列には `SCAN_FLAG_VALUE`(`済`)、日時列には `formatJst()`(手計算の `YYYY-MM-DD HH:mm (JST)`。`toLocaleString` は環境差になるので使わない)。payload にも同じ2キーを載せる。表示側の「済/未」は `recordState()` で正規化する(空・`未`・no/false/ng は未。フラグが空でも日時があれば済)。
- **書き込みはまとめる**: check は読み取り専用で、連続モードは5件(`SCAN_AUTO_FLUSH_COUNT`)ため自動 flush + 「書き込みを確定」ボタンでまとめて flush(`values:batchUpdate`、1 range = 1セル、`SHEETS_BATCH_MAX`=100)。確認モードは「記録」ボタンで1件を確定した瞬間に flush する(確認したのに5件ためるまで書されないのは不自然)。シートが正なので書き込み順はシート→items(`remark-update` と同じ)。items の更新が失敗したぶんは `dbUpdated: false` と注記で出す(シートは保存済み、次の同期で一致する)。
- **payload が消えないための注意**: 同期の upsert は payload を丸ごと書き換えるため、記録列を `sync_settings.include_columns` に載せないと次の同期で payload から消える。`POST /api/scan-columns` は列作成時に `include_columns` へ追加する(`addToIncludeColumns: false` で抑制可)。
- **重複(dedupe)**: 同じ code を `SCAN_DEDUPE_WINDOW_MS`(2.5秒)内で再読するとスキャン側で無視(`isSameScan`)。直前の読み取りは `useState('qr-last-scan')` に置く(`app/components/QrScanner.vue`)ので、スキャナーの再マウント(モード切替や、結果画面から戻ったときの自動再開)で窓がリセットされず、手元にある同じQRをすぐ再読しない。モードの `dedupe` は `warn`(既定・書き込まない、確認モードの「上書き」だけ `overwrite` で書く)/ `skip`(`skipped` の証跡だけ残す)/ `allow`(上書きして `duplicate` の証跡に上書き事実を残す)。
- **シート索引のキャッシュ**: code→行番号の索引はプロセス内キャッシュ(TTL 60秒)。列追加後は `invalidateSheetIndexCache` で捨てる。サービスアカウントは対象シートの**編集者以上**が必要(読み取りは readonly スコープのまま)。
- **画面**: `/scan` は `definePageMeta({ keepalive: true, scrollToTop: false })`(モード選択・セッションの待機列・作成欄が `/result` に開いても残る)。`app/components/QrScanner.vue` に `continuous` / `busy` props を追加(連続スキャンは検出しても止めない。`busy` の間の検出は捨てる)。`/records` は SSR で1ページ目を解決して `useState` に引き継ぎ、絞り込み変更で reload、`さらに表示` で seq カーソルの追記。`/scan-settings` は DB の値をドラフトとしてコピーし(`useState`)、編集したら「変更を保存」でリストを丸ごと POST、「変更を破棄」で DB の値を引き直す(保存していない変更はラベルに出る)。
- **照会 → 結果 → 「スキャンに戻る」は自動再開する**: 照会モードは検出1回で `stop()` して `/result` へ遷移し、`/scan` は keepalive で生存するので、そのまま戻るとカメラが止まったまま(「スキャン開始」を再度押す必要)になっていた。運用は「照会 → 結果を確認 → 次のQRをそのまま読む」なので、**戻ったらスキャナーを再マウントして自動再開する**(`app/pages/scan.vue` の `router.afterEach` で `/scan` への遷移を拾って `remountScanner()`。`useRoute()` を `watch` すると keepalive のページでは遷移を拾えない — 実測で発火しなかった)。ただし「スキャン停止」ボタンでの停止はユーザーの意思なので、`useState('qr-scan-stopped')`(停止時に true、`start()` で false)で意思を引き継ぎ、戻っても自動再開しない(「開始ボタンで再開できます」のまま)。照会モードも窓内の再読は無視するので、戻った直後に手元の同じQRを映しても「戻る → 即結果」の往復にならない。
- **列が無いときの注記(失敗を先に伝える)**: モードの書く列がシートのヘッダーに無いと flush は 400 になる。`/scan-settings` は各モードの列が `sheetHeaders` にあるかを見て「シートのヘッダーにありません」+「シートの列を追加」ボタンを出し、`/scan` は選択中のモードの欠け列を error で出す。取り込みカラムに無い列も「載せないと次の同期で payload から消えます」の注記と追加ボタンを出す。列の作成と書き込みには サービスアカウント鍵(`GOOGLE_SERVICE_ACCOUNT_JSON`)+ シート ID(`sync_settings.spreadsheet_id`)が必要なので、ローカル dev で列作成を試すときは `GOOGLE_SERVICE_ACCOUNT_JSON` を env に渡して dev サーバを起動する(`npm run dev` は `.dev.vars` を process.env に写さないため、鍵が無いと 400 の鍵エラーになる — 列追加が失敗したときはまずこれ)。
- **検証**: `node scripts/verify-scan-record.mjs`(dev サーバ + ローカル Supabase + シート設定。連続スキャンで3件のQRを順に流し、待機列に氏名が並ぶことを確認)。`VERIFY_SCAN_FLUSH=1` を付けると「書き込みを確定」まで実行し `/records` の履歴も確認する(**設定されたシートに 配布済/配布日時 を書く**ので、ローカルの dev シートに対してだけ実行すること)。設定画面の増減・変更・削除と導線は `node scripts/verify-scan-settings.mjs`(使い捨てのモードを「既存の列だけ使う」で作る = シートに列を書かない。作成 → `/scan` のチップに現れる → 改名と重複の扱いの変更 → 削除 → `/scan`・`/records`・bottom nav の dropdown から設定へ到達できる)。確認モードの記録は `node scripts/verify-scan-confirm.mjs`(チェックインで1件のQR → pending card の氏名 → 「記録」で即 flush → `/api/scan-check` の状態が `済` → `/records` に履歴。**確認モードは即 flush するので 来場済/来場日時 を設定されたシートに書く** — dev シートに対してだけ実行すること)。照会→結果→「スキャンに戻る」の自動再開は `node scripts/verify-scan-return.mjs`(照会1件 → `/result` → 戻る → 開始ボタンを押さずに「スキャン中」+映像が流れる → 戻った直後に同じQRを2秒映しても `/scan` のまま(窓内の再読は無視)→ 別のQRがそのまま `/result` になる → 「スキャン停止」後に画面を戻ったら停止のまま。**シートへ一切書かない**)。単体は `test/unit/scan.test.ts`、RLS と証跡の統合は `test/supabase/scan-flow.test.ts`(`npm run test:local`)。

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
   - `supabase/migrations/0001_init.sql` → `supabase/migrations/0002_registration_requests.sql` → `supabase/migrations/0003_sync_settings.sql` → `supabase/migrations/0004_sync_row_filter.sql` → `supabase/migrations/0005_sync_prune.sql` → `supabase/migrations/0006_scan_modes.sql` を SQL Editor でこの順に実行(users / items / ドメイン表 / RLS / 関数 + 許可依頼の依頼テーブルと RPC + 同期設定テーブル `sync_settings` とシード行 + 行フィルタ列(filter_column / filter_values)+ prune 列(prune_on_commit)と items 削除ポリシー + スキャンの記録モード `scan_modes`(シード2モード)と証跡 `scan_events`(select/insert のみ)。関数が RLS ポリシーより先に作成される順になっている)
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
     ワークシート・code カラム・取り込みカラム(空 = 全カラム)・除外・行フィルタ(有効レコードを表すカラム名 + 許容値のリスト。リスト空 = そのカラムの値が非空なら有効。カラム名空 = フィルタなし)・rename・対象テーブルを編集し、
     「設定を保存」→「プレビュー」→「取り込みを確定」の順で実行する(確定は `confirm: true` 必須、5000行超は拒否)
     - 行フィルタで除外された行やシートから消えた行は既定では items に残る(upsert のみ)。「確定時に削除も行う」
       (`sync_settings.prune_on_commit`、マイグレーション 0005 の items 削除ポリシーが必要)を有効にすると、
       確定時に「今回のシートで取り込み対象だった code に無い行」を削除する(プレビューに削除予定件数を表示)。
       誤削除防止のガード: ワークシート名が不一致(フォールバック)のときと取り込み 0 行のときは削除しない
   - シート読み取りは Worker 側で行う(googleapis 不使用): サービスアカウント鍵から JWT(RS256)を自前署名し
     oauth2 の jwt-bearer grant で access token を取り、Sheets REST API(v4)を fetch で読む
   - 備考編集は同じ鍵で `values.update` を叩く(`server/utils/googleSheets.ts` の `updateCellValue`。
     jwt-bearer の scope を `spreadsheets`(編集)に切り替えて取得する)。読み取りは `spreadsheets.readonly` のまま。
     サービスアカウントの email を対象スプレッドシートに**編集者以上の権限**で共有していないと書き込みは 403 になる
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
- スキーマは start/reset で `supabase/migrations/*.sql`(0001→0002→0003→0004→0005→0006 の順)が自動適用される。ホスト版には同じファイルをこの順で SQL Editor に貼って実行するか、`supabase db push` を使う。
  hosted への `db push` は `npx supabase db push --remote=<project-ref>` で、**Supabase の access token(scoped: database_write)か DB のパスワード(`--password`)が必要**(service_role key では DB に繋がらない)。まず `--dry-run` で適用されるマイグレーションを確認する。
- 統合テスト: `npm run test:local`(email 事前登録 → 初回ログインの `link_my_user()` 自動紐付け → `is_registered_user()` / items 閲覧 / 未登録拒否 + QR許可フロー: 依頼作成・再生成で旧nonce失効・preview/approve・ドメイン制限・consumed 再利用拒否 + 任意 payload キーの絞り込みの PostgREST 実挙動(`test/supabase/items-key-filter.test.ts`: present/absent の意味、absent の `or=` を複数重ねる AND、contains のリテラル、in の OR、`"` を含むキーは supabase-js で検索不可=0件/parse エラーになることを固定) + スキャンの記録(`test/supabase/scan-flow.test.ts`: 既定2モードの閲覧、モードの増減、未登録の拒否、`scan_events` の insert/select と seq 降順のカーソル分页、証跡の不変性(authenticated に update/delete ポリシーなし → 試行は0件で空振りし値が変わらない),モード削除の `on delete restrict`))。
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
  `/items` のスクロール追記・インクリメンタル検索・行の code リンク・nav との重なり、絞り込み欄の折りたたみ(年・組・備考・項目のトグル3個が1行に並び、閉じた時の条件領域の縦が増えない)、chip の OR/AND、マトリクスのペア(1年3組+2年1組 の件数と交差0件)、備考の有無(あり+なしの和=全件、開いた行の備考の値が実際に空/非空)、備考の部分一致検索、任意キーの絞り込み(ボランティアの有無の和=全件、filters 参数付き照会、値 chip の件数一致、キーあり+組3の AND、部分一致、閉じても選択状態がラベルに出る)、表示のみのキー選択(`.item-extras` にキーの値が出る+総件数不変、リセット後も残る)、行を開いて一覧に戻った時の絞り込み状態の保持(chip 選択・総件数・スクロール位置・再fetch なし、「一覧に戻る」とブラウザの戻るの両方)は `node scripts/verify-items-page.mjs` をヘッドレス Chrome で確認する(dev サーバ + ローカル Supabase の items が必要)。
  スキャンの記録(連続モードで3件のQRを順に流すと氏名が待機列に並び、同じQRの窓内再読は積み上がらない)は `node scripts/verify-scan-record.mjs` で確認する(dev サーバ + ローカル Supabase + `sync_settings` のシート設定 + シートの鍵が必要。`GOOGLE_SERVICE_ACCOUNT_JSON` を env に渡して dev サーバを起動する。既定はシートへ書かない。`VERIFY_SCAN_FLUSH=1` で「書き込みを確定」→ `/records` の履歴まで確認するが、設定されたシートに `配布済` / `配布日時` を書くので dev シートに対してだけ実行すること)。
  dev フォームと `/api/auth/dev-login` は本番ビルドでは無効(NODE_ENV=production で 404、UI 非表示)。hosted Supabase を指す dev(`npm run dev:tunnel`)でも無効になる(dev ユーザはローカルにしか存在しないため)。
- メール確認リンクの確認は Mailpit (http://127.0.0.1:54324)。

## スマホ(Android / iOS)

- カメラは HTTPS 必須。本番は HTTPS で配信するか、開発中は ngrok/Cloudflare tunnel 等経由。
  (localhost はブラウザが安全とみなすため PC ではカメラ可、スマホからは HTTPS が必要)
- `/scan` のカメラは「スキャン開始」ボタンを押して起動する(`getUserMedia` はユーザー操作が必要。画面に着いたときは自動で開始しようとする)。照会結果(`/result`)から「スキャンに戻る」で戻ったら再マウントして自動再開する(「スキャン停止」で止めた場合は再開しない)。ヘッドレス Chrome(fake device)での起動検証は `node scripts/verify-camera.mjs`、戻り後の自動再開は `node scripts/verify-scan-return.mjs`。
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
- 一覧の表示列を増やしたい場合: 画面の「行に表示する項目」で選ぶだけで済む(コード変更不要。`app/components/ItemRow.vue` が `extraKeys` のキーの値を `.item-extras` に出す)。常に固定で列として出したいなら `app/components/ItemRow.vue` に `payloadValue(payload, key)` を追加する(`server/api/items-list.get.ts` は payload をそのまま返すので API は変更不要)。
- users の登録をスプレッドシートから行いたい場合: users 用の同期処理を追加(email 事前登録方式と相性好)。
