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
  stateOfPayload,
  type ScanMode,
  type ScanRecordEntry,
  type ScanStatus,
} from '#shared/utils/scan'
import {
  a1Cell,
  columnLetter,
  mapSheetRows,
  normalizeHeaders,
  type SheetMapping,
  type SyncSource,
} from '#shared/utils/sync'
import { appendColumns, fetchSpreadsheetValues, readServiceAccountKey, updateCells, SHEETS_BATCH_MAX, type CellWrite } from './googleSheets'
import { apiFailure } from './apiError'
import { updateSource } from './syncRun'

/**
 * スキャンの記録実行側(モードの読み書き・シート索引・記録書き込み・証跡)。
 * すべての Supabase アクセスはユーザセッションの client を通す(権限は RLS が握る。Secret key は使わない)。
 *
 * 2026-11-22 の複数データセット化 + 2026-11-26 のレガシーテーブル撤去:
 * - 対象シートは `SyncSource`(public.sync_sources の行)で決まる。モードは 1ソースに紐づく(`source_id`)。
 * - 氏名・済/未の正は**シートの値**(`payloadIndex`)。データ本体を置くテーブルは Supabase に無い
 *   (旧 `items` テーブルは 0009 で drop した)。flush はシートへ書いてから証跡 `scan_events` に残す
 *   (シートが唯一の正なので2段整合は無い)。
 * - 端末内のミラー(IndexedDB)への反映は画面側が flush 応答の `written` を写す(サーバーは端末に触らない)。
 */

// ── モード ────────────────────────────────────────────────

export interface LoadedScanModes {
  modes: ScanMode[]
  updatedBy: string | null
  updatedAt: string | null
  /** scan_modes の行が 0(0006 未適用 or シード未投入)。UI は既定プリセットを表示する */
  rowMissing: boolean
}

/** scan_modes の select 列(ソース紐づきの source_id を含む)。 */
const MODE_COLUMNS =
  'id, source_id, name, actions, dedupe, confirm_before_record, require_found, enabled, updated_at, updated_by'

export async function loadScanModes(event: H3Event): Promise<LoadedScanModes> {
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('scan_modes')
    .select(MODE_COLUMNS)
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
 * 各モードは source_id を持つ(記録先シートが決まらないモードを作らない = 400)。
 */
export async function saveScanModes(
  event: H3Event,
  modes: ScanMode[],
  email: string | null,
): Promise<{ modes: ScanMode[]; updatedAt: string | null }> {
  const supabase = await serverSupabaseClient(event)

  const kept = normalizeScanModes(modes)
  for (const mode of kept) {
    if (mode.sourceId === null) {
      throw createError({
        statusCode: 400,
        statusMessage: `モード "${mode.name}" のデータセットが未指定です(ソースを選んでから保存してください)`,
      })
    }
  }
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
    .select(MODE_COLUMNS)
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
  /** スプレッドシート内のワークシート名一覧(設定の worksheet 不一致の案内用) */
  titles: string[]
  headers: string[]
  /** code → 1起点の行番号(values[0] はヘッダーなので data row index + 1) */
  rowIndex: Map<string, number>
  /** code カラムの列 index */
  codeIndex: number
  /**
   * code → シート値から作った payload。**全カラム**を rename 適用で載せる(取り込み選別は mapSheetRows が別途行う)。
   * 氏名と済/未の正はこれ(items テーブルは使わない)。記録列は include_columns に載らないこともあるので全カラム読む。
   */
  payloadIndex: Map<string, Record<string, string>>
  /** mapSheetRows の結果(/api/import の分页と /api/source-preview がこの行一覧を使う) */
  mapping: SheetMapping
  fetchedAt: number
}

/** シート索引のキャッシュ TTL(連続スキャンの1件ごとに全シート読みをしないため)。 */
const SHEET_INDEX_TTL_MS = 60_000
/** Worker 側のメモリキャッシュ(リクエスト間で生きることがある。cold start では消える)。 */
const sheetIndexCache = new Map<string, SheetIndex>()

export function sheetCacheKey(source: SyncSource): string {
  return `${source.id}|${source.spreadsheetId}|${source.worksheet ?? ''}|${source.codeColumn}`
}

/** 列追加・設定変更でヘッダーや選別が変わったときはキャッシュを捨てる(古い行索引で別セルに書かない)。 */
export function invalidateSheetIndexCache(source?: SyncSource): void {
  if (source) sheetIndexCache.delete(sheetCacheKey(source))
  else sheetIndexCache.clear()
}

/**
 * 対象シートのヘッダー + code → 行番号 + code → payload(TTL つき)。
 * remark-update と同じ基準(values[0] = ヘッダー、データ行 = index + 1)。
 * code カラムがヘッダーに無いときは column_missing と同じ 400 を返す(設定ミス)。
 */
export async function loadSheetIndex(event: H3Event, source: SyncSource): Promise<SheetIndex> {
  const key = sheetCacheKey(source)
  const cached = sheetIndexCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < SHEET_INDEX_TTL_MS) return cached

  const sa = await readServiceAccountKey()
  if (!sa) {
    throw apiFailure(
      400,
      { reason: 'service_account_not_configured', sourceId: source.id, sourceName: source.name },
      'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です(Worker の secret に設定)',
    )
  }
  if (!source.spreadsheetId) {
    throw apiFailure(
      400,
      { reason: 'spreadsheet_not_configured', sourceId: source.id, sourceName: source.name },
      `データセット "${source.name}" のスプレッドシート ID が未設定です(/sync の「データの設定」で入力)`,
    )
  }

  let sheet: Awaited<ReturnType<typeof fetchSpreadsheetValues>>
  try {
    sheet = await fetchSpreadsheetValues(source.spreadsheetId, source.worksheet, sa)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    console.error('[scan] sheets read:', detail)
    throw apiFailure(
      502,
      { reason: 'sheet_read_failed', sourceId: source.id, sourceName: source.name, detail },
      `シート読み取り失敗(${source.name})`,
    )
  }

  const headers = normalizeHeaders(sheet.values[0] ?? [])
  const codeIndex = headers.indexOf(source.codeColumn)
  if (codeIndex === -1) {
    throw apiFailure(
      400,
      {
        reason: 'code_column_missing',
        sourceId: source.id,
        sourceName: source.name,
        columns: [source.codeColumn],
        detail: `ヘッダー: ${headers.join(', ')}`,
      },
      `code カラム "${source.codeColumn}" がヘッダーにありません(${source.name})`,
    )
  }
  const rowIndex = new Map<string, number>()
  const payloadIndex = new Map<string, Record<string, string>>()
  sheet.values.forEach((row, i) => {
    if (i === 0) return
    const code = String(row?.[codeIndex] ?? '').trim()
    if (!code) return
    if (!rowIndex.has(code)) rowIndex.set(code, i + 1)
    if (!payloadIndex.has(code)) {
      // 全カラムを rename 適用で写す(記録列は include_columns に無いこともあるので選別前値が正)
      const payload: Record<string, string> = {}
      headers.forEach((h, col) => {
        if (col === codeIndex) return
        const value = row?.[col]
        if (value === undefined || value === null || value === '') return
        payload[source.rename[h] ?? h] = String(value)
      })
      payloadIndex.set(code, payload)
    }
  })

  const index: SheetIndex = {
    title: sheet.title,
    titles: sheet.titles ?? [],
    headers,
    rowIndex,
    codeIndex,
    payloadIndex,
    mapping: mapSheetRows(sheet.values, source),
    fetchedAt: Date.now(),
  }
  sheetIndexCache.set(key, index)
  return index
}

/**
 * 設定画面用にシートのヘッダーを読む。未設定・鍵なし・読み取り失敗は null(throw しない)。
 * /scan と /scan-settings の SSR がシート読み取りの失敗で落ちないようにするための読み取り専用版。
 */
export async function readSheetHeaders(
  event: H3Event,
  source: SyncSource | null,
): Promise<{ title: string; headers: string[] } | null> {
  if (!source || !source.spreadsheetId) return null
  try {
    const index = await loadSheetIndex(event, source)
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
    throw apiFailure(
      400,
      {
        reason: 'record_column_missing',
        columns: missing,
        detail: `ヘッダー: ${index.headers.join(', ')}`,
      },
      `記録カラム "${missing.join(', ')}" がヘッダーにありません(スキャン画面で列を追加できます)`,
    )
  }
  return mode.actions.map((a) => ({
    colIdx: index.headers.indexOf(a.column),
    colAtIdx: a.columnAt ? index.headers.indexOf(a.columnAt) : -1,
  }))
}

// ── シート値からの1行照会 ─────────────────────────────────

/** シート値(payloadIndex)からの1行照会。氏名は payload の固定キー。 */
export function sheetRowOf(index: SheetIndex, code: string): { payload: Record<string, string>; name: string | null } | null {
  const payload = index.payloadIndex.get(code)
  if (!payload) return null
  const name = typeof payload[ITEM_NAME_KEY] === 'string' ? payload[ITEM_NAME_KEY] : null
  return { payload, name }
}

// stateOfPayload(payload から済/未と記録日時を出す)は #shared/utils/scan に集約した
// (端末ミラーの照合と同じ根で済/未を出すため)。

// 読み取り専用の check(シート値 → 現在の状態)の API は撤去した(`/api/scan-check`)。
// スキャンの照合は端末ミラーが走る(shared/utils/offline.ts の offlineScanCheckResponse)。
// flush は**その時点のシート値**を読んでから書く(他の端末の書き込みを吸収する)。

// ── 記録の確定(flush: シート書き込み + payload + 証跡)─────

export interface ScanFlushInput {
  code: string
  /** 重複を上書きする(画面の「上書き」ボタンのぶん。dedupe='skip' は上書きしない) */
  overwrite?: boolean
  /**
   * この読み取りの時刻(ISO)。オフライン記録の復旧確定では **オフライン時のスキャン日時** を送る
   * (シートの日時セル・証跡 scan_events.at に載る。不正/省略は確定時刻にフォールバック)。
   * オンラインの scan-flush は送らない(従来どおり確定時刻)。
   */
  at?: string
}

export interface ScanFlushResult {
  results: ScanRecordEntry[]
  wrote: number
  /** 証跡 scan_events の insert が成功したか(false でもシート書き込みは完了している) */
  auditWritten: boolean
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
      source_id: mode.sourceId,
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
 * code の群をモードに従って記録する(確定)。対象シートは mode.sourceId のデータセットで決まる。
 * - シート値に無い code は require_found で not_found(書き込まない)
 * - シート行が無い code は sheet_missing(書き込まない)
 * - 既に記録済み(duplicate)は dedupe と overwrite で扱う
 *   - allow または overwrite → 上書きして status='duplicate'(上書きしたことは履歴に残す)
 *   - warn → 書き込まない(status='duplicate')、skip → 書き込まない(status='skipped')
 * 書き込みは values:batchUpdate の一括(100 range/chunk)。**payload 反映はしない**(シートが唯一の正。
 * 端末ミラーへの反映は画面側が応答の written を IndexedDB に写す)。
 */
export async function flushScan(
  event: H3Event,
  mode: ScanMode,
  source: SyncSource,
  actorEmail: string | null,
  inputs: ScanFlushInput[],
): Promise<ScanFlushResult> {
  const codes = inputs.map((i) => i.code.trim()).filter(Boolean).slice(0, SCAN_CODES_MAX)
  const overwriteSet = new Set(inputs.filter((i) => i.overwrite === true).map((i) => i.code.trim()))
  if (codes.length === 0) return { results: [], wrote: 0, auditWritten: true, sheetTitle: '' }

  // per-entry の読み取り時刻(ローカル待機の復旧確定用)。不正・省略は確定時刻にフォールバックする。
  const fallbackAtIso = new Date().toISOString()
  const cleanInputs = inputs
    .map((i) => ({
      code: i.code.trim(),
      overwrite: i.overwrite === true,
      at: typeof i.at === 'string' && Number.isFinite(Date.parse(i.at)) ? i.at : fallbackAtIso,
    }))
    .filter((i) => i.code)
    .slice(0, SCAN_CODES_MAX)

  // 行位置と現在の状態は**この時点のシート値**から確定する(他の端末が先に書いた可能性を吸収する)
  const index = await loadSheetIndex(event, source)
  const cells = resolveActionColumns(mode, index)

  const results: ScanRecordEntry[] = []
  const writes: CellWrite[] = []
  const eventRows: { code: string; name: string | null; status: ScanStatus; written: Record<string, string>; range: string | null; at: string }[] = []

  for (const input of cleanInputs) {
    const code = input.code
    const atIso = input.at
    const atJst = formatJst(atIso)
    const row = sheetRowOf(index, code)
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

    results.push({ code, status: state === '済' ? 'duplicate' : 'ok', name, written, range, at: atIso })
    eventRows.push({ code, name, status: state === '済' ? 'duplicate' : 'ok', written, range, at: atIso })
  }

  const sa = await readServiceAccountKey()
  if (!sa) {
    throw apiFailure(
      400,
      { reason: 'service_account_not_configured', sourceId: source.id, sourceName: source.name },
      'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です(Worker の secret に設定)',
    )
  }

  let writeFailed = false
  for (let from = 0; from < writes.length; from += SHEETS_BATCH_MAX) {
    const part = writes.slice(from, from + SHEETS_BATCH_MAX)
    try {
      await updateCells(source.spreadsheetId, sa, part)
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
    return { results, wrote: 0, auditWritten: false, sheetTitle: index.title }
  }

  const auditWritten = await insertScanEvents(event, mode, actorEmail, eventRows)
  const wrote = results.filter((r) => r.status === 'ok' || r.status === 'duplicate').length
  return { results, wrote, auditWritten, sheetTitle: index.title }
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
 * 対象シートに列を追加し、ヘッダー名を書き、そのデータセットの取り込みカラム(include_columns)へ追記する。
 * 既存ヘッダーに同名がある列は作らない(重複列を作らない)。
 * 列追加は appendColumns で明示的に拡張する(範囲外書き込みの自動拡張に頼らない)。
 */
export async function createScanColumns(
  event: H3Event,
  source: SyncSource,
  names: string[],
  email: string | null,
  addToIncludeColumns: boolean,
): Promise<ScanColumnsResult> {
  const wanted = names.map((n) => n.trim()).filter(Boolean)
  if (wanted.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '追加するカラム名が必要です' })
  }

  const index = await loadSheetIndex(event, source)
  const existing: string[] = []
  const missing: string[] = []
  for (const name of wanted) {
    if (index.headers.indexOf(name) !== -1) existing.push(name)
    else if (!missing.includes(name)) missing.push(name)
  }

  const sa = await readServiceAccountKey()
  if (!sa) {
    throw apiFailure(
      400,
      { reason: 'service_account_not_configured', sourceId: source.id, sourceName: source.name },
      'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です(Worker の secret に設定)',
    )
  }

  let created: string[] = []
  if (missing.length > 0) {
    await appendColumns(source.spreadsheetId, sa, index.title, missing.length)
    const writes: CellWrite[] = missing.map((name, i) => ({
      range: a1Cell(index.title, index.headers.length + i, 1),
      value: name,
    }))
    await updateCells(source.spreadsheetId, sa, writes)
    created = missing
    invalidateSheetIndexCache(source)
  }

  const headers = created.length > 0 ? [...index.headers, ...created] : index.headers
  let includeColumnsUpdated = false
  let includeColumns = source.includeColumns
  if (addToIncludeColumns && created.length > 0) {
    const next = [...source.includeColumns]
    for (const name of created) {
      if (!next.includes(name)) next.push(name)
    }
    // codeColumn は selectColumns が常に保持するので include_columns に載せない(取り込み選別と同じ基準)
    if (next.length !== source.includeColumns.length) {
      await updateSource(event, { ...source, includeColumns: next }, email)
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
