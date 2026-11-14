import {
  clampLimit,
  containsPattern,
  ITEM_GROUP_KEY,
  ITEM_NAME_KEY,
  ITEM_REMARK_KEY,
  ITEM_YEAR_KEY,
  nextCursor,
  normalizePairs,
  normalizeRemarkState,
  normalizeSelection,
  pairConditions,
  payloadTextColumn,
  quoteInValue,
  remarkAbsentConditions,
  type ItemRowData,
} from '#shared/utils/items'

/**
 * items テーブルの**ページ付き一覧**。code・氏名・年・組・備考で絞り込める。
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
 * 備考は `remark=文字列`(payload の ITEM_REMARK_KEY を部分一致)と
 * `remarkState=present|absent`(有無)で絞る。有無は備考キーの欠落/null/空文字を「なし」とする
 * (空白のみの備考は照合側で trim できないため「あり」になる。備考の保存は trim するので通常起きない)。
 * 備考の有無と備考の文字検索は他の条件との AND。`absent` は pairs の OR と同じ列に論理木を
 * 作らないよう別の `or=` として重ねる(PostgREST は複数の `or=` を AND で結合する)。
 * total は exact count(一致する総件数。limit に影響されない)で、UI の「N件中…」表示に使う。
 */
export default defineEventHandler(async (event) => {
  const { supabase } = await requireRegisteredUser(event)

  const query = getQuery(event)
  const codePattern = containsPattern(query.code)
  const namePattern = containsPattern(query.name)
  const remarkPattern = containsPattern(query.remark)
  const remarkState = normalizeRemarkState(query.remarkState)
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
  const remarkColumn = payloadTextColumn(ITEM_REMARK_KEY)
  // 備考の文字検索(部分一致)。有無のフィルタと同時に送れば AND(「なし + 検索」は 0 件になる)
  if (remarkPattern) builder = builder.ilike(remarkColumn, remarkPattern)
  // 備考の有無: あり = 値が有って空文字でない、なし = 備考キーの欠落・null・空文字
  if (remarkState === 'present') builder = builder.not(remarkColumn, 'is.null', null).neq(remarkColumn, '')
  else if (remarkState === 'absent') builder = builder.or(remarkAbsentConditions())
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
