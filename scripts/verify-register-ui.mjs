// /register の UI 遷移(スキャン→依頼者確認のみ表示→キャンセルでカメラ復帰→許可でカメラのみ)を
// ヘッドレス Chrome(fakeカメラにQR画像を注入)で実測する検証。
// 使い方: node scripts/verify-register-ui.mjs [baseUrl]
// 依頼者(authユーザのみ)をAPIで作成し、許可者(dev@example.com)のブラウザで QR を読み、
// 最後に cleanup(authユーザ+users行削除)。承認後のDB検証は verify-registration-flow.mjs に委任。
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright-core'
import pkg from '@zxing/library'

const { QRCodeWriter, BarcodeFormat } = pkg

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const REQUESTER = 'qr-ui-tester@example.com'
const APPROVER = 'dev@example.com'
const PASSWORD = 'dev-password-2026'

let status
try {
  status = JSON.parse(
    execFileSync('node_modules/.bin/supabase', ['status', '--output', 'json'], { encoding: 'utf8' }),
  )
} catch {
  console.error('ローカル Supabase が起動していません。`npm run supabase:start` を実行してください。')
  process.exit(1)
}
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY)

async function cleanup() {
  await admin.from('users').delete().eq('email', REQUESTER)
  const { data: list } = await admin.auth.admin.listUsers()
  const u = list?.users.find((x) => x.email === REQUESTER)
  if (u) await admin.auth.admin.deleteUser(u.id)
}

function matrixData(text) {
  const m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 100, 100, new Map())
  const data = []
  for (let y = 0; y < m.getHeight(); y++) {
    for (let x = 0; x < m.getWidth(); x++) data.push(m.get(x, y) ? 1 : 0)
  }
  return data
}

function expect(cond, label) {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${label}`)
  if (!cond) process.exitCode = 1
}

async function main() {
  await cleanup()
  console.log('[step] cleanup done')
  await admin.auth.admin.createUser({ email: REQUESTER, password: PASSWORD, email_confirm: true })

  const login = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: REQUESTER, password: PASSWORD }),
  })
  if (!login.ok) throw new Error(`dev-login requester: HTTP ${login.status}`)
  const cookies = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const reqRes = await fetch(`${base}/api/registration-request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookies },
  })
  const req = await reqRes.json()
  if (!req?.token) throw new Error(`registration-request failed: ${JSON.stringify(req)}`)
  console.log('[step] request token obtained')
  const codes = { center: matrixData(req.token) }

  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  console.log('[step] browser launched')
  const page = await browser.newPage()

  // 許可者としてログインし /register でスキャン待機
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('email').fill(APPROVER)
  await page.getByPlaceholder('password').fill(PASSWORD)
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('QR'), { timeout: 10000 })
  console.log('[step] approver logged in (/scan)')
  await page.goto(`${base}/register`, { waitUntil: 'networkidle' })
  console.log('[step] /register loaded')
  await page.waitForFunction(() => document.body.textContent?.includes('スキャン中'), { timeout: 10000 })
  console.log('[step] scanning active')

  const inject = () =>
    page.evaluate((c) => {
      const video = document.querySelector('video')
      if (!video) return
      const w = video.videoWidth || 640
      const h = video.videoHeight || 480
      const side = Math.floor(Math.min(w, h) * 0.5)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#000'
      const m = Math.max(2, Math.floor(side / 100))
      const qrPx = 100 * m
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          if (c.center[y * 100 + x]) {
            ctx.fillRect(Math.floor((w - qrPx) / 2) + x * m, Math.floor((h - qrPx) / 2) + y * m, m, m)
          }
        }
      }
      video.srcObject = canvas.captureStream(10)
      void video.play?.()?.catch?.(() => {})
    }, codes)

  // 1) スキャン → 依頼者部分のみ表示(カメラは非表示)
  await inject()
  console.log('[step] QR injected #1')
  await page.waitForFunction((e) => document.body.textContent?.includes(e), REQUESTER, { timeout: 15000 })
  expect(await page.textContent('body').then((t) => t.includes(REQUESTER)), 'スキャン後: 依頼者のemailが表示される')
  expect(!(await page.locator('video').count()), 'スキャン後: カメラ(video) が非表示')
  expect(
    await page.textContent('body').then((t) => t.includes('この利用者を許可リスト(usersテーブル)に登録しますか?')),
    'スキャン後: 確認文が表示される',
  )

  // 2) キャンセル → カメラ復帰(再スキャン可能)
  await page.getByRole('button', { name: 'キャンセル' }).click()
  console.log('[step] cancel clicked')
  await page
    .waitForFunction(
      () => !!document.querySelector('video') && document.body.textContent?.includes('スキャン中'),
      { timeout: 10000 },
    )
    .catch(() => {})
  expect(await page.locator('video').count() > 0, 'キャンセル後: カメラが再表示されスキャン中になる')
  expect(
    !(await page.textContent('body').then((t) => t.includes(REQUESTER))),
    'キャンセル後: 依頼者部分は消える',
  )

  // 3) 再スキャン → 許可 → カメラのみ(done表示)
  await inject()
  console.log('[step] QR injected #2')
  await page.waitForFunction((e) => document.body.textContent?.includes(e), REQUESTER, { timeout: 15000 })
  expect(await page.locator('video').count() === 0, '再スキャン後: カメラは非表示')
  await page.getByRole('button', { name: '許可する' }).click()
  console.log('[step] approve clicked')
  await page.waitForFunction((e) => document.body.textContent?.includes(e), `登録しました: ${REQUESTER}`, { timeout: 15000 })
  expect(
    await page.textContent('body').then((t) => t.includes(`登録しました: ${REQUESTER}`)),
    '許可後: 登録しました表示',
  )
  expect(await page.locator('video').count() > 0, '許可後: カメラのみ表示される')
  expect(
    !(await page.textContent('body').then((t) => t.includes('この利用者を許可リスト'))),
    '許可後: 依頼者確認部分は消える',
  )

  await browser.close()
  console.log(process.exitCode ? 'verdict: FAIL' : 'verdict: OK')
}

main()
  .catch((e) => {
    console.error(e.message ?? e)
    process.exitCode = 1
  })
  .finally(async () => {
    await cleanup()
  })
