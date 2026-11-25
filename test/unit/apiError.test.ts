/**
 * API のエラーの案内(shared/utils/apiError.ts)の単体テスト。
 *
 * 実測のバグ(レコード一覧の初期状態)が対象: 日本語の `statusMessage` は h3 の
 * `sanitizeStatusMessage`(`[^\u0009\u0020-\u007E]` を除去)で HTTP status line から落ち、
 * ofetch は `statusText` をメッセージに使うので画面は `400 "" ID ()` を見ていた。
 * サーバは理由コードを `statusMessage`、案内を `message`/`data` に載せ、画面は
 * `describeApiError` で「ユーザ向け文言」と「素のメッセージ」に分ける。
 */
import { describe, expect, it } from 'vitest'
import {
  API_ERROR_REASONS,
  apiErrorPayloadOf,
  apiErrorStatusOf,
  describeApiError,
  isApiErrorReason,
  userMessageOf,
  type ApiErrorPayload,
} from '../../shared/utils/apiError'

/** ofetch の FetchError の形(statusText / statusMessage は status line 経由で欠損している)。 */
function fetchErrorLike(init: {
  message: string
  status?: number
  statusText?: string
  data?: unknown
}): Error & { status?: number; statusCode?: number; statusText?: string; statusMessage?: string; data?: unknown } {
  const err = new Error(init.message) as Error & {
    status?: number
    statusCode?: number
    statusText?: string
    statusMessage?: string
    data?: unknown
  }
  err.name = 'FetchError'
  if (init.status !== undefined) {
    err.status = init.status
    err.statusCode = init.status
  }
  err.statusText = init.statusText
  // ofetch は statusText を statusMessage の別名として載せる(shared/ofetch の ["statusMessage","statusText"])
  err.statusMessage = init.statusText
  err.data = init.data
  return err
}

/** Nitro/Nuxt の JSON エラー応答で status line がどう欠けるか(h3 の sanitizer と同じ規則)。 */
const sanitize = (text: string): string => text.replace(/[^\u0009\u0020-\u007E]/g, '')

describe('isApiErrorReason / API_ERROR_REASONS', () => {
  it('理由コードは ASCII の token だけ(HTTP status line に載せる前提)', () => {
    for (const reason of API_ERROR_REASONS) {
      expect(reason).toMatch(/^[A-Za-z0-9_]+$/)
      expect(isApiErrorReason(reason)).toBe(true)
    }
    expect(isApiErrorReason('データセットが未設定です')).toBe(false)
    expect(isApiErrorReason('column_missing')).toBe(false)
    expect(isApiErrorReason(null)).toBe(false)
  })
})

describe('describeApiError(スプレッドシート未設定)', () => {
  const serverMessage = 'データセット "既定のシート" のスプレッドシート ID が未設定です(/sync の「データの設定」で入力)'
  const payload: ApiErrorPayload = { reason: 'spreadsheet_not_configured', sourceId: 1, sourceName: '既定のシート' }
  const err = fetchErrorLike({
    // 実測の欠損文言(日本語だけが落ちる)
    message: '[GET] "/api/items-list?limit=25&sourceId=1": 400 ' + sanitize(serverMessage),
    status: 400,
    statusText: sanitize(serverMessage),
    data: { statusCode: 400, statusMessage: sanitize(serverMessage), message: serverMessage, data: payload },
  })

  it('理由コードからユーザ向け文言を作り、素のメッセージも残す', () => {
    const view = describeApiError(err)
    expect(view.friendly).toBe(
      'データセット "既定のシート" のスプレッドシート ID が未設定です。「同期」(/sync)でスプレッドシート ID を入力してください。',
    )
    expect(view.raw).toContain(serverMessage) // 欠損していないサーバの案内
    expect(view.raw).toContain('/api/items-list?limit=25&sourceId=1') // dev のコンソールと突き合わせられる
  })

  it('データセット名が無いとき名を省略する', () => {
    const view = describeApiError(
      fetchErrorLike({
        message: '[GET] "/api/items-list": 400 dataset_missing',
        status: 400,
        statusText: 'dataset_missing',
        data: { statusCode: 400, statusMessage: 'dataset_missing', message: 'データセットが未設定です', data: { reason: 'dataset_missing' } },
      }),
    )
    expect(view.friendly).toBe('データセットが未設定です。「同期」(/sync)でスプレッドシートを追加してください。')
  })

  it('body に data が無い応答でも statusMessage の理由コードから復元する(nitro 既定の応答)', () => {
    const view = describeApiError(
      fetchErrorLike({
        message: '[GET] "/api/items-list": 400 spreadsheet_not_configured',
        status: 400,
        statusText: 'spreadsheet_not_configured',
      }),
    )
    expect(view.friendly).toContain('スプレッドシート ID が未設定です')
    expect(view.friendly).toContain('/sync')
  })
})
describe('describeApiError(理由コードが未登録の API の失敗)', () => {
  it('body の message(日本語のまま届く側)を文言に使う', () => {
    const message = '備考カラム "備考" がヘッダーにありません(既定のシート)'
    const view = describeApiError(
      fetchErrorLike({
        message: '[POST] "/api/remark-update": 400 ' + sanitize(message),
        status: 400,
        statusText: sanitize(message),
        data: { statusCode: 400, statusMessage: sanitize(message), message },
      }),
    )
    expect(view.friendly).toBe(message)
    expect(view.raw).toContain(message)
  })

  it('401 はログイン、403 は権限の案内にする', () => {
    expect(
      describeApiError(fetchErrorLike({ message: '[GET] "/api/items-list": 401 Not authenticated', status: 401 })).friendly,
    ).toContain('ログインが必要です')
    expect(
      describeApiError(fetchErrorLike({ message: '[GET] "/api/items-list": 403 Not registered', status: 403 })).friendly,
    ).toContain('users テーブルに紐付け済みのユーザのみ')
  })

  it('API 以外の失敗(素の Error)は素の文言をユーザ向けに出さない', () => {
    const view = describeApiError(new Error('offline mirror read failed'))
    expect(view.friendly).toBe('失敗しました。時間をおいてもう一度お試しください。')
    expect(view.raw).toBe('offline mirror read failed')
  })
})

describe('describeApiError(カラム欠けとシート読み取り失敗)', () => {
  it('code カラム欠けはカラム名を案内に載せ、ヘッダー一覧は詳細に載せる', () => {
    const view = describeApiError(
      fetchErrorLike({
        message: '[GET] "/api/items-list": 400 code カラム がヘッダーにありません',
        status: 400,
        statusText: 'code_column_missing',
        data: {
          statusCode: 400,
          statusMessage: 'code_column_missing',
          message: 'code カラム "ID" がヘッダーにありません(既定のシート)',
          data: { reason: 'code_column_missing', sourceId: 1, sourceName: '既定のシート', columns: ['ID'], detail: 'ヘッダー: 氏名, 学年' },
        },
      }),
    )
    expect(view.friendly).toBe('code カラム "ID" がシートのヘッダーにありません。「同期」(/sync)の code カラムの設定を確認してください。')
    expect(view.raw).toContain('ヘッダー: 氏名, 学年')
  })

  it('記録カラム欠けは記録の設定の導線を添える', () => {
    expect(userMessageOf({ reason: 'record_column_missing', columns: ['配布済', '配布日時'] })).toBe(
      '記録に使うカラム "配布済, 配布日時" がシートのヘッダーにありません。「記録の設定」(/scan-settings)で列を追加できます。',
    )
  })

  it('シート読み取り失敗は ID と共有設定の案内 + Google の下情報を詳細に載せる', () => {
    const view = describeApiError(
      fetchErrorLike({
        message: '[POST] "/api/lookup": 502 シート読み取り失敗',
        status: 502,
        statusText: 'sheet_read_failed',
        data: {
          statusCode: 502,
          statusMessage: 'sheet_read_failed',
          message: 'シート読み取り失敗(既定のシート)',
          data: { reason: 'sheet_read_failed', sourceName: '既定のシート', detail: 'シート値の取得失敗 (403): Permission denied' },
        },
      }),
    )
    expect(view.friendly).toContain('読み取りに失敗しました')
    expect(view.friendly).toContain('共有設定')
    expect(view.raw).toContain('Permission denied')
  })
})

describe('apiErrorPayloadOf / apiErrorStatusOf', () => {
  it('h3 の H3Error を直接見た形(data が payload そのもの)も読める', () => {
    const h3Like = {
      message: 'データセット "x" のスプレッドシート ID が未設定です',
      statusCode: 400,
      statusMessage: 'spreadsheet_not_configured',
      data: { reason: 'spreadsheet_not_configured', sourceName: 'x' },
    }
    expect(apiErrorPayloadOf(h3Like)?.reason).toBe('spreadsheet_not_configured')
    expect(apiErrorPayloadOf(h3Like)?.sourceName).toBe('x')
    expect(apiErrorStatusOf(h3Like)).toBe(400)
  })

  it('payload の不正値(空の columns・空の sourceName・非数値の sourceId)は落とす', () => {
    expect(apiErrorPayloadOf({ data: { reason: 'code_column_missing', columns: ['', '  '] } })).toEqual({ reason: 'code_column_missing' })
    expect(apiErrorPayloadOf({ data: { reason: 'spreadsheet_not_configured', sourceName: '  ', sourceId: 'x' } })).toEqual({
      reason: 'spreadsheet_not_configured',
    })
    expect(apiErrorPayloadOf({ data: { reason: 'not_a_reason' } })).toBe(null)
    expect(apiErrorPayloadOf(null)).toBe(null)
    expect(apiErrorStatusOf('nope')).toBe(null)
  })
})

