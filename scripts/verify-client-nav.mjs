// ヘッドレス Chrome でスマホ相当の client-side 遷移を再現する検証スクリプト。
// 使い方: node scripts/verify-client-nav.mjs [baseUrl]
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:3000'

async function scenario(name, startPath) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const page = await browser.newPage()
  const log = []
  page.on('request', (r) => log.push(`${r.method()} ${r.url().replace(base, '')}`))

  await page.goto(`${base}${startPath}`, { waitUntil: 'networkidle' })
  const before = { url: page.url(), h1: await page.textContent('h1').catch(() => null) }

  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('QR'), { timeout: 10000 })
    .catch(() => {})
  await page.waitForTimeout(1500)
  const after = { url: page.url(), h1: await page.textContent('h1').catch(() => null) }

  console.log(`[${name}] start=${startPath}`)
  console.log(`  before: ${before.url} h1=${before.h1}`)
  console.log(`  after:  ${after.url} h1=${after.h1}`)
  console.log(`  requests: ${log.join(' | ')}`)
  console.log(`  verdict: ${after.h1?.includes('QR') ? 'OK(画面がQRページに変わった)' : 'FAIL(URLだけ変わった/戻った)'}\n`)
  await browser.close()
  return after.h1?.includes('QR')
}

const a = await scenario('cache-poisoned(/scan→login→dev login)', '/scan')
const b = await scenario('fresh(/login→dev login)', '/login')
process.exit(a && b ? 0 : 1)
