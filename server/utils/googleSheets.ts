/**
 * Google Spreadsheet を Workers 上で読むための最小クライアント。
 *
 * googleapis は使わない(Workers で Node 依存が重い/相性の問題があるため):
 * - サービスアカウント鍵(secret `GOOGLE_SERVICE_ACCOUNT_JSON` の JSON 文字列)から
 *   JWT(RS256)を自前署名して oauth2 の jwt-bearer grant で access token を取得
 * - Sheets REST API(v4)を fetch で叩く
 *
 * 署名は Web Crypto(pkcs8 import)を優先し、失敗したら node:crypto にフォールバックする
 * (ローカル dev の Node と Workers の workerd で使える側が異なるため)。
 */

import { sheetTitleFor } from '#shared/utils/sync'

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
// Sheets API の host は sheets.googleapis.com(www.googleapis.com/v4 は 404 を返す)
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'

export interface ServiceAccountKey {
  client_email: string
  private_key: string
}

/** 環境変数を process.env / Workers の env バinding(globalThis.__env__)の両方から拾う。 */
export function envValue(name: string): string | undefined {
  const fromProcess = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[name]
  const fromWorkerEnv = (globalThis as { __env__?: Record<string, string> }).__env__?.[name]
  for (const v of [fromProcess, fromWorkerEnv]) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

/**
 * 鍵の PEM を正規化する。
 * Workers の text var や GitHub Actions の env では、改行が実改行ではなく
 * バックslash + "n" の2文字として渡ることがある(PEM 中間が 1行になる)。
 * その形を検知したら実改行に戻す(Web Crypto の pkcs8 import と node:crypto の双方が実改行前提)。
 */
export function normalizePrivateKey(pem: string): string {
  const cr = pem.replace(/\r/g, '')
  if (!cr.includes('\n') && cr.includes('\\n')) return cr.replace(/\\n/g, '\n')
  return cr
}

/** 鍵 JSON を検証して返す。未設定/不正なら null(API 側で 400 にする)。 */
export function readServiceAccountKey(): ServiceAccountKey | null {
  const raw = envValue('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const obj = parsed as Partial<ServiceAccountKey>
  if (!obj || typeof obj.client_email !== 'string' || !obj.client_email.includes('@')) return null
  if (typeof obj.private_key !== 'string' || !obj.private_key.includes('PRIVATE KEY')) return null
  return { client_email: obj.client_email, private_key: normalizePrivateKey(obj.private_key) }
}

/** base64url(パディングなし、+/ → -_) */
export function base64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url 文字列(ASCII) */
export function base64UrlText(text: string): string {
  return base64Url(new TextEncoder().encode(text))
}

/** PEM(-----BEGIN PRIVATE KEY----- …)を PKCS#8 DER に。 */
export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** jwt-bearer grant の claims。iat/exp は秒。 */
export function jwtClaims(sa: ServiceAccountKey, nowMs: number, scope = SHEETS_SCOPE) {
  const iat = Math.floor(nowMs / 1000)
  return {
    iss: sa.client_email,
    scope,
    aud: OAUTH_TOKEN_URL,
    exp: iat + 3600,
    iat,
  }
}

/** RS256 署名。Web Crypto を優先、node:crypto にフォールバック。 */
export async function signRs256(data: string, pem: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const der = pemToDer(pem)
      // TS の DOM lib は BufferSource(ArrayBuffer 限定)を要求するので Uint8Array を変換して渡す
      const key = await subtle.importKey(
        'pkcs8',
        der as unknown as BufferSource,
        { name: 'RSASSA-PKCS1-v1_5', namedCurve: 'P-256' },
        false,
        ['sign'],
      )
      const sig = await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data))
      return base64Url(new Uint8Array(sig))
    } catch {
      // workerd の pkcs8 import が失敗する環境では node:crypto 側へ
    }
  }
  const { createSign } = await import('node:crypto')
  const signer = createSign('sha256')
  signer.update(data)
  signer.end()
  return base64Url(new Uint8Array(signer.sign(pem)))
}

export async function signedJwt(sa: ServiceAccountKey, nowMs = Date.now()): Promise<string> {
  const header = base64UrlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64UrlText(JSON.stringify(jwtClaims(sa, nowMs)))
  const signature = await signRs256(`${header}.${payload}`, sa.private_key)
  return `${header}.${payload}.${signature}`
}

/** jwt-bearer grant で access token を取得。失敗時は status と message を持つ Error。 */
export async function sheetsAccessToken(sa: ServiceAccountKey): Promise<string> {
  const assertion = await signedJwt(sa)
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const json = (await res.json().catch(() => null)) as { access_token?: string; error?: string; error_description?: string } | null
  if (!res.ok || !json?.access_token) {
    throw new Error(`Google token 取得失敗 (${res.status}): ${json?.error ?? 'unknown'}${json?.error_description ? ` — ${json.error_description}` : ''}`)
  }
  return json.access_token
}

/** ワークシート名の一覧(同期設定の worksheet 選択・フォールバック用)。 */
export async function sheetTitles(spreadsheetId: string, token: string): Promise<string[]> {
  const res = await fetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(title))`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`シート一覧の取得失敗 (${res.status}): ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { sheets?: { properties?: { title?: string } }[] }
  return (json.sheets ?? []).map((s) => s.properties?.title).filter((t): t is string => Boolean(t))
}

/**
 * 対象ワークシートの全値(1行目=ヘッダー)。
 * タイトルが設定と一致しない場合は最初のシートにフォールバックする(sheetTitleFor が共通根)。
 */
export async function fetchSpreadsheetValues(
  spreadsheetId: string,
  worksheet: string | null,
  sa: ServiceAccountKey,
): Promise<{ title: string; titles: string[]; values: unknown[][] }> {
  const token = await sheetsAccessToken(sa)
  const titles = await sheetTitles(spreadsheetId, token)
  const title = sheetTitleFor(titles, worksheet)
  if (!title) throw new Error('ワークシートが見つかりません')

  const res = await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(title)}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`シート値の取得失敗 (${res.status}): ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { values?: unknown[][] }
  return { title, titles, values: json.values ?? [] }
}
