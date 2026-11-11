import { describe, expect, it } from 'vitest'
import {
  parseRegistrationCode,
  approvalStatusMessage,
  APPROVAL_STATUS_MESSAGES,
  REGISTRATION_QR_PREFIX,
} from '../../shared/utils/registration'

describe('parseRegistrationCode(登録QRの値検証)', () => {
  const uuid = '0b8d4f1a-2c3e-4d5f-6a7b-8c9d0e1f2a3b'

  it('接頭辞 + UUID nonce を受理', () => {
    expect(parseRegistrationCode(`${REGISTRATION_QR_PREFIX}${uuid}`)).toBe(uuid)
  })

  it('items照会用のQRコード(Sheets由来)は拒否 — namespace衝突防止', () => {
    expect(parseRegistrationCode('item-code-123')).toBe(null)
    expect(parseRegistrationCode('')).toBe(null)
  })

  it('接頭辞だけ・nonceがUUIDでない値は拒否', () => {
    expect(parseRegistrationCode(REGISTRATION_QR_PREFIX)).toBe(null)
    expect(parseRegistrationCode(`${REGISTRATION_QR_PREFIX}not-a-uuid`)).toBe(null)
    expect(parseRegistrationCode(`${REGISTRATION_QR_PREFIX}${uuid}tail`)).toBe(null)
  })

  it('文字列以外は拒否', () => {
    expect(parseRegistrationCode(null)).toBe(null)
    expect(parseRegistrationCode(undefined)).toBe(null)
    expect(parseRegistrationCode(42)).toBe(null)
  })
})

describe('approvalStatusMessage(固定文言)', () => {
  it('既知のstatusは文言を出す(内部メッセージを露出しない)', () => {
    for (const code of Object.keys(APPROVAL_STATUS_MESSAGES)) {
      expect(approvalStatusMessage(code)).toBe(APPROVAL_STATUS_MESSAGES[code])
    }
  })

  it('未知のstatusは汎用文言にフォールバック', () => {
    expect(approvalStatusMessage('weird_internal_detail')).toBe('処理できませんでした')
  })
})
