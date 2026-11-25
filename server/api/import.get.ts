import { clampImportLimit, importNextCursor, type ImportPageResponse } from '#shared/utils/sync'
import { datasetFromSource, requireSource } from '../utils/dataset'

/**
 * 1データセットの**取り込み**(シートを読み、選別した行をページで返す)。登録済みユーザのみ。
 *
 * データは Supabase に置かない。画面(/scan の「データの取り込み」)がこの応答を繰り返して
 * IndexedDB のミラーに保存し、以後の照会・一覧・記録は端末内のデータに対して走る。
 *
 * 分页は**取り込み対象行の offset**(カーソルは文字列)。code カーソルと違いシート側の並びを
 * そのまま保つ(取り込みは全行を順に保存するだけなので、並びの安定性は必要ない)。
 * シート索引は loadSheetIndex の TTL キャッシュ(60秒)を通るので、1取り込みの複数ページは
 * 同じシート読みを打ち直さない(importedAt はその読み取りの基準日時)。
 */
export default defineEventHandler(async (event): Promise<ImportPageResponse> => {
  await requireRegisteredUser(event)

  const query = getQuery(event)
  const source = await requireSource(event, query.sourceId)
  const dataset = await datasetFromSource(event, source)

  const offsetRaw = typeof query.cursor === 'string' ? Number(query.cursor) : 0
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0
  const limit = clampImportLimit(query.limit)

  const rows = dataset.rows.slice(offset, offset + limit)
  return {
    sourceId: source.id ?? 0,
    sheetTitle: dataset.sheetTitle,
    headers: dataset.index.headers,
    columns: dataset.index.mapping.columns,
    total: dataset.rows.length,
    rows,
    nextCursor: importNextCursor(rows, offset, limit),
    skipped: dataset.skipped,
    filtered: dataset.filtered,
    truncated: dataset.truncated,
    importedAt: new Date(dataset.index.fetchedAt).toISOString(),
  }
})