/**
 * API のエラーの「理由」の機械可読コードと、画面が出すユーザ向け案内。
 *
 * HTTP の status line は printable ASCII しか運べない(h3 の `sanitizeStatusMessage` が
 * `[^\u0009\u0020-\u007E]` を落とす)。サーバが日本語の `statusMessage` を作ると、画面側は
 * ofetch が `statusText` から組み立てたメッセージを見るため、
 * `データセット "既定のシート" のスプレッドシート ID が未設定です(設定画面で入力)` が
 * `400 "" ID ()` のように**日本語だけ欠けた**文字列になる(実測: dev のシート読み取り API)。
 *
 * だから運ぶルールを分ける:
 * - `statusMessage` = **ASCII の理由コード**(`spreadsheet_not_configured` など)
 * - `message` = 日本語の案内(開発者向けの下情報込み)。JSON body に残る
 * - `data` = `{ reason, sourceId, sourceName, columns, detail }`(画面の文言決定用。body に残る)
 * Nitro/Nuxt は `/api/*` のエラー応答を常に JSON にするので `message`/`data` は届く
 * (`nitropack` の `isJsonRequest` は path が `/api/` で始まれば true)。
 *
 * 画面は `describeApiError` で「ユーザ向け文言」と「素のメッセージ」を分けて出す
 * (理由が未登録のコードでも、body の `message` が届いていればそれを文言として使う =
 * まだ理由コードを載せていない throw 位置でも日本語が復元される)。
 * Nuxt 依存の import は置かない(server / shared / CLI どちらでも読めるように)。
 */

/** API が 400/404/502 で返す理由の機械可読コード(HTTP status line に載る ASCII の token)。 */
export type ApiErrorReason =
  | 'dataset_missing'
  | 'dataset_not_found'
  | 'source_id_required'
  | 'spreadsheet_not_configured'
  | 'service_account_not_configured'
  | 'code_column_missing'
  | 'record_column_missing'
  | 'sheet_read_failed'
  | 'sheet_write_failed'

export const API_ERROR_REASONS: readonly ApiErrorReason[] = [
  'dataset_missing',
  'dataset_not_found',
  'source_id_required',
  'spreadsheet_not_configured',
  'service_account_not_configured',
  'code_column_missing',
  'record_column_missing',
  'sheet_read_failed',
  'sheet_write_failed',
]

export function isApiErrorReason(value: unknown): value is ApiErrorReason {
  return typeof value === 'string' && (API_ERROR_REASONS as readonly string[]).includes(value)
}

/** エラーの `data` に載る構造(画面の文言決定と「詳細」表示用)。 */
export interface ApiErrorPayload {
  reason: ApiErrorReason
  /** 作業対象のデータセットの DB id(未作成のドラフトは null) */
  sourceId?: number | null
  /** 案内に出すデータセットの表示名 */
  sourceName?: string | null
  /** ヘッダーに無いカラム名(code_column_missing / record_column_missing) */
  columns?: string[]
  /** 開発者向けの下情報(Google のレスポンス文など。画面の「詳細」に載せる) */
  detail?: string
}

/** 案内に出すデータセット名(無いとき null)。`''` は出さない。 */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

/** カラム名の列(無いとき null)。`[]` は出さない。 */
function cleanColumns(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const cols = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
  return cols.length ? cols : null
}

/** payload の生オブジェクト(サーバが載せた `data`)から ApiErrorPayload を作る。 */
function payloadFromObject(obj: Record<string, unknown> | null | undefined): ApiErrorPayload | null {
  if (!obj || typeof obj !== 'object') return null
  if (!isApiErrorReason(obj.reason)) return null
  const payload: ApiErrorPayload = { reason: obj.reason }
  if (typeof obj.sourceId === 'number' || obj.sourceId === null) payload.sourceId = obj.sourceId
  const name = cleanName(obj.sourceName)
  if (name) payload.sourceName = name
  const cols = cleanColumns(obj.columns)
  if (cols) payload.columns = cols
  if (typeof obj.detail === 'string' && obj.detail.trim()) payload.detail = obj.detail.trim()
  return payload
}

/**
 * ユーザ向けの案内(理由コードから決める)。画面の error / hint にそのまま載る。
 * 操作導線は「同期」(`/sync`)のデータセット管理と「記録の設定」(`/scan-settings`)に寄せる
 * (スプレッドシート ID・code カラム・列の作成はどちらもその画面でしか直せない)。
 */
export function userMessageOf(payload: ApiErrorPayload): string {
  // 名のあるデータセットは「データセット "x" の…」、名が無いときは接頭辞を削る(「データセット の…」を防ぐ)
  const prefix = payload.sourceName ? `データセット "${payload.sourceName}" の` : ''
  const cols = payload.columns?.length ? payload.columns.join(', ') : ''

  switch (payload.reason) {
    case 'dataset_missing':
      return 'データセットが未設定です。「同期」(/sync)でスプレッドシートを追加してください。'
    case 'dataset_not_found':
      return 'データセットが見つかりません(削除されたか未作成)。「同期」(/sync)で作り直してから選び直してください。'
    case 'source_id_required':
      return payload.sourceName
        ? `データセット "${payload.sourceName}" の指定がありません。「同期」(/sync)または画面のデータセット選択で、作業対象を選んでください。`
        : '作業対象のデータセットの指定がありません。「同期」(/sync)または画面のデータセット選択で選んでください。'
    case 'spreadsheet_not_configured':
      return `${prefix}スプレッドシート ID が未設定です。「同期」(/sync)でスプレッドシート ID を入力してください。`
    case 'service_account_not_configured':
      return 'サーバーに Google のサービスアカウント鍵がありません(Worker の secret GOOGLE_SERVICE_ACCOUNT_JSON に設定が必要です)。シートの読み取り・書き込みはできません。'
    case 'code_column_missing':
      return `code カラム "${cols}" がシートのヘッダーにありません。「同期」(/sync)の code カラムの設定を確認してください。`
    case 'record_column_missing':
      return `記録に使うカラム "${cols}" がシートのヘッダーにありません。「記録の設定」(/scan-settings)で列を追加できます。`
    case 'sheet_read_failed':
      return `${prefix}シートの読み取りに失敗しました。スプレッドシート ID と共有設定(サービスアカウントのアクセス権)を確認してください。`
    case 'sheet_write_failed':
      return `${prefix}シートへの書き込みに失敗しました。サービスアカウントがそのシートを編集できるか確認してください。`
    default:
      // 理由コードを増やしたときに文言を足し忘れたときでも generic の案内を出す
      return '失敗しました。時間をおいてもう一度お試しください。'
  }
}

/** エラー応答の `data`(payload そのもの / JSON body の `data`)から理由を取り出す。 */
function payloadFromData(data: unknown): ApiErrorPayload | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  // h3 の H3Error を直接見たとき(server 側で catch した場合): data が payload そのもの
  const direct = payloadFromObject(obj)
  if (direct) return direct
  // Nitro/Nuxt の JSON エラー応答 `{ statusCode, statusMessage, message, data }` を
  // ofetch が `error.data` に載せた形
  const inner = payloadFromObject(obj.data as Record<string, unknown>)
  if (inner) return inner
  // body の statusMessage が理由コードのとき(data が無い応答 = nitro 既定のエラー応答)
  if (isApiErrorReason(obj.statusMessage)) return { reason: obj.statusMessage }
  if (isApiErrorReason(obj.statusText)) return { reason: obj.statusText }
  return null
}

/** エラークラス(ofetch の FetchError / h3 の H3Error / 素の Error)から payload を読む。 */
export function apiErrorPayloadOf(e: unknown): ApiErrorPayload | null {
  if (!e || typeof e !== 'object') return null
  const err = e as { data?: unknown; statusMessage?: unknown; statusText?: unknown }
  const fromData = payloadFromData(err.data)
  if (fromData) return fromData
  if (isApiErrorReason(err.statusMessage)) return { reason: err.statusMessage }
  if (isApiErrorReason(err.statusText)) return { reason: err.statusText }
  return null
}

/** HTTP status(401/403 の判定用)。無いとき null。 */
export function apiErrorStatusOf(e: unknown): number | null {
  if (!e || typeof e !== 'object') return null
  const err = e as { status?: unknown; statusCode?: unknown }
  const raw = err.status ?? err.statusCode
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null
}

/** エラー応答 body の `message`(日本語の案内が欠損せずに届く側)。 */
function bodyMessageOf(e: unknown): string {
  if (!e || typeof e !== 'object') return ''
  const data = (e as { data?: unknown }).data
  if (data && typeof data === 'object') {
    const message = (data as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  // サーバ側で H3Error を直接 catch したとき(message が案内そのもの)
  const message = (e as { message?: unknown }).message
  return typeof message === 'string' ? message.trim() : ''
}

/** 画面に出す案内と、開発者向けの素のメッセージの2組。 */
export interface ApiErrorView {
  /** 画面に出すユーザ向け案内(理由コード → 文言。理由未知なら body の message をそのまま使う) */
  friendly: string
  /** 開発者向け: 下情報 + サーバの素のメッセージ + リクエスト行(欠損した status line を含む) */
  raw: string
}

/**
 * API の失敗を「ユーザ向け文言」と「素のメッセージ」に分ける。
 * 画面は `friendly` を error の本文に、`raw` を折りたたみの「詳細」に載せる。
 * 理由コードが未登録の失敗でも `body.message`(日本語のまま届く)を文言に使うので、
 * 理由コードをまだ載せていない throw 位置でも日本語の案内が出る。
 */
export function describeApiError(e: unknown): ApiErrorView {
  const payload = apiErrorPayloadOf(e)
  const bodyMessage = bodyMessageOf(e)
  const fetchMessage = e instanceof Error ? e.message : String(e)

  let friendly: string
  if (payload) {
    friendly = userMessageOf(payload)
  } else {
    const status = apiErrorStatusOf(e)
    if (status === 401) friendly = 'ログインが必要です。再ログインしてください。'
    else if (status === 403) friendly = 'この操作は users テーブルに紐付け済みのユーザのみ実行できます'
    else if (status !== null) {
      // API の失敗で理由コードが未登録のとき: サーバの案内(`message` は日本語のまま届く)をそのまま使う
      friendly = bodyMessage || '読み込みに失敗しました。時間をおいてもう一度お試しください。'
    } else {
      // API 以外の失敗(IDB の読み取り・ローカル照合など)。素の文言をユーザに出さない
      friendly = '失敗しました。時間をおいてもう一度お試しください。'
    }
  }

  // 「詳細」は1文字列(重複は除く)。日本語が欠けた status line もそのまま残すので
  // dev のコンソールで見た文字列と突き合わせできる。
  const parts: string[] = []
  if (payload?.detail) parts.push(payload.detail)
  if (bodyMessage && !parts.includes(bodyMessage)) parts.push(bodyMessage)
  if (fetchMessage && fetchMessage !== friendly && !parts.includes(fetchMessage)) parts.push(fetchMessage)
  if (!parts.length) parts.push(friendly)

  return { friendly, raw: parts.join(' / ') }
}

