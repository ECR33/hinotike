import { serverSupabaseClient } from '#supabase/server'
import type { H3Event } from 'h3'
import { ITEM_NAME_KEY } from '#shared/utils/items'
import {
  DEFAULT_SCAN_MODES,
  formatJst,
  SCAN_CODES_MAX,
  scanModeFromDb,
  scanModeToDb,
  normalizeScanModes,
  recordState,
  type ScanMode,
  type ScanRecordEntry,
  type ScanStatus,
} from '#shared/utils/scan'
import { a1Cell, columnLetter, normalizeHeaders, type SyncSettings } from '#shared/utils/sync'
import { appendColumns, fetchSpreadsheetValues, readServiceAccountKey, updateCells, SHEETS_BATCH_MAX, type CellWrite } from './googleSheets'
import { loadSyncSettings, saveSyncSettings } from './syncRun'

/**
 * スキャンの記録実行側(モードの読み書き・シート行索引・記録書き込み・証跡)。
 * すべての Supabase アクセスはユーザセッションの client を通す(権限は RLS が握る。Secret key は使わない)。
 * 書き込み順は remark-update と同じ「シート → items payload」(シートが正)。
 */

// ── モード ────────────────────────────────────────────────

export interface LoadedScanModes {
  modes: ScanMode[]
  updatedBy: string | null
  updatedAt: string | null
  /** scan_modes の行が 0(0006 未適用 or シード未投入)。UI は既定プリセットを表示する */
  rowMissing: boolean
}

export async function loadScanModes(event: H3Event): Promise<LoadedScanModes> {
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('scan_modes')
    .select('id, name, actions, dedupe, confirm_before_record, require_found, enabled, updated_at, updated_by')
    .order('id', { ascending: true })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: `scan_modes の読み込み失敗: ${error.message}` })
  }
  const rows = (data ?? []) as Record<string, unknown>[]
  const modes = rows.map(scanModeFromDb).filter((m): m is ScanMode => m !== null)
  const latest = rows[rows.length - 1]
  return {
    modes,
    updatedBy: typeof latest?.updated_by === 'string' ? latest.updated_by : null,
    updatedAt: typeof latest?.updated_at === 'string' ? latest.updated_at : null,
    rowMissing: rows.length === 0,
  }
}

/**
 * モードを保存する(追加・更新・削除)。既定プリセット(DB 行 0 のとき)も save で行が作られる。
 * 削除は「送られたリストに無い id」を消す(リストに id が無い項目は新規 insert)。
 */
export async function saveScanModes(
  event: H3Event,
  modes: ScanMode[],
  email: string | null,
): Promise<{ modes: ScanMode[]; updatedAt: string | null }> {
  const supabase = await serverSupabaseClient(event)

  const kept = normalizeScanModes(modes)
  const existingIds = kept.filter((m) => m.id !== null).map((m) => m.id as number)

  if (existingIds.length > 0) {
    const { data: stale, error: staleErr } = await supabase
      .from('scan_modes')
      .select('id')
      .not('id', 'in', `(${existingIds.map((i) => i).join(',')})`)
    if (staleErr) {
      throw createError({ statusCode: 500, statusMessage: `scan_modes の削除対象照会失敗: ${staleErr.message}` })
    }
    const staleIds = (stale ?? []).map((r) => (r as { id: number }).id)
    if (staleIds.length > 0) {
      // scan_events は mode_id を restrict で参照しているので、履歴を持つモードは削除できない
      // (証跡を残す設計。画面は「履歴のあるモードは削除できません」と案内する)。
      const { error: delErr } = await supabase.from('scan_modes').delete().in('id', staleIds)
      if (delErr) {
        throw createError({
          statusCode: 400,
          statusMessage: 'このモードは記録履歴があるため削除できません(無効化してください)',
        })
      }
    }
  }

  const now = new Date().toISOString()
  let updatedAt: string | null = now
  for (const mode of kept) {
    const db = { ...scanModeToDb(mode), updated_by: email }
    if (mode.id === null) {
      const { data, error } = await supabase.from('scan_modes').insert(db).select('id').single()
      if (error) {
        throw createError({ statusCode: 400, statusMessage: `モード "${mode.name}" の保存失敗: ${error.message}` })
      }
      if (typeof data?.id === 'number') mode.id = data.id
    } else {
      const { error } = await supabase.from('scan_modes').update(db).eq('id', mode.id)
      if (error) {
        throw createError({ statusCode: 400, statusMessage: `モード "${mode.name}" の保存失敗: ${error.message}` })
      }
    }
  }
  return { modes: kept, updatedAt }
}

export function defaultScanModes(): ScanMode[] {
  return DEFAULT_SCAN_MODES.map((m) => ({ ...m, actions: m.actions.map((a) => ({ ...a })) }))
}

/** モードを id で引く(無いは 400。削除されたモードの code 読み取りを黙って通さない)。 */
export async function findScanMode(event: H3Event, modeId: number): Promise<ScanMode> {
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('scan_modes')
    .select('id, name, actions, dedupe, confirm_before_record, require_found, enabled, updated_at, updated_by')
    .eq('id', modeId)
    .maybeSingle()
  if (error) {
    throw createError({ statusCode: 500, statusMessage: `scan_modes の照会失敗: ${error.message}` })
  }
  const mode = scanModeFromDb((data ?? null) as Record<string, unknown> | null)
  if (!mode) {
    throw createError({ statusCode: 400, statusMessage: '記録モードが見つかりません(削除されたまたは未作成)' })
  }
  return mode
}

// ── シートの行索引(1読み取りで複数 code を解く)─────────────

export interface SheetIndex {
  title: string
  headers: string[]
  /** code → 1起点の行番号(values[0] はヘッダーなので data row index + 1) */
  rowIndex: Map<string, number>
  /** code カラムの列 index */
  codeIndex: number
  fetchedAt: number
}

/** シート索引のキャッシュ TTL(連続スキャンの1件ごとに全シート読みをしないため)。 */
const SHEET_INDEX_TTL_MS = 60_000
/** Worker 側のメモリキャッシュ(リクエスト間で生きることがある。cold start では消える)。 */
const sheetIndexCache = new Map<string, SheetIndex>()

export function sheetCacheKey(settings: SyncSettings): string {
  return `${settings.spreadsheetId}|${settings.worksheet ?? ''}|${settings.codeColumn}`
}

/** 列追加などでヘッダーが変わったときはキャッシュを捨てる(古い行索引で別セルに書かない)。 */
export function invalidateSheetIndexCache(settings?: SyncSettings): void {
  if (settings) sheetIndexCache.delete(sheetCacheKey(settings))
  else sheetIndexCache.clear()
}

/**
 * 対象シートのヘッダー + code → 行番号の索引(TTL つき)。
 * remark-update と同じ基準(values[0] = ヘッダー、データ行 = index + 1)。
 * code カラムがヘッダーに無いときは column_missing と同じ 400 を返す(設定ミス)。
 */
export async function loadSheetIndex(event: H3Event, settings: SyncSettings): Promise<SheetIndex> {
  const key = sheetCacheKey(settings)
  const cached = sheetIndexCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < SHEET_INDEX_TTL_MS) return cached

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
    console.error('[scan] sheets read:', e instanceof Error ? e.message : String(e))
    throw createError({ statusCode: 502, statusMessage: 'シート読み取り失敗' })
  }

  const headers = normalizeHeaders(sheet.values[0] ?? [])
  const codeIndex = headers.indexOf(settings.codeColumn)
  if (codeIndex === -1) {
    throw createError({
      statusCode: 400,
      statusMessage: `code カラム "${settings.codeColumn}" がヘッダーにありません`,
      data: { column: settings.codeColumn, headers },
    })
  }
  const rowIndex = new Map<string, number>()
  sheet.values.forEach((row, i) => {
    if (i === 0) return
    const code = String(row?.[codeIndex] ?? '').trim()
    if (code && !rowIndex.has(code)) rowIndex.set(code, i + 1)
  })

  const index: SheetIndex = { title: sheet.title, headers, rowIndex, codeIndex, fetchedAt: Date.now() }
  sheetIndexCache.set(key, index)
  return index
}

/**
 * 設定画面用にシートのヘッダーを読む。未設定・鍵なし・読み取り失敗は null(throw しない)。
 * /scan と /scan-settings の SSR がシート読み取りの失敗で落ちないようにするための読み取り専用版。
 */
export async function readSheetHeaders(
  event: H3Event,
  settings: SyncSettings | null,
): Promise<{ title: string; headers: string[] } | null> {
  if (!settings || !settings.spreadsheetId) return null
  try {
    const index = await loadSheetIndex(event, settings)
    return { title: index.title, headers: index.headers }
  } catch {
    return null
  }
}

/** モードの書くカラムがヘッダーに揃っているか(無いなら 400 + ヘッダー一覧。列作成の案内を出す)。 */
export function resolveActionColumns(mode: ScanMode, index: SheetIndex): { colIdx: number; colAtIdx: number }[] {
  const missing = mode.actions
    .flatMap((a) => (a.columnAt ? [a.column, a.columnAt] : [a.column]))
    .filter((name) => index.headers.indexOf(name) === -1)
  if (missing.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `記録カラム "${missing.join(', ')}" がヘッダーにありません(スキャン画面で列を追加できます)`,
      data: { columns: missing, headers: index.headers },
    })
  }
  return mode.actions.map((a) => ({
    colIdx: index.headers.indexOf(a.column),
    colAtIdx: a.columnAt ? index.headers.indexOf(a.columnAt) : -1,
  }))
}

// ── 記録の照合(check: 書き込まない)──────────────────────

export interface ScanCheckResult {
  status: ScanStatus
  name: string | null
  state: '済' | '未'
  recordedAt: string
  found: boolean
}

/** items 行の照会(RLS: items_select_registered_users)。氏名は payload の固定キー。 */
export async function lookupItemRow(
  event: H3Event,
  codes: string[],
): Promise<Map<string, { payload: Record<string, unknown>; name: string | null }>> {
  const supabase = await serverSupabaseClient(event)
  const out = new Map<string, { payload: Record<string, unknown>; name: string | null }>()
  for (let from = 0; from < codes.length; from += 100) {
    const part = codes.slice(from, from + 100)
    const { data, error } = await supabase.from('items').select('code, payload').in('code', part)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: `items の照会失敗: ${error.message}` })
    }
    for (const row of data ?? []) {
      const r = row as { code: string; payload: Record<string, unknown> }
      const name = typeof r.payload?.[ITEM_NAME_KEY] === 'string' ? (r.payload[ITEM_NAME_KEY] as string) : null
      out.set(r.code, { payload: r.payload ?? {}, name })
    }
  }
  return out
}

/** payload から済/未と記録日時を出す(モードの payload キーを使う)。 */
export function stateOfPayload(payload: Record<string, unknown>, mode: ScanMode): { state: '済' | '未'; recordedAt: string } {
  let state: '済' | '未' = '未'
  let recordedAt = ''
  for (const action of mode.actions) {
    const one = recordState(payload, action.payloadKey, action.payloadAtKey)
    if (one === '済') state = '済'
    const at = payload[action.payloadAtKey]
    if (typeof at === 'string' && at.trim() && !recordedAt) recordedAt = at.trim()
  }
  return { state, recordedAt }
}

/** check(読み取り専用)。items → シート行 → 現在の状態。書き込まない。 */
export async function checkScanCode(
  event: H3Event,
  mode: ScanMode,
  settings: SyncSettings,
  code: string,
): Promise<ScanCheckResult> {
  const items = await lookupItemRow(event, [code])
  const row = items.get(code)
  const found = row !== undefined
  if (!found && mode.requireFound) {
    return { status: 'not_found', name: null, state: '未', recordedAt: '', found: false }
  }
  const index = await loadSheetIndex(event, settings)
  if (!index.rowIndex.has(code)) {
    return { status: 'sheet_missing', name: row?.name ?? null, state: '未', recordedAt: '', found }
  }
  const { state, recordedAt } = stateOfPayload(row?.payload ?? {}, mode)
  return { status: state === '済' ? 'duplicate' : 'ok', name: row?.name ?? null, state, recordedAt, found }
}

// ── 記録の確定(flush: シート書き込み + payload + 証跡)─────

export interface ScanFlushInput {
  code: string
  /** 重複を上書きする(画面の「上書き」ボタンのぶん。dedupe='skip' は上書きしない) */
  overwrite?: boolean
}

export interface ScanFlushResult {
  results: ScanRecordEntry[]
  wrote: number
  dbUpdated: boolean
  sheetTitle: string
}

/** 証跡をまとめて insert(RLS: scan_events_insert_registered)。失敗は握らずログに出す(記録自体は返す)。 */
async function insertScanEvents(
  event: H3Event,
  mode: ScanMode,
  actorEmail: string | null,
  rows: { code: string; name: string | null; status: ScanStatus; written: Record<string, string>; range: string | null; at: string }[],
): Promise<boolean> {
  if (rows.length === 0) return true
  const supabase = await serverSupabaseClient(event)
  const { error } = await supabase.from('scan_events').insert(
    rows.map((r) => ({
      code: r.code,
      mode_id: mode.id,
      mode_name: mode.name,
      name: r.name,
      actor_email: actorEmail,
      status: r.status,
      written: r.written,
      sheet_range: r.range,
      at: r.at,
    })),
  )
  if (error) {
    console.error('[scan] scan_events insert:', error.message)
    return false
  }
  return true
}

/**
 * code の群をモードに従って記録する(確定)。
 * - items に見つからない code は require_found で not_found(書き込まない)
 * - シート行が無い code は sheet_missing(書き込まない)
 * - 既に記録済み(duplicate)は dedupe と overwrite で扱う
 *   - allow または overwrite → 上書きして status='duplicate'(上書きしたことは履歴に残す)
 *   - warn → 書き込まない(status='duplicate')、skip → 書き込まない(status='skipped')
 * 書き込みは values:batchUpdate の一括(100 range/chunk)。payload は code ごとに merge。
 */
export async function flushScan(
  event: H3Event,
  mode: ScanMode,
  settings: SyncSettings,
  actorEmail: string | null,
  inputs: ScanFlushInput[],
): Promise<ScanFlushResult> {
  const codes = inputs.map((i) => i.code.trim()).filter(Boolean).slice(0, SCAN_CODES_MAX)
  const overwriteSet = new Set(inputs.filter((i) => i.overwrite === true).map((i) => i.code.trim()))
  if (codes.length === 0) return { results: [], wrote: 0, dbUpdated: true, sheetTitle: '' }

  const index = await loadSheetIndex(event, settings)
  const cells = resolveActionColumns(mode, index)
  const items = await lookupItemRow(event, codes)
  const atJst = formatJst(new Date().toISOString())
  const atIso = new Date().toISOString()

  const results: ScanRecordEntry[] = []
  const writes: CellWrite[] = []
  const payloadUpdates: { code: string; payload: Record<string, unknown> }[] = []
  const eventRows: { code: string; name: string | null; status: ScanStatus; written: Record<string, string>; range: string | null; at: string }[] = []

  for (const code of codes) {
    const row = items.get(code)
    const name = row?.name ?? null
    if (!row && mode.requireFound) {
      results.push({ code, status: 'not_found', name, written: {}, range: null, at: atIso })
      eventRows.push({ code, name, status: 'not_found', written: {}, range: null, at: atIso })
      continue
    }
    const rowNumber = index.rowIndex.get(code)
    if (rowNumber === undefined) {
      results.push({ code, status: 'sheet_missing', name, written: {}, range: null, at: atIso })
      eventRows.push({ code, name, status: 'sheet_missing', written: {}, range: null, at: atIso })
      continue
    }
    const { state } = stateOfPayload(row?.payload ?? {}, mode)
    if (state === '済') {
      const willOverwrite = mode.dedupe === 'allow' || overwriteSet.has(code)
      if (!willOverwrite) {
        const status: ScanStatus = mode.dedupe === 'skip' ? 'skipped' : 'duplicate'
        results.push({ code, status, name, written: {}, range: null, at: atIso })
        eventRows.push({ code, name, status, written: {}, range: null, at: atIso })
        continue
      }
    }

    const written: Record<string, string> = {}
    let range: string | null = null
    cells.forEach((cell, i) => {
      const action = mode.actions[i]
      if (!action) return
      writes.push({ range: a1Cell(index.title, cell.colIdx, rowNumber), value: action.literal })
      written[action.payloadKey] = action.literal
      if (cell.colAtIdx >= 0) {
        writes.push({ range: a1Cell(index.title, cell.colAtIdx, rowNumber), value: atJst })
        if (action.payloadAtKey) written[action.payloadAtKey] = atJst
      }
      if (range === null) range = a1Cell(index.title, cell.colIdx, rowNumber)
    })

    if (row) {
      payloadUpdates.push({ code, payload: { ...row.payload, ...written } })
    }
    results.push({ code, status: state === '済' ? 'duplicate' : 'ok', name, written, range, at: atIso })
    eventRows.push({ code, name, status: state === '済' ? 'duplicate' : 'ok', written, range, at: atIso })
  }

  const sa = readServiceAccountKey()
  if (!sa) {
    throw createError({ statusCode: 400, statusMessage: 'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です(Worker の secret に設定)' })
  }

  let writeFailed = false
  for (let from = 0; from < writes.length; from += SHEETS_BATCH_MAX) {
    const part = writes.slice(from, from + SHEETS_BATCH_MAX)
    try {
      await updateCells(settings.spreadsheetId, sa, part)
    } catch (e) {
      console.error('[scan] sheets write:', e instanceof Error ? e.message : String(e))
      writeFailed = true
      break
    }
  }

  if (writeFailed) {
    // シート書き込みが失敗したぶんは write_failed として証跡に残す(画面は「もう一度確定」を案内できる)
    const failedCodes = new Set(results.filter((r) => r.status === 'ok' || r.status === 'duplicate').map((r) => r.code))
    const failedRows = eventRows.filter((r) => failedCodes.has(r.code))
    for (const r of failedRows) r.status = 'write_failed'
    for (const r of results) {
      if (failedCodes.has(r.code)) {
        r.status = 'write_failed'
        r.written = {}
        r.range = null
      }
    }
    await insertScanEvents(event, mode, actorEmail, failedRows)
    return { results, wrote: 0, dbUpdated: false, sheetTitle: index.title }
  }

  // payload 反映(best-effort。失敗してもシートは更新済みなので次の同期で一致する = remark-update と同じ)
  let dbUpdated = true
  for (const part of payloadUpdates) {
    const supabase = await serverSupabaseClient(event)
    const { error } = await supabase.from('items').update({ payload: part.payload }).eq('code', part.code)
    if (error) {
      console.error('[scan] items update:', error.message)
      dbUpdated = false
    }
  }

  await insertScanEvents(event, mode, actorEmail, eventRows)
  const wrote = results.filter((r) => r.status === 'ok' || r.status === 'duplicate').length
  return { results, wrote, dbUpdated, sheetTitle: index.title }
}

// ── シートに記録列を作る ───────────────────────────────────

export interface ScanColumnsResult {
  sheetTitle: string
  created: string[]
  existing: string[]
  headers: string[]
  includeColumnsUpdated: boolean
  includeColumns: string[]
}

/**
 * 対象シートに列を追加し、ヘッダー名を書き、取り込みカラム(include_columns)へ追記する。
 * 既存ヘッダーに同名がある列は作らない(重複列を作らない)。
 * 列追加は addDimensionRange で明示的に拡張する(範囲外書き込みの自動拡張に頼らない)。
 */
export async function createScanColumns(
  event: H3Event,
  settings: SyncSettings,
  names: string[],
  email: string | null,
  addToIncludeColumns: boolean,
): Promise<ScanColumnsResult> {
  const wanted = names.map((n) => n.trim()).filter(Boolean)
  if (wanted.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '追加するカラム名が必要です' })
  }

  const index = await loadSheetIndex(event, settings)
  const existing: string[] = []
  const missing: string[] = []
  for (const name of wanted) {
    if (index.headers.indexOf(name) !== -1) existing.push(name)
    else if (!missing.includes(name)) missing.push(name)
  }

  const sa = readServiceAccountKey()
  if (!sa) {
    throw createError({ statusCode: 400, statusMessage: 'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です(Worker の secret に設定)' })
  }

  let created: string[] = []
  if (missing.length > 0) {
    await appendColumns(settings.spreadsheetId, sa, index.title, missing.length)
    const writes: CellWrite[] = missing.map((name, i) => ({
      range: a1Cell(index.title, index.headers.length + i, 1),
      value: name,
    }))
    await updateCells(settings.spreadsheetId, sa, writes)
    created = missing
    invalidateSheetIndexCache(settings)
  }

  const headers = created.length > 0 ? [...index.headers, ...created] : index.headers
  let includeColumnsUpdated = false
  let includeColumns = settings.includeColumns
  if (addToIncludeColumns && created.length > 0) {
    const next = [...settings.includeColumns]
    for (const name of created) {
      if (!next.includes(name)) next.push(name)
    }
    // codeColumn は selectColumns が常に保持するので include_columns に載せない(sync の選別と同じ基準)
    if (next.length !== settings.includeColumns.length) {
      const updated: SyncSettings = { ...settings, includeColumns: next }
      await saveSyncSettings(event, updated, email)
      includeColumnsUpdated = true
      includeColumns = next
    }
  }

  return { sheetTitle: index.title, created, existing, headers, includeColumnsUpdated, includeColumns }
}

/** 列位置の文字列(A1 の列表記だけ。UI の案内用)。 */
export function columnLetterAt(index: number): string {
  return columnLetter(index)
}
