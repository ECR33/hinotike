import { offlineFacets, type OfflineFacets } from '#shared/utils/offline'
import { datasetFromSource, resolveSource } from '../utils/dataset'

/**
 * 年・組の絞り込み**選択肢(facets)**。一覧のフィルタとは独立に、データセット全体の値と件数を返す。
 *
 * 前提: Google 認証済み + users テーブルへの紐付け(items-list と同じ requireRegisteredUser)。
 * 対象シートは ?sourceId=(未指定は有効な最初のデータセット)。
 * 導出は **shared の offlineFacets**(端末ミラーの facets と同じ実装)をシート由来の行に適用する。
 * 旧 items-facets の ITEM_FACET_SCAN_LIMIT 上限はシート由来では使わない(全行をスキャンするので truncated=false)。
 * 値の欠落(null・空)は選択肢から除く。年×組のマトリクス用に pairs と missingPairs も返す。
 */
export default defineEventHandler(async (event): Promise<OfflineFacets & { sourceId: number; sheetTitle: string }> => {
  await requireRegisteredUser(event)

  const source = await resolveSource(event, getQuery(event).sourceId)
  const dataset = await datasetFromSource(event, source)

  return {
    ...offlineFacets(dataset.rows),
    truncated: dataset.truncated,
    sourceId: source.id ?? 0,
    sheetTitle: dataset.sheetTitle,
  }
})
