import type { H3Event } from 'h3'
import { parseRegistrationCode } from '#shared/utils/registration'

/**
 * 許可操作(preview/approve)の共通入力検証。
 * QRの値は `hinotike-registration:<uuid>` の形式のみ受け付ける。
 * items 照会用のQRコード(Sheets由来)は接頭辞が異なるためここでは拒否される。
 */
export async function requireApprovalNonce(event: H3Event): Promise<string> {
  const body = await readBody<{ code?: unknown }>(event)
  const nonce = parseRegistrationCode(body?.code)
  if (!nonce) {
    throw createError({ statusCode: 400, statusMessage: 'code_invalid' })
  }
  return nonce
}
