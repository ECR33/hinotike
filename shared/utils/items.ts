/**
 * code + payload の1行(シート由来)の一覧表示・検索の共通ロジック。
 *
 * payload のキー名は**取り込み定義**(public.sync_sources の include_columns / rename。
 * 既定のシードは shared/utils/sync.ts の DEFAULT_SOURCE と migrations/0007 の行)と一致させること。
 * キー名を変えたい場合はこの定数だけ直せば一覧行・検索が追随し、取り込み側は
 * /sync のデータセット設定で同じキーに合わせる。
 * 商品(個数系キー)の表示順は productOrderKeys で、データセットの includeColumns の並びが正
 * (/sync の「取り込みカラム」の行順をアプリから調整できる)。
 * 行の正は Google スプレッドシート(Supabase の items テーブルは使わない)。照合は
 * server(/api/items-* = シート読み取り)と画面(shared/utils/offline.ts = 端末ミラー)で同じ実装を使う。
 * Nuxt 依存の import は置かない(server / shared どちらでも読めるように)。
 */

/** 一覧の1行(API が items 行そのままを渡す最小形状)。行部品は payload をそのまま受け取る。 */
export interface ItemRowData {
  code: string
  payload: Record<string, unknown>
}

/** 一覧行に表示する payload キー(年 / 組 / 氏名)。 */
export const ITEM_YEAR_KEY = '学年'
export const ITEM_GROUP_KEY = 'クラス'
export const ITEM_NAME_KEY = '氏名'

/** 備考の payload キー(照会結果画面で編集可能。シート側のカラム名は rename の逆引きで決まる)。 */
export const ITEM_REMARK_KEY = '備考'

/** 備考の入力上限(文字数)。画面側と API 側で同じ値を使う。 */
export const REMARK_MAX_LENGTH = 2000

/**
 * 一覧の「備考の有無」絞り込みの状態。
 *  - any     = 条件なし(既定。有無で絞らない)
 *  - present = 備考が入っている行だけ
 *  - absent  = 備考が空(キー無し・null・空文字)の行だけ
 */
export type RemarkState = 'any' | 'present' | 'absent'

/**
 * クエリパラメータの備考の有無を正規化する。認識しない値・非文字列は any(条件なし)。
 * URL は `?remarkState=present` / `?remarkState=absent`(大文字・空白は吸収する)。
 */
export function normalizeRemarkState(raw: unknown): RemarkState {
  if (typeof raw !== 'string') return 'any'
  const value = raw.trim().toLowerCase()
  if (value === 'present') return 'present'
  if (value === 'absent') return 'absent'
  return 'any'
}

/**
 * 「任意の payload キーがなし」の意味(ローカル・サーバーどちらの照合もこの規則で読む)。
 * キーが無い行(null・undefined)と空文字の行の両方を「なし」に含める。
 * 空白のみの値は trim できないため「あり」側に残る(取り込みは空値を載せず、備考の保存は trim するので通常起きない)。
 */
export function keyAbsent(payloadText: string): boolean {
  return payloadText === ''
}

/** 備考の「なし」判定(keyAbsent の備考キー既定版)。 */
export function remarkAbsent(payloadText: string, _key = ITEM_REMARK_KEY): boolean {
  return keyAbsent(payloadText)
}

/**
 * 汎用の項目(payload キー)絞り込み。
 *
 * 備考と同じ照合(`payload[key]` の文字列値)を任意キーに流用する:
 *  - present = 値が入っている行(空でない)
 *  - absent  = 欠落・null・空文字の行
 *  - contains = そのキーの部分一致(大文字小文字無視)
 *  - in       = 値の複数選択(同一キー内 OR)
 * キー同士・備考・code・氏名・年・組との指定はすべて AND。
 * 照合の実装は `shared/utils/offline.ts` の `offlineItemsQuery`(server のシート由来行にも端末ミラーにも同じ関数)。
 * キー名は取り込み定義(includeColumns + rename)やシートヘッダー由来の任意文字列なので、
 * 静的定数ではなく API/画面が実際に発見したキーから選ぶ。
 */
export type KeyFilterMode = 'present' | 'absent' | 'contains' | 'in'

/** 汎用キー絞り込みの1条件。contains は value、in は values を使う(present/absent ではどちらも未使用)。 */
export interface KeyFilter {
  key: string
  mode: KeyFilterMode
  value: string
  values: string[]
}

/** キー絞り込み条件数の上限(論理木の膨張による高コスト照合を防ぐ。facet/pair の上限と同じ発想)。 */
export const KEY_FILTER_MAX = 8

/** 絞り込みキー名の長さ上限(長すぎるキーは条件にしない。シートヘッダー名は現実にはこの範囲内)。 */
export const KEY_NAME_MAX_LENGTH = 40

/**
 * payload キー名が絞り込み条件に使えるか。
 * キー名に `"` が混ざると PostgREST/supabase-js の絞り込みが安全に組めない(統合テストで実挙動を固定:
 * `.or()` は論理木パースエラー、パス照会は暗黙に 0 件になる)。シートヘッダー由来の任意キー名で
 * `"` を含むキーは**表示のみ**に制限する(GET /api/items-keys はそのまま返すので表示側は使える)。
 * 長さ上限(KEY_NAME_MAX_LENGTH)を超えるキーも条件にしない(parseKeyFilter と同じ規則)。
 */
export function isFilterableKey(key: string): boolean {
  return !!key && !key.includes('"') && key.length <= KEY_NAME_MAX_LENGTH
}

/**
 * 絞り込み spec 文字列 `キー|モード|値` を KeyFilter にパースする。
 * キー・モードは trim(モードは大文字吸収)。値部分は残りの `|` を再結合して読むため
 * contains 値に `|` が混ざってもそのまま一致対象になる。
 * present/absent は値不要。contains の空値・in の値なしは「条件なし」扱いで null。
 * 認識できないモード・空キー・非文字列も null(条件にしない)。
 * 絞り込みできないキー(isFilterableKey=false、`"` 含む等)も null。
 */
export function parseKeyFilter(raw: unknown): KeyFilter | null {
  if (typeof raw !== 'string') return null
  const [keyPart = '', modePart = '', ...restParts] = raw.split('|')
  if (!raw.includes('|')) return null // 区切りが無い spec は条件にしない
  const key = keyPart.trim()
  // 長さ超過のキーは切り捨てずに条件にしない(切り捨てると別の実キーのprefixに化けて別物を絞る)
  if (!key || !isFilterableKey(key)) return null
  const mode = modePart.trim().toLowerCase()
  const rest = restParts.join('|')
  if (mode === 'present' || mode === 'absent') return { key, mode, value: '', values: [] }
  if (mode === 'contains') {
    const value = normalizeFilter(rest)
    if (!value) return null
    return { key, mode, value, values: [] }
  }
  if (mode === 'in') {
    const values = normalizeSelection(rest.split('|'))
    if (!values.length) return null
    return { key, mode, value: '', values }
  }
  return null
}

/**
 * クエリパラメータのキー絞り込みを正規化する。配列は各要素を spec としてそのまま受け取り、
 * 文字列はカンマ区切りで spec を分割する(URL の単一参数形式では contains/in 値に `,` を載せられない。
 * 画面は配列で送るため値に `,` が混ざっても壊れない)。
 * 同一キー同一モードの重複は最初のみ(同一キーの present+absent など異モードは AND のまま許す。0件になる)。
 * 上限は KEY_FILTER_MAX。
 */
export function normalizeKeyFilters(raw: unknown): KeyFilter[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const seen = new Set<string>()
  const out: KeyFilter[] = []
  for (const item of items) {
    const filter = parseKeyFilter(item)
    if (!filter) continue
    const dedupe = `${filter.key}|${filter.mode}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    out.push(filter)
    if (out.length >= KEY_FILTER_MAX) break
  }
  return out
}

/** KeyFilter を spec 文字列(`キー|モード|値`)に戻す(URL 参数・条件比較用)。 */
export function serializeKeyFilters(filters: KeyFilter[]): string[] {
  return filters.map((filter) => {
    if (filter.mode === 'contains') return `${filter.key}|contains|${filter.value}`
    if (filter.mode === 'in') return `${filter.key}|in|${filter.values.join('|')}`
    return `${filter.key}|${filter.mode}`
  })
}

/** 条件比較用のキー絞り込み一致判定(順序は無視して集合として同じか。AND の条件順は結果に影響しない)。 */
export function sameKeyFilters(a: KeyFilter[], b: KeyFilter[]): boolean {
  const sa = serializeKeyFilters(a).sort()
  const sb = serializeKeyFilters(b).sort()
  if (sa.length !== sb.length) return false
  return sa.every((spec, i) => spec === sb[i])
}

/**
 * GET /api/items-keys の1項目ぶん(key 発見 + 有無の件数 + 値の選択肢)。
 * absentCount = スキャン行数 - presentCount(欠落・null・空文字を「なし」とする)。
 * fromConfig = 同期設定(includeColumns/rename)由来の候補、seenInData = スキャンした行に実際に出現。
 * 設定由来でまだ出現していないキー(同期待ち)は presentCount=0 / seenInData=false で出る。
 */
export interface ItemKeyEntry {
  key: string
  presentCount: number
  absentCount: number
  options: FacetOption[]
  fromConfig: boolean
  seenInData: boolean
}

/** GET /api/items-keys の応答。scanned / truncated は payload のスキャン範囲(items-facets と同じ上限)。 */
export interface ItemsKeysResponse {
  keys: ItemKeyEntry[]
  scanned: number
  truncated: boolean
}

/**
 * 個数系(payload の商品)キーの suffix。シート側のカラム名(「ひのドッグ(個数)」など)。
 * 全角括弧も扱う(シート表記の揺れ対策)。
 */
export const QUANTITY_SUFFIXES = ['(個数)', '（個数）']

/** 個数系キーかどうか(末尾が suffix のどれか)。 */
export function isQuantityKey(key: string): boolean {
  return QUANTITY_SUFFIXES.some((suffix) => key.endsWith(suffix))
}

/** キー名から商品名を取り出す(「ひのドッグ(個数)」→「ひのドッグ」。括弧が無ければキー名そのまま)。 */
export function quantityName(key: string): string {
  for (const suffix of QUANTITY_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length) || key
  }
  return key
}

/**
 * 商品欄の表示順(payload キー)。同期設定の includeColumns の並びを rename 適用後のキーに
 * 写して個数系だけ残す(重複は最初のみ)。空 = 順が未指定(呼ぶ側はフォールバックの並びを使う)。
 * /sync の「取り込みカラム」の行順がそのまま商品表示順になる。
 */
export function productOrderKeys(includeColumns: string[], rename: Record<string, string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const col of includeColumns) {
    const key = rename[col] ?? col
    if (!isQuantityKey(key) || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * jsonb の文字列値をカラムとして参照する PostgREST のパス表記(payload ->> key)。
 * キーに空白や非ASCIIが混ざっても通るように引用符で囲む。
 * キー名自体の `"` は SQL の引用規則通り2個重ねて守る(汎用キー絞り込みでは任意文字列のキー名を
 * シートヘッダー由来で受け取るため、`"` を含むキーでパスが壊れないようにする)。
 */
export function payloadTextColumn(key: string): string {
  return `payload->>"${escapePayloadKey(key)}"`
}

/** payload キー名の引用内エスケープ(`"` → `""`)。payloadTextColumn のパス組み立てで使う。 */
export function escapePayloadKey(key: string): string {
  return key.replace(/"/g, '""')
}

/** payload のキーから表示用の文字列値を取り出す(欠落・null は空文字)。 */
export function payloadValue(payload: Record<string, unknown> | null | undefined, key: string): string {
  const v = payload?.[key]
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : String(v)
}

/**
 * 検索入力の正規化。非文字列・空(空白のみ)は null = 「条件なし」。
 * 長打ちによる高コストな照合を防ぐため上限で切る(前方一致/部分一致検索では末尾の欠落は許容)。
 */
export const SEARCH_FILTER_MAX_LENGTH = 60

export function normalizeFilter(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed.slice(0, SEARCH_FILTER_MAX_LENGTH)
}

/**
 * PostgREST の ilike/like はパターン側で `%` `_`(とエスケープの `\`)が特殊文字になる。
 * 入力に含まれる これらをリテラルとして扱うため `\` で守る(氏名/コードに `%` が混ざっても
 * 「任意文字」扱いにならない)。
 */
export function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** 部分一致(包含)パターン。空入力は null を返す(条件を追加しない)。 */
export function containsPattern(raw: unknown): string | null {
  const value = normalizeFilter(raw)
  if (!value) return null
  return `%${escapeIlikePattern(value)}%`
}

/** 一覧のページサイズ(スクロール追記の1バッチ)。API はこれを上限内で補正する。 */
export const ITEM_PAGE_SIZE = 25
export const ITEM_PAGE_SIZE_MAX = 100

/** クエリパラメータの limit を安全な範囲に補正(不正値は既定値)。 */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isInteger(n)) return ITEM_PAGE_SIZE
  return Math.min(ITEM_PAGE_SIZE_MAX, Math.max(1, n))
}

/**
 * 次のページカーソル。code は PK なので code 昇順キーセット(page の末尾 code より大きい分を次取得)で
 * 安定して paginate できる。offset と違い検索条件の変更でズレ・重複しない。
 * 末尾が limit に満たない = 最終ページ(null)。
 */
export function nextCursor(rows: ItemRowData[], limit: number): string | null {
  if (rows.length < limit) return null
  return rows[rows.length - 1]?.code ?? null
}

/**
 * 年・組の絞り込み。
 *
 * 値は payload のキー(ITEM_YEAR_KEY / ITEM_GROUP_KEY)の文字列そのものを使う。
 * 同一 facet 内の複数選択は OR(`in.(...)`)、facet 同士(年×組)は AND にする。
 * 「1年3組 と 2年1組」のような年と組の**対応**は chip では表現できないため、
 * ペア指定(FacetPair / pairConditions → or(and(...),and(...)))を別に用意する。
 */
export interface FacetOption {
  value: string
  count: number
}

/** facet 選択の上限(大量の in.() 値による高コスト照合を防ぐ)。選択肢側もこの上限内に収める。 */
export const FACET_MAX_VALUES = 12
export const FACET_VALUE_MAX_LENGTH = 24

/** facet(選択肢)生成のため payload の年・組だけスキャンする上限。超過は truncated を返す。 */
export const ITEM_FACET_SCAN_LIMIT = 2000

/**
 * クエリパラメータの選択値(単数 or 複数)を正規化して重複を除く。
 * 文字列はカンマ区切り、配列はそのまま受け取る。空要素・空文字は捨て、上限で切る。
 */
export function normalizeSelection(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    seen.add(trimmed.slice(0, FACET_VALUE_MAX_LENGTH))
    if (seen.size >= FACET_MAX_VALUES) break
  }
  return [...seen]
}

/**
 * PostgREST の `in.()` はカンマ区切りで、値に `,` `"` `(` などの特殊文字が混ざると引用が必要。
 * 値を SQL 風のダブルクォートで守る(`"` は `""` に重ねる)。supabase-js はこの文字列をそのまま組み立てる。
 */
export function quoteInValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** facet 値の順序: 数字だけ数字順(1,2,10)、それ以外は比較順。欠落(null)は呼ばない側で除く。 */
export function compareFacetValues(a: string, b: string): number {
  const numeric = /^\d+$/.test(a) && /^\d+$/.test(b)
  if (numeric) return Number(a) - Number(b)
  return a.localeCompare(b, 'ja')
}

/** payload から拾った値(欠落・空文字を除く)を件数付きの選択肢にまとめて昇順にする。 */
export function facetCounts(values: (string | null | undefined)[]): FacetOption[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (!trimmed) continue
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => compareFacetValues(a.value, b.value))
}

/**
 * 年と組の**対応**(1年3組 + 2年1組)を指定するペア。
 * 選択は `年:組` の文字列で受け取る(URL は `?pairs=1:3,2:1`)。
 */
export interface FacetPair {
  year: string
  group: string
}

export interface FacetPairCount extends FacetPair {
  count: number
}

/** ペア選択の上限(マトリクスは年×組なので現実には小さいが、高コストな論理木の膨張を防ぐ)。 */
export const ITEM_PAIR_MAX = 60

/** `年:組` 形式をペアに正規化。区切りが無い・いずれかが空・長さ上限超過は null(選択対象にしない)。 */
export function parsePair(raw: string): FacetPair | null {
  const at = raw.indexOf(':')
  if (at < 0) return null
  const year = raw.slice(0, at).trim()
  const group = raw.slice(at + 1).trim()
  if (!year || !group) return null
  if (year.length > FACET_VALUE_MAX_LENGTH || group.length > FACET_VALUE_MAX_LENGTH) return null
  return { year, group }
}

/** ペアの識別子(選択状態の集合・マトリクスのセル key に使う)。 */
export function pairKey(pair: FacetPair): string {
  return `${pair.year}:${pair.group}`
}

/** クエリパラメータのペア選択を正規化して重複を除く(`年:組` をカンマ区切り or 配列で受け取る)。 */
export function normalizePairs(raw: unknown): FacetPair[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const seen = new Set<string>()
  const pairs: FacetPair[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const pair = parsePair(item)
    if (!pair) continue
    const key = pairKey(pair)
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push(pair)
    if (pairs.length >= ITEM_PAIR_MAX) break
  }
  return pairs
}

/**
 * ペア選択を PostgREST の論理木にする。supabase-js の `.or()` は `or=(...)` で包むので、
 * ここでは `and(...),and(...)` の並列だけ返す(空選択は ''。呼ばない側でフィルタを適用しない)。
 * nested は `and=(...)` ではなく `and(...)` の形が必要。パス・値は引用して特殊文字を防ぐ。
 */
export function pairConditions(
  pairs: FacetPair[],
  yearKey = ITEM_YEAR_KEY,
  groupKey = ITEM_GROUP_KEY,
): string {
  return pairs
    .map(
      (pair) =>
        `and(${payloadTextColumn(yearKey)}.eq.${quoteInValue(pair.year)},${payloadTextColumn(groupKey)}.eq.${quoteInValue(pair.group)})`,
    )
    .join(',')
}

/** ペア(年・組の両方を持つ行)の件数。どちらかが欠ける行は数えない(マトリクスで選べない)。年→組の昇順。 */
export function facetPairCounts(rows: { year: string | null; group: string | null }[]): FacetPairCount[] {
  const counts = new Map<string, FacetPairCount>()
  for (const row of rows) {
    const year = typeof row.year === 'string' ? row.year.trim() : ''
    const group = typeof row.group === 'string' ? row.group.trim() : ''
    if (!year || !group) continue
    const key = pairKey({ year, group })
    const found = counts.get(key)
    if (found) found.count += 1
    else counts.set(key, { year, group, count: 1 })
  }
  return [...counts.values()].sort(
    (a, b) => compareFacetValues(a.year, b.year) || compareFacetValues(a.group, b.group),
  )
}

/** 年・組のどちらかが欠けている行の件数(マトリクスで選べない行の注記用)。 */
export function missingPairCount(rows: { year: string | null; group: string | null }[]): number {
  return rows.filter((row) => !row.year || !row.group).length
}
