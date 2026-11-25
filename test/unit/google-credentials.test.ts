import { afterEach, describe, expect, it } from 'vitest'
import {
  envCandidates,
  normalizePrivateKey,
  parseServiceAccountJson,
  readServiceAccountKey,
} from '../../server/utils/googleSheets'

/**
 * Google クレデンシャルの読み取り(server/utils/googleSheets.ts)。
 *
 * 実測のバグが対象: ローカル dev では `.env.development` が `GOOGLE_SERVICE_ACCOUNT_JSON` に
 * **パス文字列**(`./scripts/service-account.json`)を process.env に写す。
 * process.env を先に読むと実鍵 JSON(`.dev.vars` → `globalThis.__env__`)を読む前に
 * そのパスを JSON.parse して失敗し「鍵なし」→ シートの読み書きが全部 400 になっていた。
 * 今は「鍵として読める候補を順に探す」+ `GOOGLE_SERVICE_ACCOUNT_JSON_PATH`(パス指定)の fs 読み。
 */
const KEY = {
  client_email: 'probe@example.iam.gserviceaccount.com',
  // 検証用の擬鍵(本鍵ではない)。PEM の形だけ合わせる。
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\n',
}

const savedProcessEnv = { ...process.env }
const savedWorkerEnv = (globalThis as { __env__?: Record<string, string> }).__env__

afterEach(() => {
  for (const k of ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SERVICE_ACCOUNT_JSON_PATH']) delete process.env[k]
  Object.assign(process.env, savedProcessEnv)
  ;(globalThis as { __env__?: Record<string, string> }).__env__ = savedWorkerEnv
})

function setWorkerEnv(env: Record<string, string>) {
  ;(globalThis as { __env__?: Record<string, string> }).__env__ = env
}

describe('readServiceAccountKey(鍵の解決)', () => {
  it('process.env にパス文字列が載っていても Workers env の鍵 JSON を選ぶ', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = './scripts/service-account.json'
    setWorkerEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY) })
    const key = await readServiceAccountKey()
    expect(key?.client_email).toBe(KEY.client_email)
  })

  it('鍵 JSON だけのときも読める(本番の Worker の secret)', async () => {
    setWorkerEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY) })
    expect((await readServiceAccountKey())?.private_key).toContain('PRIVATE KEY')
  })

  it('GOOGLE_SERVICE_ACCOUNT_JSON_PATH はファイルから読む(dev・CLI の経路)', async () => {
    // リポジトリの実鍵ファイルを使う(内容の検証はしない: client_email が読めることだけ見る)
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH = './scripts/service-account.json'
    const key = await readServiceAccountKey()
    expect(key?.client_email).toMatch(/@.*gserviceaccount\.com$/)
  })

  it('env に何も無いときは null(API 側で 400 の案内になる)', async () => {
    expect(await readServiceAccountKey()).toBe(null)
  })

  it('不正な JSON・鍵の形は候補を捨てて次の候補に進む', async () => {
    setWorkerEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"no-at-sign"}' })
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(KEY)
    expect((await readServiceAccountKey())?.client_email).toBe(KEY.client_email)
  })
})

describe('parseServiceAccountJson / normalizePrivateKey', () => {
  it('パス文字列・壊れた JSON は null', () => {
    expect(parseServiceAccountJson('./scripts/service-account.json')).toBe(null)
    expect(parseServiceAccountJson('{')).toBe(null)
    expect(parseServiceAccountJson(JSON.stringify({ client_email: 'a@b', private_key: 'no key' }))).toBe(null)
  })

  it('\\n が実改行で渡った PEM を実改行に戻す(Workers の text var・CI の env の形)', () => {
    const oneLine = '-----BEGIN PRIVATE KEY-----\\nAAAA\\nBBBB\\n-----END PRIVATE KEY-----\\n'
    expect(normalizePrivateKey(oneLine)).toContain('\nAAAA\nBBBB\n')
    // 実改行が既に含まれているものはそのまま(壊れた中間の \\n を勝手に直さない)
    expect(normalizePrivateKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')).toContain('\nAAAA\n')
  })

  it('envCandidates は Workers env を先に列挙し、同じ値は1つにまとめる', () => {
    setWorkerEnv({ X: 'from-worker' })
    process.env.X = 'from-worker'
    expect(envCandidates('X')).toEqual(['from-worker'])
    process.env.X = 'from-process'
    expect(envCandidates('X')).toEqual(['from-worker', 'from-process'])
  })
})
