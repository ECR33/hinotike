// ヘッドレス Chrome で dev フォームログイン→誘導→QR表示の UI 挙動を確認する検証。
// 使い方: node scripts/verify-dev-login-ui.mjs [baseUrl]
// 2つの context(別 cookie jar)で許可者/依頼者を再現する。承認のカメラ読みは
// verify-registration-flow.mjs(API)で検証済みのため、ここでは QR 表示まで。
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const PASSWORD = 'dev-password-2026'

async function devLogin(page, startPath, email) {
  await page.goto(`${base}${startPath}`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('email').fill(email)
  await page.getByPlaceholder('password').fill(PASSWORD)
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForTimeout(1500)
  return page.url()
}

async function expect(cond, label) {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${label}`)
  if (!cond) process.exitCode = 1
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

try {
  // 依頼者(未登録): /login → dev ログイン → /unauthorized 誘導 + QR表示
  const ctxA = await browser.newContext()
  const requester = await ctxA.newPage()
  const urlA = await devLogin(requester, '/login', 'newcomer@example.com')
  expect(urlA.includes('/unauthorized'), '未登録ユーザは /unauthorized に誘導される')
  await requester.getByRole('button', { name: /許可を求める/ }).click()
  await requester.waitForSelector('img[src^="data:image"]', { timeout: 5000 }).catch(() => {})
  const qrSrc = await requester.getAttribute('img[src^="data:image"]', 'src').catch(() => null)
  expect(Boolean(qrSrc), '依頼者画面に QR(data:image)が表示される')
  const meA = await requester.evaluate(async () => {
    const r = await fetch('/api/me'); return r.json()
  })
  expect(meA.authenticated === true && meA.authorized === false, '依頼者セッションが確立されている(cookie保持)')

  // 許可者(登録済み): /login → dev ログイン → /scan、/register が閲覧できる
  const ctxB = await browser.newContext()
  const approver = await ctxB.newPage()
  const urlB = await devLogin(approver, '/login', 'dev@example.com')
  expect(urlB.includes('/scan'), '登録済みユーザは /scan に遷移する')
  await approver.goto(`${base}/register`, { waitUntil: 'networkidle' })
  const h1 = await approver.textContent('h1').catch(() => '')
  expect(/登録/.test(h1 ?? ''), '許可者画面で /register が保護されず閲覧できる')
  const meB = await approver.evaluate(async () => {
    const r = await fetch('/api/me'); return r.json()
  })
  expect(meB.authorized === true, '許可者セッションが確立されている(cookie保持)')

  // 別 context の依頼者には許可者の session が漏れていない(cookie 分離)
  const meCross = await requester.evaluate(async () => {
    const r = await fetch('/api/me'); return r.json()
  })
  expect(meCross.email === 'newcomer@example.com', '2セッションが独立(cookie jar 分離)')
} finally {
  await browser.close()
}
