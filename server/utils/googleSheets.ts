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

import { a1Cell, sheetTitleFor } from '#shared/utils/sync'

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
// セルの書き込み(values.update)に必要な編集スコープ(読み取りスコープでは 403 になる)
const SHEETS_SCOPE_EDIT = 'https://www.googleapis.com/auth/spreadsheets'
// Sheets API の host は sheets.googleapis.com(www.googleapis.com/v4 は 404 を返す)
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'

export interface ServiceAccountKey {
  client_email: string
  private_key: string
}

/**
 * 環境変数の候補を **Workers の env binding(`globalThis.__env__`) → process.env** の順で並べる。
 *
 * 順を逆にした理由: ローカル dev(node)では `.env` / `.env.development` が process.env に同じ名前の
 * 「パス文字列」を写す(`GOOGLE_SERVICE_ACCOUNT_JSON=./scripts/service-account.json`)。
 * process.env を先に読むと実鍵 JSON(Workers の secret・`.dev.vars` → `__env__`)を読む前に
 * そのパスを JSON.parse して失敗し「鍵なし」→ 400 になっていた(dev でシート操作が全部落ちる)。
 * 両方あるときは「鍵として読めるほう」を使う(`readServiceAccountKey` が候補を順に検証する)。
 */
export function envCandidates(name: string): string[] {
  const out: string[] = []
  for (const v of [
    (globalThis as { __env__?: Record<string, string> }).__env__?.[name],
    (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[name],
  ]) {
    if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v)
  }
  return out
}

/** 最初の候補を返す(単独の env 値を読む用。鍵の解決は `readServiceAccountKey` が候補を順に検証する)。 */
export function envValue(name: string): string | undefined {
  return envCandidates(name)[0]
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

/** 鍵 JSON の文字列を検証して返す。不正(またはパス文字列)なら null。 */
export function parseServiceAccountJson(raw: string): ServiceAccountKey | null {
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

/**
 * 鍵ファイル(node の fs から)読む。Workers にはファイルシステムが無いので失敗すれば null。
 * 相対パスはプロセスの cwd(リポジトリルートで起動する dev / CLI)基準に解決する。
 */
async function readKeyFile(pathSpec: string): Promise<ServiceAccountKey | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const raw = await readFile(resolve(process.cwd(), pathSpec), 'utf8')
    return parseServiceAccountJson(raw)
  } catch {
    return null
  }
}

/**
 * サービスアカウント鍵の解決(2系統)。
 * 1) `GOOGLE_SERVICE_ACCOUNT_JSON` = 鍵 JSON の**文字列**(本番は Worker の secret、dev は `.dev.vars`)。
 *    候補を順に「鍵として読めるか」見て採用する。process.env にパス文字列が載っていても
 *    鍵と誤読しない(`npm run dev` は `.env.development` の値を process.env に写す)。
 * 2) `GOOGLE_SERVICE_ACCOUNT_JSON_PATH` = 鍵ファイルの**パス**(ローカル dev・CLI 用)。
 *    1 が無いときに fs で読む。本番の Worker はどちらも持たないので null → API が 400 で案内する。
 */
export async function readServiceAccountKey(): Promise<ServiceAccountKey | null> {
  for (const raw of envCandidates('GOOGLE_SERVICE_ACCOUNT_JSON')) {
    const key = parseServiceAccountJson(raw)
    if (key) return key
  }
  const pathCandidates = [
    ...envCandidates('GOOGLE_SERVICE_ACCOUNT_JSON_PATH'),
    // 旧 env(.env の GOOGLE_SERVICE_ACCOUNT_JSON にパスを置いていた形)追随。JSON でない値だけ候補にする。
    ...envCandidates('GOOGLE_SERVICE_ACCOUNT_JSON').filter((v) => !v.trim().startsWith('{')),
  ]
  for (const p of pathCandidates) {
    const key = await readKeyFile(p)
    if (key) return key
  }
  return null
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

/**
 * RS256 署名。Web Crypto を優先、node:crypto にフォールバック。
 * `hash` を algorithm に載せる必要がある(workerd は `RSASSA-PKCS1-v1_5` の importKey で
 * hash 必須: 無いと `Missing field "hash" in "algorithm"` を投げて pkcs8 import が失敗する — 実測)。
 * hash を載せて Worker 上で Web Crypto が直接動くようにし、node:crypto は fallback のままとする。
 */
export async function signRs256(data: string, pem: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const der = pemToDer(pem)
      // TS の DOM lib は BufferSource(ArrayBuffer 限定)を要求するので Uint8Array を変換して渡す
      const key = await subtle.importKey(
        'pkcs8',
        der as unknown as BufferSource,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', namedCurve: 'P-256' },
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

export async function signedJwt(sa: ServiceAccountKey, nowMs = Date.now(), scope = SHEETS_SCOPE): Promise<string> {
  const header = base64UrlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64UrlText(JSON.stringify(jwtClaims(sa, nowMs, scope)))
  const signature = await signRs256(`${header}.${payload}`, sa.private_key)
  return `${header}.${payload}.${signature}`
}

/** jwt-bearer grant で access token を取得。失敗時は status と message を持つ Error。 */
export async function sheetsAccessToken(sa: ServiceAccountKey, scope = SHEETS_SCOPE): Promise<string> {
  const assertion = await signedJwt(sa, Date.now(), scope)
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

/** ワークシート名の numeric sheetId + 列数(列の追加は「現在の列数から明示的に拡張」するため)。 */
export async function sheetColumnsInfo(
  spreadsheetId: string,
  token: string,
  title: string,
): Promise<{ sheetId: number; columnCount: number }> {
  const res = await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title,gridProperties(columnCount)))`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`シートの列数取得失敗 (${res.status}): ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as {
    sheets?: { properties?: { sheetId?: number; title?: string; gridProperties?: { columnCount?: number } } }[]
  }
  const hit = (json.sheets ?? []).find((s) => s.properties?.title === title)
  if (!hit || typeof hit.properties?.sheetId !== 'number') throw new Error(`ワークシート "${title}" の sheetId が取得できません`)
  return { sheetId: hit.properties.sheetId, columnCount: hit.properties.gridProperties?.columnCount ?? 0 }
}

/**
 * ワークシートの末尾に列を `count` 本追加する(`spreadsheets:batchUpdate` の `appendDimension`)。
 * values.update の範囲外書き込みでグリッドが自動拡張される挙動には頼らない
 * (列数を読んでから明示的に拡張するので、書き込み位置の計算が確定する)。
 * ヘッダー名は呼び出し側が `updateCells` で書く(この関数は構造だけ変える)。
 *
 * 注意: spreadsheet 単位の batchUpdate で列を増やすリクエストは `appendDimension`
 * (`{ sheetId, dimension, length }`)。`addDimensionRange` はこの endpoint では存在しないので
 * 400 INVALID_ARGUMENT(Unknown name "addDimensionRange")になる。
 */
export async function appendColumns(
  spreadsheetId: string,
  sa: ServiceAccountKey,
  title: string,
  count: number,
): Promise<void> {
  if (count <= 0) return
  const token = await sheetsAccessToken(sa, SHEETS_SCOPE_EDIT)
  const { sheetId } = await sheetColumnsInfo(spreadsheetId, token, title)
  const res = await fetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          appendDimension: {
            sheetId,
            dimension: 'COLUMNS',
            length: count,
          },
        },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`列の追加失敗 (${res.status}): ${body.slice(0, 200)}`)
  }
}

/** 複数セルの一括書き込み(values:batchUpdate / RAW)。1リクエストの range 数上限(Google 側は 100)。 */
export const SHEETS_BATCH_MAX = 100

export interface CellWrite {
  range: string
  value: string
}

/**
 * 複数のセルをまとめて書き込む(values:batchUpdate / RAW)。
 * 連続スキャンの flush は「フラグ列 + 日時列 × N件」を1リクエストにまとめるためこれを使う。
 * 編集スコープの token を都度取得する(読み取り側は readonly のまま)。
 */
export async function updateCells(
  spreadsheetId: string,
  sa: ServiceAccountKey,
  writes: CellWrite[],
): Promise<void> {
  if (writes.length === 0) return
  const token = await sheetsAccessToken(sa, SHEETS_SCOPE_EDIT)
  const res = await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate?valueInputOption=RAW`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: writes.map((w) => ({ range: w.range, values: [[w.value]] })) }),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`セルの一括書き込み失敗 (${res.status}): ${body.slice(0, 200)}`)
  }
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

/**
 * 対象シートの 1 セルを書き込む(values.update / RAW)。
 * 編集スコープの token を都度取得する(読み取り側は readonly のまま)。
 * rowNumber は 1起点(a1Cell と同じ基準)。value に空文字を渡すとセルが空になる。
 */
export async function updateCellValue(
  spreadsheetId: string,
  title: string,
  sa: ServiceAccountKey,
  colIndex: number,
  rowNumber: number,
  value: string,
): Promise<void> {
  const token = await sheetsAccessToken(sa, SHEETS_SCOPE_EDIT)
  const range = a1Cell(title, colIndex, rowNumber)
  const res = await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values: [[value]] }),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`セルの書き込み失敗 (${res.status}): ${body.slice(0, 200)}`)
  }
}
