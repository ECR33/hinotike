// 連続照会の検証: /result?code=1004(SSR表示)→ client-sideで /scan → /items の code 検索で
// DEV-CODE を絞り、一覧の行タップから /result?code=DEV-CODE に遷移する。
// /scan の手入力欄は撤去されたので、client-side遷移の入口は一覧の行リンクを使う
// (スキャン検出 navigateTo と同じ SPA 遷移経路)。
// 使い方: node scripts/verify-result-refresh.mjs [baseUrl]
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:3000'

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage()
const log = []
page.on('request', (r) => log.push(`${r.method()} ${r.url().replace(base, '')}`))

// dev ログインして /scan に着地
await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'dev ログイン' }).click()
await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('QR'), { timeout: 10000 })

// 1件目: 1004 をフル(SSR)読み込み
await page.goto(`${base}/result?code=1004`, { waitUntil: 'networkidle' })
const first = await page.textContent('body')
console.log(`first(1004): contains渡辺健斗=${first.includes('渡辺健斗')}`)

// client-side遷移: スキャンに戻る → /scan → nav の「一覧」 → /items
await page.getByRole('link', { name: 'スキャンに戻る' }).click()
await page.waitForFunction(() => location.pathname === '/scan', { timeout: 5000 })
await page.getByRole('link', { name: '一覧' }).click()
await page.waitForFunction(() => location.pathname === '/items', { timeout: 5000 })

// 2件目: code 検索で DEV-CODE に絞り、行タップから照会(client-side遷移)
await page.getByPlaceholder('コードの一部を入力').fill('DEV-CODE')
await page.waitForFunction(
  () => document.querySelector('.item-row .item-code')?.textContent?.trim() === 'DEV-CODE',
  { timeout: 6000 },
)
await page.getByRole('link', { name: 'DEV-CODE' }).click()

let ok = true
try {
  await page.waitForFunction(
    () => {
      const card = document.querySelector('.result-card')?.textContent ?? ''
      return card.includes('dev item') && !card.includes('渡辺健斗')
    },
    { timeout: 5000 },
  )
} catch {
  ok = false
}
const second = await page.textContent('.result-card')
console.log(`second(DEV-CODE): url=${page.url()} listContainsDevItem=${second.includes('dev item')} listContains渡辺健斗=${second.includes('渡辺健斗')}`)
console.log(`api requests: ${log.filter((l) => l.includes('/api/') || l.startsWith('GET /result')).join(' | ')}`)
console.log(`verdict: ${ok ? 'OK(旧結果が消え新結果が表示された)' : 'FAIL(前の結果が残った)'}`)
await browser.close()
process.exit(ok ? 0 : 1)
