import { serverSupabaseClient } from '#supabase/server'
import type { H3Event } from 'h3'
import {
  DEFAULT_SOURCE,
  normalizeSources,
  sourceFromDb,
  sourceToDb,
  type SyncSource,
} from '#shared/utils/sync'

/**
 * データセット(取り込み定義)の読み書き側。
 * すべての Supabase アクセスはユーザセッションの client(serverSupabaseClient)を通す。
 * 権限は RLS(policy: is_registered_user())が握るため Secret key は使わない。
 *
 * 2026-11-22 の複数データセット化で `sync_settings`(singleton 1行)は `sync_sources`(複数行)になった。
 * データ本体(items テーブル)は使わない: 取り込みは /api/import がシートから読み、画面が IndexedDB に保存する。
 */

/** sync_sources の select 列(画面・API が同じ形を読む)。 */
export const SOURCE_COLUMNS =
  'id, name, spreadsheet_id, worksheet, code_column, include_columns, exclude_columns, filter_column, filter_values, rename, enabled, updated_at, updated_by'

export interface LoadedSources {
  sources: SyncSource[]
  updatedBy: string | null
  updatedAt: string | null
  /** ソース行が 0(0007 未適用 or 初回)。UI は既定値をそのまま表示する */
  rowMissing: boolean
}

export async function loadSources(event: H3Event): Promise<LoadedSources> {
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('sync_sources')
    .select(SOURCE_COLUMNS)
    .order('id', { ascending: true })

  if (error) {
    // マイグレーション未適用(テーブル不存在)は 500 にする。UI は原因を「マイグレーション未適用」と案内する。
    throw createError({ statusCode: 500, statusMessage: `sync_sources の読み込み失敗: ${error.message}` })
  }
  const rows = (data ?? []) as Record<string, unknown>[]
  const sources = rows.map(sourceFromDb).filter((s): s is SyncSource => s !== null)
  const latest = rows[rows.length - 1]
  return {
    sources,
    updatedBy: typeof latest?.updated_by === 'string' ? latest.updated_by : null,
    updatedAt: typeof latest?.updated_at === 'string' ? latest.updated_at : null,
    rowMissing: rows.length === 0,
  }
}

/** id でソースを引く。無いときは 400(削除されたソースへの取り込み・書き込みを黙って通さない)。 */
export async function findSource(event: H3Event, sourceId: number): Promise<SyncSource> {
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('sync_sources')
    .select(SOURCE_COLUMNS)
    .eq('id', sourceId)
    .maybeSingle()
  if (error) {
    throw createError({ statusCode: 500, statusMessage: `sync_sources の照会失敗: ${error.message}` })
  }
  const source = sourceFromDb((data ?? null) as Record<string, unknown> | null)
  if (!source) {
    throw createError({ statusCode: 400, statusMessage: 'データセットが見つかりません(削除されたまたは未作成)' })
  }
  return source
}

/** id でソースを引く(見つからなければ null。SSR が落ちないための読み取り専用版)。 */
export async function findSourceOrNull(event: H3Event, sourceId: number | null | undefined): Promise<SyncSource | null> {
  if (sourceId === null || sourceId === undefined || !Number.isInteger(sourceId)) return null
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('sync_sources')
    .select(SOURCE_COLUMNS)
    .eq('id', sourceId)
    .maybeSingle()
  if (error) {
    console.error('[sync] findSourceOrNull:', error.message)
    return null
  }
  return sourceFromDb((data ?? null) as Record<string, unknown> | null)
}

/** 有効な最初のソース(画面がソース未選択のときにフォールバックする)。無いときは null。 */
export async function firstSource(event: H3Event): Promise<SyncSource | null> {
  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('sync_sources')
    .select(SOURCE_COLUMNS)
    .eq('enabled', true)
    .order('id', { ascending: true })
    .limit(1)
  if (error) {
    console.error('[sync] firstSource:', error.message)
    return null
  }
  return sourceFromDb((data ?? [])?.[0] as Record<string, unknown> | undefined)
}

/**
 * ソースのリストを保存する(追加・更新・削除)。送られたリストが正 = リストに無い id の行は削除される。
 * id 無しは新規 insert。scan_modes.source_id が FK の restrict なので履歴を持つモードの載るソースは消せない。
 */
export async function saveSources(
  event: H3Event,
  sources: SyncSource[],
  email: string | null,
): Promise<{ sources: SyncSource[]; updatedAt: string | null }> {
  const supabase = await serverSupabaseClient(event)

  const kept = normalizeSources(sources)
  const existingIds = kept.filter((s) => s.id !== null).map((s) => s.id as number)

  if (existingIds.length > 0) {
    const { data: stale, error: staleErr } = await supabase
      .from('sync_sources')
      .select('id')
      .not('id', 'in', `(${existingIds.map((i) => i).join(',')})`)
    if (staleErr) {
      throw createError({ statusCode: 500, statusMessage: `sync_sources の削除対象照会失敗: ${staleErr.message}` })
    }
    const staleIds = (stale ?? []).map((r) => (r as { id: number }).id)
    if (staleIds.length > 0) {
      // scan_modes が source_id を restrict で参照している(記録モードが載るソースは削除できない)。
      const { error: delErr } = await supabase.from('sync_sources').delete().in('id', staleIds)
      if (delErr) {
        throw createError({
          statusCode: 400,
          statusMessage: 'このデータセットには記録モードが紐づいているため削除できません(無効化してください)',
        })
      }
    }
  }

  const now = new Date().toISOString()
  for (const source of kept) {
    const db = { ...sourceToDb(source), updated_by: email }
    if (source.id === null) {
      const { data, error } = await supabase.from('sync_sources').insert(db).select('id').single()
      if (error) {
        throw createError({ statusCode: 400, statusMessage: `データセット "${source.name}" の保存失敗: ${error.message}` })
      }
      if (typeof data?.id === 'number') source.id = data.id
    } else {
      const { error } = await supabase.from('sync_sources').update(db).eq('id', source.id)
      if (error) {
        throw createError({ statusCode: 400, statusMessage: `データセット "${source.name}" の保存失敗: ${error.message}` })
      }
    }
  }
  return { sources: kept, updatedAt: now }
}

/** 1行だけ更新する(記録列の追加で include_columns に載せる等。リスト保存の往復を避けたい経路)。 */
export async function updateSource(
  event: H3Event,
  source: SyncSource,
  email: string | null,
): Promise<void> {
  if (source.id === null) {
    throw createError({ statusCode: 400, statusMessage: 'データセットの id がありません(先に保存してください)' })
  }
  const supabase = await serverSupabaseClient(event)
  const { error } = await supabase
    .from('sync_sources')
    .update({ ...sourceToDb(source), updated_by: email })
    .eq('id', source.id)
  if (error) {
    throw createError({ statusCode: 500, statusMessage: `sync_sources の更新失敗: ${error.message}` })
  }
}

/** DB 行が無いときに出す既定の1データセット(0007 のシードと同じ値)。 */
export function defaultSources(): SyncSource[] {
  return [{ ...DEFAULT_SOURCE, includeColumns: [...DEFAULT_SOURCE.includeColumns], rename: { ...DEFAULT_SOURCE.rename } }]
}
