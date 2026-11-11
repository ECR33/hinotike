import { serverSupabaseClient } from '#supabase/server'
import type { H3Event } from 'h3'
import {
  DEFAULT_SYNC_SETTINGS,
  settingsFromDb,
  settingsToDb,
  chunk,
  UPSERT_BATCH,
  type SyncRow,
  type SyncSettings,
} from '#shared/utils/sync'

/**
 * 同期の実行側(設定の読み書き・既存 code の照会・upsert)。
 * すべての Supabase アクセスはユーザセッションの client(serverSupabaseClient)を通す。
 * 権限は RLS(policy: is_registered_user())が握るため Secret key は使わない。
 */

export interface LoadedSettings {
  settings: SyncSettings
  updatedBy: string | null
  updatedAt: string | null
  /** 設定行が無い(0003 未適用 or 初回)。既定値で動くが save で行が作られる */
  rowMissing: boolean
}

export async function loadSyncSettings(event: H3Event): Promise<LoadedSettings> {
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('sync_settings')
    .select('spreadsheet_id, worksheet, code_column, include_columns, exclude_columns, rename, target_table, updated_by, updated_at')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    // マイグレーション未適用(テーブル不存在)は 500 にする。UI は原因を「マイグレーション未適用」と案内する。
    throw createError({ statusCode: 500, statusMessage: `sync_settings の読み込み失敗: ${error.message}` })
  }
  if (!data) {
    return { settings: { ...DEFAULT_SYNC_SETTINGS }, updatedBy: null, updatedAt: null, rowMissing: true }
  }
  return {
    settings: settingsFromDb(data as Record<string, unknown>),
    updatedBy: typeof data.updated_by === 'string' ? data.updated_by : null,
    updatedAt: typeof data.updated_at === 'string' ? data.updated_at : null,
    rowMissing: false,
  }
}

/** 設定を singleton 行(id=1)に upsert する。updated_by に実行ユーザの email を記す。 */
export async function saveSyncSettings(
  event: H3Event,
  settings: SyncSettings,
  email: string | null,
): Promise<{ updatedAt: string | null }> {
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('sync_settings')
    .upsert({ ...settingsToDb(settings), updated_by: email }, { onConflict: 'id' })
    .select('updated_at')
    .single()

  if (error) {
    throw createError({ statusCode: 500, statusMessage: `sync_settings の保存失敗: ${error.message}` })
  }
  return { updatedAt: typeof data?.updated_at === 'string' ? data.updated_at : null }
}

/**
 * 対象テーブルに既に存在する code の集合。
 * 全体 select せず code を chunk して in() で照会する(大きなテーブルでも応答サイズを抑える)。
 */
export async function existingCodes(
  event: H3Event,
  targetTable: string,
  codes: string[],
): Promise<Set<string>> {
  const supabase = await serverSupabaseClient(event)
  const found = new Set<string>()
  for (const part of chunk(codes, 100)) {
    const { data, error } = await supabase.from(targetTable).select('code').in('code', part)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: `既存 code の照会失敗 (${targetTable}): ${error.message}` })
    }
    for (const row of data ?? []) {
      if (typeof (row as { code?: string }).code === 'string') found.add((row as { code: string }).code)
    }
  }
  return found
}

/** upsert(onConflict=code)。imported_at を現在時刻で更新する(既存行の再取り込みを区別するため)。 */
export async function upsertRows(
  event: H3Event,
  targetTable: string,
  rows: SyncRow[],
): Promise<void> {
  const supabase = await serverSupabaseClient(event)
  const importedAt = new Date().toISOString()
  for (const part of chunk(rows, UPSERT_BATCH)) {
    const { error } = await supabase
      .from(targetTable)
      .upsert(part.map((r) => ({ code: r.code, payload: r.payload, imported_at: importedAt })), { onConflict: 'code' })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: `upsert 失敗 (${targetTable}): ${error.message}` })
    }
  }
}

/** プレビューに出す payload キー名(rename 適用後の集合)。 */
export function payloadKeysOf(rows: SyncRow[]): string[] {
  const keys = new Set<string>()
  for (const row of rows) for (const k of Object.keys(row.payload)) keys.add(k)
  return [...keys].sort()
}
