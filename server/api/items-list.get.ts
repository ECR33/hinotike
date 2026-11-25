import { clampLimit, type ItemRowData } from '#shared/utils/items'
import { offlineItemsQuery, type OfflineItemsPage } from '#shared/utils/offline'
import { datasetFromSource, resolveSource } from '../utils/dataset'

/**
 * データセットの**ページ付き一覧**(シート由来)。code・氏名・年・組・備考・任意の payload キーで絞り込める。
 *
 * 前提: Google 認証済み + users テーブルへの紐付け(lookup と同じ requireRegisteredUser)。
 * 対象シートは `?sourceId=`(未指定は有効な最初のデータセット)。
 *
 * 照合は **shared/utils/offline.ts の offlineItemsQuery**(端末ミラーの絞り込みと同じ実装)を
 * シート由来の行に適用する。PostgREST の jsonb パス照会は撤去した(items テーブルを使わない)。
 * 意味は旧 items-list と同じ:
 *  - code・氏名・備考・filters の contains = 部分一致・大文字小文字無視(NULL は一致しない)
 *  - 年・組 = 完全一致の複数選択(同一 facet 内 OR、年と組の間 AND)、pairs = 年と組の対応(ペア同士 OR)
 *  - remarkState / filters の present・absent = 欠落・null・空文字を「なし」
 *  - filters の in = 値の複数選択(同一キー内 OR)。キー同士・他の条件はすべて AND
 * 分页は code 昇順(数値比較)のキーセットカーソル `code > cursor`。total は一致する総件数(exact)。
 * シートが MAX_IMPORT_ROWS 超のときは truncated=true(打ち切り後の行で絞る)。
 */
export default defineEventHandler(async (event): Promise<OfflineItemsPage & { sourceId: number; sheetTitle: string; truncated: boolean; skipped: number; filtered: number }> => {
  await requireRegisteredUser(event)

  const query = getQuery(event)
  const source = await resolveSource(event, query.sourceId)
  const dataset = await datasetFromSource(event, source)
  const limit = clampLimit(query.limit)

  const page = offlineItemsQuery(
    dataset.rows as ItemRowData[],
    {
      code: query.code,
      name: query.name,
      remark: query.remark,
      remarkState: query.remarkState,
      years: query.years,
      groups: query.groups,
      pairs: query.pairs,
      filters: query.filters,
      cursor: query.cursor,
      limit,
    },
    limit,
  )

  return {
    ...page,
    sourceId: source.id ?? 0,
    sheetTitle: dataset.sheetTitle,
    truncated: dataset.truncated,
    skipped: dataset.skipped,
    filtered: dataset.filtered,
  }
})

