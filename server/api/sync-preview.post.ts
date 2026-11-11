import { MAX_SYNC_ROWS, mapSheetRows, type SyncPreviewResponse } from '#shared/utils/sync'
import { fetchSpreadsheetValues, readServiceAccountKey } from '../utils/googleSheets'

/**
 * 同期のプレビュー(確定前に要約を見せる。書き込みは行わない)。登録済みユーザのみ。
 *
 * シートの読み取り → 選別 → 対象テーブルの既存 code 照会までを行い、
 * 新規(insert)/既存(update)の件数と先頭サンプルを返す。
 * 設定の worksheet がシート一覧に無い場合は最初のシートにフォールバックする
 * (worksheetMatched=false で UI が「フォールバックした」ことを明示する)。
 * MAX_SYNC_ROWS 超は truncated=true を返す(commit 側は拒否する)。
 */
export default defineEventHandler(async (event): Promise<SyncPreviewResponse> => {
  await requireRegisteredUser(event)

  const { settings } = await loadSyncSettings(event)

  const sa = readServiceAccountKey()
  if (!sa) {
    throw createError({ statusCode: 400, statusMessage: 'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です(Worker の secret に設定)' })
  }
  if (!settings.spreadsheetId) {
    throw createError({ statusCode: 400, statusMessage: 'スプレッドシート ID が未設定です(設定画面で入力)' })
  }

  let sheet: Awaited<ReturnType<typeof fetchSpreadsheetValues>>
  try {
    sheet = await fetchSpreadsheetValues(settings.spreadsheetId, settings.worksheet, sa)
  } catch (e) {
    console.error('[sync-preview] sheets:', e instanceof Error ? e.message : e)
    throw createError({ statusCode: 502, statusMessage: 'シート読み取り失敗' })
  }

  const dataRowCount = Math.max(0, sheet.values.length - 1)
  const truncated = dataRowCount > MAX_SYNC_ROWS
  const values = truncated ? sheet.values.slice(0, MAX_SYNC_ROWS + 1) : sheet.values

  const mapped = mapSheetRows(values, settings)
  if (mapped.codeColumnMissing) {
    throw createError({
      statusCode: 400,
      statusMessage: `code カラム "${settings.codeColumn}" がヘッダーにありません`,
      data: { codeColumn: settings.codeColumn, headers: mapped.headers },
    })
  }

  const codes = mapped.rows.map((r) => r.code)
  const existing = await existingCodes(event, settings.targetTable, codes)

  const updateCount = codes.filter((c) => existing.has(c)).length
  const insertCount = codes.length - updateCount

  return {
    sheetTitle: sheet.title,
    sheetTitles: sheet.titles,
    worksheetMatched: settings.worksheet === null || settings.worksheet === sheet.title,
    headerCount: mapped.headers.length,
    headers: mapped.headers,
    columns: mapped.columns,
    payloadKeys: payloadKeysOf(mapped.rows),
    dataRows: dataRowCount,
    skipped: mapped.skipped,
    updateCount,
    insertCount,
    sample: mapped.rows.slice(0, 10),
    truncated,
  }
})
