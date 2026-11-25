import { readBody } from 'h3'
import { SCAN_COLUMN_NAME_MAX_LENGTH, type ScanColumnsResponse } from '#shared/utils/scan'
import { createScanColumns } from '../utils/scanRun'
import { requireSource } from '../utils/dataset'

/**
 * シートに記録列を追加する。登録済みユーザのみ(/scan の「新しい記録を作る」から叩く)。
 *
 * 対象シートは body の sourceId(どのデータセットのモードを作るか)。列追加は appendColumns で
 * 明示的に拡張してからヘッダーセルを書く(範囲外書き込みの自動拡張に頼らない)。
 * 同名列が既にヘッダーにあるときは作らず existing を返す(重複列を作らない)。
 * addToIncludeColumns=true のとき **そのデータセットの** include_columns に追記する
 * (次回取り込みで payload が消えないようにする。旧 sync_settings の singleton は使わない)。
 * 列名は trim + SCAN_COLUMN_NAME_MAX_LENGTH で切る(シートヘッダーとして長い名は扱えない)。
 */
export default defineEventHandler(async (event): Promise<ScanColumnsResponse> => {
  const { user } = await requireRegisteredUser(event)

  const body = await readBody<{ columns?: unknown; sourceId?: unknown; addToIncludeColumns?: unknown }>(event)
  const raw = Array.isArray(body?.columns) ? body!.columns : []
  const names = raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().slice(0, SCAN_COLUMN_NAME_MAX_LENGTH))
    .filter(Boolean)
  if (names.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '追加するカラム名が必要です' })
  }

  const source = await requireSource(event, body?.sourceId)
  const created = await createScanColumns(event, source, names, user.email ?? null, body?.addToIncludeColumns !== false)

  return {
    sheetTitle: created.sheetTitle,
    created: created.created,
    existing: created.existing,
    headers: created.headers,
    includeColumnsUpdated: created.includeColumnsUpdated,
    includeColumns: created.includeColumns,
  }
})