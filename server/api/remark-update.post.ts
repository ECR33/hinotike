import { readBody } from 'h3'
import { ITEM_REMARK_KEY, REMARK_MAX_LENGTH } from '#shared/utils/items'
import { a1Cell, normalizeHeaders, sourceColumnFor } from '#shared/utils/sync'
import { fetchSpreadsheetValues, readServiceAccountKey, updateCellValue } from '../utils/googleSheets'
import { loadSyncSettings } from '../utils/syncRun'

/**
 * 照会結果画面の備考欄の編集。登録済みユーザのみ(requireRegisteredUser)。
 *
 * 反映順は「シート → DB(items payload)」: シートが正(source of truth)なので先に書き、
 * DB 更新が失敗しても次の同期(commit)でシート値が再取り込みされて最終的に一致する。
 * 備考のセル位置は code からその場で引く(ヘッダー行 = 1行目、データ行 = index+2)。
 * 空の備考はシート側も payload 側も「無」にする(取り込み側の empty skip と同じ挙動)。
 */
export interface RemarkUpdateResponse {
  ok: true
  code: string
  /** 保存された値(trim 後。空なら空文字) */
  remark: string
  sheetTitle: string
  /** 書き込んだセル番地(A1) */
  range: string
  /** items payload の更新が成功したか(false のときシートは更新済み) */
  dbUpdated: boolean
}

export default defineEventHandler(async (event): Promise<RemarkUpdateResponse> => {
  // 認証を先に確認する(sync_settings の select は authenticated 前提なので、
  // 未認証時に DB エラーを 500 にしない — sync-commit と同じ順序)
  const { supabase } = await requireRegisteredUser(event)

  const body = await readBody<{ code?: unknown; remark?: unknown }>(event)
  const code = String(body?.code ?? '').trim()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'code is required' })
  }
  const remark = typeof body?.remark === 'string' ? body.remark.trim() : ''
  if (remark.length > REMARK_MAX_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `備考は ${REMARK_MAX_LENGTH} 文字まで` })
  }

  const { data: item, error: itemErr } = await supabase
    .from('items')
    .select('payload')
    .eq('code', code)
    .maybeSingle()
  if (itemErr) {
    console.error('[remark-update] items:', itemErr.message)
    throw createError({ statusCode: 500, statusMessage: 'items lookup failed' })
  }
  if (!item) {
    throw createError({ statusCode: 404, statusMessage: 'items に見つかりません' })
  }

  const { settings } = await loadSyncSettings(event)
  if (!settings.spreadsheetId) {
    throw createError({ statusCode: 400, statusMessage: 'スプレッドシート ID が未設定です(設定画面で入力)' })
  }
  const sa = readServiceAccountKey()
  if (!sa) {
    throw createError({ statusCode: 400, statusMessage: 'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です(Worker の secret に設定)' })
  }

  let sheet: Awaited<ReturnType<typeof fetchSpreadsheetValues>>
  try {
    sheet = await fetchSpreadsheetValues(settings.spreadsheetId, settings.worksheet, sa)
  } catch (e) {
    console.error('[remark-update] sheets read:', e instanceof Error ? e.message : e)
    throw createError({ statusCode: 502, statusMessage: 'シート読み取り失敗' })
  }

  const headers = normalizeHeaders(sheet.values[0] ?? [])
  const codeIdx = headers.indexOf(settings.codeColumn)
  if (codeIdx === -1) {
    throw createError({
      statusCode: 400,
      statusMessage: `code カラム "${settings.codeColumn}" がヘッダーにありません`,
    })
  }

  // payload キー(備考)に対応するシート側のカラム名(rename の逆引き。re-name 前名を書く)
  const sheetColumn = sourceColumnFor(ITEM_REMARK_KEY, settings.rename)
  const colIdx = headers.indexOf(sheetColumn)
  if (colIdx === -1) {
    throw createError({
      statusCode: 400,
      statusMessage: `備考カラム "${sheetColumn}" がヘッダーにありません`,
    })
  }

  // code の行を探す(values[0] はヘッダー。1起点の行番号 = index+1)
  const rowIdx = sheet.values.findIndex((r, i) => i >= 1 && String(r?.[codeIdx] ?? '').trim() === code)
  if (rowIdx === -1) {
    throw createError({ statusCode: 404, statusMessage: `code "${code}" がシートに見つかりません(再同期が必要です)` })
  }
  const rowNumber = rowIdx + 1

  try {
    await updateCellValue(settings.spreadsheetId, sheet.title, sa, colIdx, rowNumber, remark)
  } catch (e) {
    console.error('[remark-update] sheets write:', e instanceof Error ? e.message : e)
    // Google が編集スコープの権限を持っていない(シート共有が編集者以上でない)ケースを案内に含める
    throw createError({
      statusCode: 502,
      statusMessage: 'シート書き込み失敗(サービスアカウントがそのシートを編集できるか確認してください)',
    })
  }

  // items payload の更新(best-effort。失敗してもシートは更新済みなので再同期で一致する)
  const payload = (item.payload ?? {}) as Record<string, unknown>
  const next = { ...payload }
  if (remark) next[ITEM_REMARK_KEY] = remark
  else delete next[ITEM_REMARK_KEY]
  const { error: dbErr } = await supabase.from('items').update({ payload: next }).eq('code', code)
  if (dbErr) {
    console.error('[remark-update] items update:', dbErr.message)
  }

  return {
    ok: true,
    code,
    remark,
    sheetTitle: sheet.title,
    range: a1Cell(sheet.title, colIdx, rowNumber),
    dbUpdated: dbErr == null,
  }
})
