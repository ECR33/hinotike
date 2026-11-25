import { readBody } from 'h3'
import { ITEM_NAME_KEY, productOrderKeys } from '#shared/utils/items'
import { parseRegistrationCode } from '#shared/utils/registration'
import { SCAN_CODE_MAX_LENGTH } from '#shared/utils/scan'
import { datasetFromSource, resolveSource } from '../utils/dataset'

/**
 * QR コードの値で**シート**を照会する(1行 = code + payload)。登録済みユーザのみ。
 * 前提: Google 認証済み + users テーブルへの紐付け(判定は server/utils/authguard)。
 *
 * 対象シートは body の sourceId(未指定は有効な最初のデータセット)。画面(/result)は
 * 取り込み済みのデータセットの id を送る(端末ミラーの照会と同じシートを照会する)。
 * 商品欄の表示順(productOrder)はそのデータセットの includeColumns の並びから作る。
 * 利用者登録QR(hinotike-registration:)は照会対象ではないので 400 で拒否する(黙って not_found にしない)。
 */
export interface LookupResponse {
  found: boolean
  code: string
  row: { code: string; payload: Record<string, string> } | null
  productOrder: string[]
  sourceId: number
  sheetTitle: string
}

export default defineEventHandler(async (event): Promise<LookupResponse> => {
  await requireRegisteredUser(event)

  const body = await readBody<{ code?: unknown; sourceId?: unknown }>(event)
  const code = String(body?.code ?? '').trim()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'code is required' })
  }
  if (code.length > SCAN_CODE_MAX_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `code は ${SCAN_CODE_MAX_LENGTH} 文字まで` })
  }
  if (parseRegistrationCode(code)) {
    throw createError({ statusCode: 400, statusMessage: '利用者登録用のQRです(チケットコードをスキャンしてください)' })
  }

  const source = await resolveSource(event, body?.sourceId)
  const dataset = await datasetFromSource(event, source)
  const row = dataset.rows.find((r) => r.code === code) ?? null

  // 商品表示順(取り込み定義の includeColumns の並び → rename 適用後の個数キー)
  const productOrder = productOrderKeys(source.includeColumns, source.rename)

  return {
    found: row !== null,
    code,
    row,
    productOrder,
    sourceId: source.id ?? 0,
    sheetTitle: dataset.sheetTitle,
  }
})
