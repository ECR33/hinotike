import type { H3Event } from 'h3'
import { MAX_IMPORT_ROWS, type SyncRow, type SyncSource } from '#shared/utils/sync'
import { apiFailure } from './apiError'
import { loadSheetIndex, type SheetIndex } from './scanRun'
import { findSource, findSourceOrNull, firstSource } from './syncRun'

/**
 * シート由来のデータセット行(選別・行フィルタ適用済み)の読み取り側。
 * server の一覧(items-list)/facets/keys/照会(lookup)/取り込み(import)/プレビューが
 * **同じ行一覧**を使い、端末ミラー(IndexedDB)の行と同じ意味で shared の照合関数に渡せる。
 * Supabase の items テーブルは読まない(シートが唯一の正)。
 */
export interface DatasetRows {
  source: SyncSource
  index: SheetIndex
  /** 取り込み対象行(code + payload。mapSheetRows の選別・rename 適用済み)。
   *  SyncRow(payload は文字列のみ)は ItemRowData(payload: Record<string, unknown>)の部分型なので
   *  shared の照合関数(offlineItemsQuery / offlineFacets / datasetKeys)にそのまま渡せる。 */
  rows: SyncRow[]
  headers: string[]
  sheetTitle: string
  /** シートが MAX_IMPORT_ROWS を超えて切り捨てられたか(一覧・import は注記を出す) */
  truncated: boolean
  /** code が空でスキップされた行数 / 行フィルタで除外した行数 */
  skipped: number
  filtered: number
}

/** シートを読んで取り込み対象行を出す(シート読み取りの失敗は 502、code カラム欠けは 400)。 */
export async function datasetFromSource(event: H3Event, source: SyncSource): Promise<DatasetRows> {
  const index = await loadSheetIndex(event, source)
  const rows = index.mapping.rows.slice(0, MAX_IMPORT_ROWS)
  return {
    source,
    index,
    rows,
    headers: index.headers,
    sheetTitle: index.title,
    truncated: index.mapping.rows.length > MAX_IMPORT_ROWS || index.mapping.rows.length >= MAX_IMPORT_ROWS,
    skipped: index.mapping.skipped,
    filtered: index.mapping.filtered,
  }
}

/**
 * API が受け取る sourceId の解決。
 * - 数値で渡された → そのソース(見つからなければ 400。削除されたソースへの操作を黙って通さない)
 * - 未指定 → 有効な最初のソース(画面がソース未選択の SSR でも動く)。行が無ければ 400 で案内
 * 理由コード(`dataset_not_found` / `dataset_missing`)は `data.reason` に載る。日本語の案内は
 * `message`(body)に載せ、`statusMessage` は ASCII のコードだけ(HTTP status line は ASCII 限定)。
 */
export async function resolveSource(event: H3Event, raw: unknown): Promise<SyncSource> {
  const id = typeof raw === 'number' ? raw : Number(raw)
  if (Number.isInteger(id) && id > 0) {
    const found = await findSourceOrNull(event, id)
    if (!found) {
      throw apiFailure(400, { reason: 'dataset_not_found', sourceId: id }, 'データセットが見つかりません(削除されたまたは未作成)')
    }
    return found
  }
  const fallback = await firstSource(event)
  if (!fallback) {
    throw apiFailure(400, { reason: 'dataset_missing' }, 'データセットが未設定です(/sync でスプレッドシートを追加してください)')
  }
  return fallback
}

/** sourceId を厳密に解決する(フォールバックしない。取り込み・書き込み側)。 */
export async function requireSource(event: H3Event, raw: unknown): Promise<SyncSource> {
  const id = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw apiFailure(400, { reason: 'source_id_required' }, 'sourceId が必要です(どのデータセットの作業か決めてください)')
  }
  return findSource(event, id)
}
