import {
  clampLimit,
  containsPattern,
  ITEM_GROUP_KEY,
  ITEM_NAME_KEY,
  ITEM_YEAR_KEY,
  nextCursor,
  normalizePairs,
  normalizeSelection,
  pairConditions,
  payloadTextColumn,
  quoteInValue,
  type ItemRowData,
} from '#shared/utils/items'

/**
 * items テーブルの**ページ付き一覧**。code・氏名・年・組で絞り込める。
 *
 * 前提: Google 認証済み + users テーブルへの紐付け(lookup と同じ requireRegisteredUser。
 * RLS の items_select_registered_users と同じ根で判定する)。
 *
 * 分页は code(PK)昇順のキーセットカーソル: `code > cursor` を次ページとして読む。
 * offset と違い、検索条件を変えても既存ページの先頭がずれない(スクロール追記で
 * 重複・取りこぼししない)。1バッチは limit 件、末尾が limit 未満なら nextCursor は null。
 *
 * 検索は部分一致(ilike)。code は `code` カラム、氏名は payload のキー(ITEM_NAME_KEY)を
 * jsonb パスで照会する。入力の `%` `_` はリテラルに扱う(containsPattern)。
 * 年・組は payload のキーの完全一致で、複数選択は同一 facet 内で OR(`in.()`)・
 * 年と組の間は AND(`in.()` を2つ重ねる)になる。
 * 年と組の**対応**(1年3組 + 2年1組)は `pairs=年:組,...` で指定する(各ペアは AND、
 * ペア同士は OR → `or=(and(...),and(...))`)。pairs と年・組の選択を同時に送ると AND になる
 * (UI はどちらか一方だけ送る)。
 * total は exact count(一致する総件数。limit に影響されない)で、UI の「N件中…」表示に使う。
 */
export default defineEventHandler(async (event) => {
  const { supabase } = await requireRegisteredUser(event)

  const query = getQuery(event)
  const codePattern = containsPattern(query.code)
  const namePattern = containsPattern(query.name)
  const years = normalizeSelection(query.years)
  const groups = normalizeSelection(query.groups)
  const pairs = normalizePairs(query.pairs)
  const cursor = typeof query.cursor === 'string' ? query.cursor.trim() : ''
  const limit = clampLimit(query.limit)

  let builder = supabase
    .from('items')
    .select('*', { count: 'exact' })
    .order('code', { ascending: true })
    .limit(limit)

  if (codePattern) builder = builder.ilike('code', codePattern)
  if (namePattern) builder = builder.ilike(payloadTextColumn(ITEM_NAME_KEY), namePattern)
  // 選択値は in.() の特殊文字を引用して守る(値にカンマ・引用符が混ざっても崩れない)
  if (years.length) builder = builder.in(payloadTextColumn(ITEM_YEAR_KEY), years.map(quoteInValue))
  if (groups.length) builder = builder.in(payloadTextColumn(ITEM_GROUP_KEY), groups.map(quoteInValue))
  // ペア指定(年と組の対応): each ペアは年AND組、ペア同士は OR
  if (pairs.length) builder = builder.or(pairConditions(pairs))
  if (cursor) builder = builder.gt('code', cursor)

  const { data, count, error } = await builder

  if (error) {
    console.error('[items-list] items:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'items list failed' })
  }

  const rows = (data ?? []) as ItemRowData[]
  return {
    rows,
    nextCursor: nextCursor(rows, limit),
    total: count ?? rows.length,
  }
})
