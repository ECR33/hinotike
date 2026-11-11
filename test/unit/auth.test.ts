import { describe, expect, it } from 'vitest'
import {
  AUTH_ERROR_CODES,
  authErrorMessage,
  isSafeLocalPath,
  publicOrigin,
} from '../../shared/utils/auth'

describe('isSafeLocalPath(リダイレクト先検証)', () => {
  it('自アプリ内の相対パスは許可', () => {
    expect(isSafeLocalPath('/scan')).toBe(true)
    expect(isSafeLocalPath('/result?code=abc')).toBe(true)
    expect(isSafeLocalPath('/api/auth-callback')).toBe(true)
  })

  it('プロトコル相対 URL(外部ドメイン)は拒否 — オープンリダイレクト防止', () => {
    expect(isSafeLocalPath('//evil.example.com')).toBe(false)
    expect(isSafeLocalPath('/\\evil.example.com')).toBe(false)
  })

  it('絶対 URL と不正値は拒否', () => {
    expect(isSafeLocalPath('https://evil.example.com')).toBe(false)
    expect(isSafeLocalPath('http://evil.example.com')).toBe(false)
    expect(isSafeLocalPath('')).toBe(false)
    expect(isSafeLocalPath(undefined)).toBe(false)
    expect(isSafeLocalPath(null)).toBe(false)
    expect(isSafeLocalPath(123)).toBe(false)
  })
})

describe('authErrorMessage(固定エラーコードのみ露出)', () => {
  it('既知のコードは確定した日本語メッセージ', () => {
    for (const code of AUTH_ERROR_CODES) {
      const msg = authErrorMessage(code)
      expect(msg).toBeTruthy()
      expect(msg).not.toBe(code) // コード文字列そのものを出さない
    }
  })

  it('未知のコード(内部メッセージ等)は汎用文言にフォールバック', () => {
    expect(authErrorMessage('unexpected internal detail')).toBe('認証に失敗しました')
    expect(authErrorMessage('')).toBe('認証に失敗しました')
  })

  it('AUTH_ERROR_CODES は固定列挙', () => {
    expect([...AUTH_ERROR_CODES]).toEqual([
      'access_denied',
      'no_code',
      'exchange_failed',
      'not_configured',
      'oauth_start_failed',
    ])
  })
})

describe('publicOrigin(Cloudflare tunnel 経由の公開 origin)', () => {
  it('appUrl が最優先', () => {
    expect(publicOrigin({
      appUrl: 'https://desktop1.sakurastyle.jp',
      forwardedHost: 'other.example.com',
      forwardedProto: 'http',
      requestOrigin: 'http://127.0.0.1:3000',
    })).toBe('https://desktop1.sakurastyle.jp')
  })

  it('appUrl 未設定では x-forwarded-host/proto を使う(tunnel 経由だとリクエスト origin は localhost)', () => {
    expect(publicOrigin({
      forwardedHost: 'desktop1.sakurastyle.jp',
      forwardedProto: 'https',
      requestOrigin: 'http://127.0.0.1:3000',
    })).toBe('https://desktop1.sakurastyle.jp')
  })

  it('proto 未設定なら https、forwarded-host が複数なら最初のホスト', () => {
    expect(publicOrigin({ forwardedHost: 'desktop1.sakurastyle.jp, cache.example.com' }))
      .toBe('https://desktop1.sakurastyle.jp')
  })

  it('どれもなければリクエスト origin にフォールバック', () => {
    expect(publicOrigin({ requestOrigin: 'http://localhost:3000' })).toBe('http://localhost:3000')
    expect(publicOrigin({})).toBe('')
  })
})
