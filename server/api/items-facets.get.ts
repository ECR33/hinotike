import {
  ITEM_FACET_SCAN_LIMIT,
  ITEM_GROUP_KEY,
  ITEM_YEAR_KEY,
  facetCounts,
  facetPairCounts,
  missingPairCount,
  payloadTextColumn,
  payloadValue,
  type FacetOption,
} from '#shared/utils/items'

/**
 * 年・組の絞り込み**選択肢(facets)**。一覧のフィルタとは独立に、items 全体の値と件数を返す。
 *
 * 前提: Google 認証済み + users テーブルへの紐付け(items-list と同じ requireRegisteredUser)。
 *
 * payload の年・組キーだけスキャンする(行全体は運ばない)。スキャン上限
 * (ITEM_FACET_SCAN_LIMIT)に到達した場合は truncated = true を返す(選択肢は一部欠けうる。
 * UI はその旨を静かに出す。このアプリの items は上限内の規模であることを前提にする)。
 * 値の欠落(null・空)は選択肢から除く(年や組が空のレコードは絞り込みで選べない)。
 * 年×組のマトリクス用に `pairs`(セルの件数)と、選べない行の件数 `missingPairs` も返す。
 */
export default defineEventHandler(async (event) => {
  const { supabase } = await requireRegisteredUser(event)

  const { data, error } = await supabase
    .from('items')
    .select(`${payloadTextColumn(ITEM_YEAR_KEY)},${payloadTextColumn(ITEM_GROUP_KEY)}`)
    .limit(ITEM_FACET_SCAN_LIMIT)

  if (error) {
    console.error('[items-facets] items:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'items facets failed' })
  }

  const scanned = (data ?? []) as Record<string, unknown>[]
  const rows = scanned.map((row) => ({
    year: payloadValue(row, ITEM_YEAR_KEY),
    group: payloadValue(row, ITEM_GROUP_KEY),
  }))
  const years: FacetOption[] = facetCounts(rows.map((row) => row.year))
  const groups: FacetOption[] = facetCounts(rows.map((row) => row.group))

  return {
    years,
    groups,
    // 年×組マトリクスのセル(件数付き)。どちらかが欠ける行はセルを持たない。
    pairs: facetPairCounts(rows),
    // マトリクスで選べない行(年 or 組が空)の件数。UI は注記だけ出す(黙って減らさない)。
    missingPairs: missingPairCount(rows),
    scanned: scanned.length,
    truncated: scanned.length >= ITEM_FACET_SCAN_LIMIT,
  }
})
