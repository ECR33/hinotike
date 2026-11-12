/**
 * items テーブル(code + payload jsonb)の一覧表示・検索の共通ロジック。
 *
 * payload のキー名は同期側の設定(public.sync_settings の include_columns / rename。
 * 初期シードは shared/utils/sync.ts の DEFAULT_SYNC_SETTINGS)と一致させること。
 * キー名を変えたい場合はこの定数だけ直せば一覧行・検索が追随し、取り込み側は
 * /sync の設定画面(sync_settings の行)で同じキーに合わせる。
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
 * jsonb の文字列値をカラムとして参照する PostgREST のパス表記(payload ->> key)。
 * キーに空白や非ASCIIが混ざっても通るように引用符で囲む。
 */
export function payloadTextColumn(key: string): string {
  return `payload->>"${key}"`
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
