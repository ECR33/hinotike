import { readBody } from 'h3'
import { ITEM_NAME_KEY, ITEM_REMARK_KEY, REMARK_MAX_LENGTH } from '#shared/utils/items'
import { a1Cell, sourceColumnFor, type SyncSource } from '#shared/utils/sync'
import { readServiceAccountKey, updateCellValue } from '../utils/googleSheets'
import { datasetFromSource, requireSource } from '../utils/dataset'

/**
 * 照会結果画面の備考欄の編集。登録済みユーザのみ(requireRegisteredUser)。
 *
 * 書き込み先は**シートだけ**(シートが唯一の正。items テーブルへの payload 反映は廃止した)。
 * 端末内のミラー(IndexedDB)への反映は画面側が応答の remark を写す。
 * 備考のセル位置は code からその場で引く(ヘッダー行 = 1行目、1起点の行番号 = index+1)。
 * 空の備考はシート側も空にする(取り込み側の empty skip と同じ挙動 = ミラーからも消える)。
 * 備考カラムは payload キーの rename 逆引き(re-name 前名を書く)。
 */
export interface RemarkUpdateResponse {
  ok: true
  code: string
  /** 保存された値(trim 後。空なら空文字) */
  remark: string
  sheetTitle: string
  /** 書き込んだセル番地(A1) */
  range: string
  sourceId: number
}

export default defineEventHandler(async (event): Promise<RemarkUpdateResponse> => {
  await requireRegisteredUser(event)

  const body = await readBody<{ code?: unknown; remark?: unknown; sourceId?: unknown }>(event)
  const code = String(body?.code ?? '').trim()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'code is required' })
  }
  const remark = typeof body?.remark === 'string' ? body.remark.trim() : ''
  if (remark.length > REMARK_MAX_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `備考は ${REMARK_MAX_LENGTH} 文字まで` })
  }

  const source = await requireSource(event, body?.sourceId)
  const sa = await readServiceAccountKey()
  if (!sa) {
    throw createError({ statusCode: 400, statusMessage: 'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です(Worker の secret に設定)' })
  }

  // 行位置・ヘッダー・rename は datasetFromSource(シート索引の TTL キャッシュ)を使う = lookup と同じ根
  const dataset = await datasetFromSource(event, source)
  const index = dataset.index

  const sheetColumn = sourceColumnFor(ITEM_REMARK_KEY, source.rename)
  const colIdx = index.headers.indexOf(sheetColumn)
  if (colIdx === -1) {
    throw createError({
      statusCode: 400,
      statusMessage: `備考カラム "${sheetColumn}" がヘッダーにありません(${source.name})`,
    })
  }

  const rowNumber = index.rowIndex.get(code)
  if (rowNumber === undefined) {
    throw createError({ statusCode: 404, statusMessage: `code "${code}" がシートに見つかりません(${source.name})` })
  }

  try {
    await updateCellValue(source.spreadsheetId, index.title, sa, colIdx, rowNumber, remark)
  } catch (e) {
    console.error('[remark-update] sheets write:', e instanceof Error ? e.message : e)
    // Google が編集スコープの権限を持っていない(シート共有が編集者以上でない)ケースを案内に含める
    throw createError({
      statusCode: 502,
      statusMessage: 'シート書き込み失敗(サービスアカウントがそのシートを編集できるか確認してください)',
    })
  }

  return {
    ok: true,
    code,
    remark,
    sheetTitle: index.title,
    range: a1Cell(index.title, colIdx, rowNumber),
    sourceId: source.id ?? 0,
  }
})

/** 備考編集の画面側が氏名も欲しいときのヘルプ(lookup の row を再読せず payload から読む)。 */
export function nameOfPayload(payload: Record<string, string> | null | undefined): string | null {
  return typeof payload?.[ITEM_NAME_KEY] === 'string' ? payload[ITEM_NAME_KEY] : null
}

/** 型だけ使う SyncSource の import を維持する(deleteCells 的な拡張のための将来枠。現状は未使用)。 */
export type RemarkUpdateSource = SyncSource