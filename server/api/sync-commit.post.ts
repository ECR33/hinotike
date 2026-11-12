import { readBody } from 'h3'
import { MAX_SYNC_ROWS, mapSheetRows, type SyncCommitResponse } from '#shared/utils/sync'
import { fetchSpreadsheetValues, readServiceAccountKey } from '../utils/googleSheets'

/**
 * 同期の確定(実際の書き込み)。登録済みユーザのみ。
 *
 * プレビューと同じ設定でシートを再読み込みして upsert する(二段階 UI の 2 段階目)。
 * 明示的な confirm: true を要求し、誤クリック/自動実行を拒否する。
 * MAX_SYNC_ROWS 超は拒否する(部分的な書き込みは行わない)。
 * upsert は onConflict=code / imported_at を現在時刻で更新。既存行の payload は上書きされる。
 */
export default defineEventHandler(async (event): Promise<SyncCommitResponse> => {
  // 認証を先に確認する(sync_settings の select は RLS が authenticated 前提なので、
  // 未認証時に DB エラーを 500 にしない)。
  await requireRegisteredUser(event)
  const { settings } = await loadSyncSettings(event)

  const body = await readBody<{ confirm?: boolean }>(event)
  if (!body || body.confirm !== true) {
    throw createError({ statusCode: 400, statusMessage: 'confirm: true が必要です(プレビュー後の確定のみ)' })
  }

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
    console.error('[sync-commit] sheets:', e instanceof Error ? e.message : e)
    throw createError({ statusCode: 502, statusMessage: 'シート読み取り失敗' })
  }

  const dataRowCount = Math.max(0, sheet.values.length - 1)
  if (dataRowCount > MAX_SYNC_ROWS) {
    throw createError({
      statusCode: 400,
      statusMessage: `シートが上限(${MAX_SYNC_ROWS}行)を超えています(${dataRowCount}行)。部分書き込みはしません`,
    })
  }

  const mapped = mapSheetRows(sheet.values, settings)
  if (mapped.codeColumnMissing) {
    throw createError({
      statusCode: 400,
      statusMessage: `code カラム "${settings.codeColumn}" がヘッダーにありません`,
      data: { codeColumn: settings.codeColumn, headers: mapped.headers },
    })
  }
  if (mapped.filterColumnMissing) {
    throw createError({
      statusCode: 400,
      statusMessage: `行フィルタのカラム "${settings.filterColumn}" がヘッダーにありません`,
      data: { codeColumn: settings.filterColumn, headers: mapped.headers },
    })
  }

  // upsert 前に既存 code を照会して insert/update の内訳を報告する(upsert の挙動自体は idempotent)。
  const codes = mapped.rows.map((r) => r.code)
  const existing = await existingCodes(event, settings.targetTable, codes)
  const updateCount = codes.filter((c) => existing.has(c)).length

  await upsertRows(event, settings.targetTable, mapped.rows)

  // prune(削除): 設定で有効なときのみ。誤削除を防ぐガード —
  // ワークシート名が不一致(フォールバック)のときと、取り込み対象 0 行のときは削除しない。
  let deleted = 0
  if (settings.pruneOnCommit) {
    const worksheetMismatched = settings.worksheet !== null && settings.worksheet !== sheet.title
    if (worksheetMismatched) {
      console.warn(`[sync-commit] prune 中止: 設定のワークシート "${settings.worksheet}" ≠ 実際のシート "${sheet.title}"`)
    } else if (mapped.rows.length === 0) {
      console.warn('[sync-commit] prune 中止: 取り込み対象が 0 行(全行フィルタ除外または空シート)')
    } else {
      const sheetCodes = new Set(codes)
      const stale = [...(await allCodes(event, settings.targetTable))].filter((c) => !sheetCodes.has(c))
      deleted = await deleteCodes(event, settings.targetTable, stale)
    }
  }

  return {
    sheetTitle: sheet.title,
    targetTable: settings.targetTable,
    upserted: mapped.rows.length,
    insertCount: mapped.rows.length - updateCount,
    updateCount,
    skipped: mapped.skipped,
    filtered: mapped.filtered,
    deleted,
  }
})
