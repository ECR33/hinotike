/**
 * QRによる利用者許可フローの共有ユーティリティ。
 * QRの中身は `hinotike-registration:<uuid nonce>` のみ。依頼者の uid や email を直接載せない
 * (撮影・保存したQRを後からリプレイしても DB の有効期限/消費済み判定で使えない)。
 * 接頭辞は items のQRコード(Sheets由来のコード)と衝突しないための namespace。
 */
export const REGISTRATION_QR_PREFIX = 'hinotike-registration:'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** QRの値から nonce を抽出。登録用QRでなければ null(スキャン画面は item照会に進まない)。 */
export function parseRegistrationCode(code: unknown): string | null {
  if (typeof code !== 'string') return null
  if (!code.startsWith(REGISTRATION_QR_PREFIX)) return null
  const nonce = code.slice(REGISTRATION_QR_PREFIX.length)
  return UUID_RE.test(nonce) ? nonce : null
}

/** RPC(preview/approve)が返す status → 画面に出す固定文言。内部情報は露出しない。 */
export const APPROVAL_STATUS_MESSAGES: Record<string, string> = {
  forbidden: 'この操作には許可済みの利用者が必要です',
  not_found: 'このQRは有効な依頼ではありません(期限切れで削除されたか、存在しません)',
  expired: 'QRの有効期限が切れました。依頼者側の画面でQR再生成してください',
  consumed: 'このQRはすでに使用済みです',
  already_registered: 'この利用者はすでに登録済みです',
  email_unverified: '依頼者のemailが未検証のため許可できません',
  domain_not_allowed: '依頼者のemailドメインが許可リストにありません',
  email_taken: 'このemailは別の利用者にすでに紐付けられています',
  ok: '許可しました',
}

export function approvalStatusMessage(status: string): string {
  return APPROVAL_STATUS_MESSAGES[status] ?? '処理できませんでした'
}
