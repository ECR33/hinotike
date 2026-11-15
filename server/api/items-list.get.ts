import {
  clampLimit,
  containsPattern,
  ITEM_GROUP_KEY,
  ITEM_NAME_KEY,
  ITEM_REMARK_KEY,
  ITEM_YEAR_KEY,
  keyAbsentConditions,
  nextCursor,
  normalizeKeyFilters,
  normalizePairs,
  normalizeRemarkState,
  normalizeSelection,
  pairConditions,
  payloadTextColumn,
  quoteInValue,
  type ItemRowData,
} from '#shared/utils/items'

/**
 * items テーブルの**ページ付き一覧**。code・氏名・年・組・備考・任意の payload キーで絞り込める。
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
 * **任意項目の絞り込み** `filters=key|mode|値...`(配列 or カンマ区切り spec、normalizeKeyFilters):
 * シートヘッダー→同期設定→payload に載る任意キー(ボランティア欄など)を備考と同じ jsonb パスで絞る。
 * mode は present/absent(有無。absent はキー単位の別の `or=` で、他の absent や pairs と AND で交わる)、
 * contains(部分一致)、in(値の複数選択・同一キー内 OR)。キー同士・備考・code・氏名・年・組はすべて AND。
 * 上限は KEY_FILTER_MAX。キー名に `"` が混ざっても payloadTextColumn の引用で守る。
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
  const keyFilters = normalizeKeyFilters(query.filters)
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
  else if (remarkState === 'absent') builder = builder.or(keyAbsentConditions(ITEM_REMARK_KEY))
  // 選択値は in.() の特殊文字を引用して守る(値にカンマ・引用符が混ざっても崩れない)
  if (years.length) builder = builder.in(payloadTextColumn(ITEM_YEAR_KEY), years.map(quoteInValue))
  if (groups.length) builder = builder.in(payloadTextColumn(ITEM_GROUP_KEY), groups.map(quoteInValue))
  // ペア指定(年と組の対応): each ペアは年AND組、ペア同士は OR
  if (pairs.length) builder = builder.or(pairConditions(pairs))
  // 任意項目の絞り込み(備考と同じ照会をキー単位に流用。異モードの同時指定は AND)
  for (const filter of keyFilters) {
    const column = payloadTextColumn(filter.key)
    if (filter.mode === 'present') builder = builder.not(column, 'is.null', null).neq(column, '')
    else if (filter.mode === 'absent') builder = builder.or(keyAbsentConditions(filter.key))
    else if (filter.mode === 'contains') builder = builder.ilike(column, containsPattern(filter.value)!)
    else builder = builder.in(column, filter.values.map(quoteInValue))
  }
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
