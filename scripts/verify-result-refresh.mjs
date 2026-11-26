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
  // dev は Vite の hydration が後着する。先に押すと click ハンドラが未接続で通信が起きない。
  await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'dev ログイン' }).click()
await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('QR'), { timeout: 10000 })

// 1件目: 1004 をフル(SSR)読み込み
await page.goto(`${base}/result?code=1004`, { waitUntil: 'networkidle' })
const first = await page.textContent('body')
console.log(`first(1004): contains渡辺健斗=${first.includes('渡辺健斗')}`)

// client-side遷移: スキャンに戻る → /scan → nav の「一覧」 → /items
await page.getByRole('link', { name: 'スキャンに戻る' }).click()
await page.waitForTimeout(800)
await page.waitForFunction(() => location.pathname === '/scan', { timeout: 15000 })
await page.waitForTimeout(2000)
// /items の照合は端末ミラーが読むので、/scan にいるうちに取り込みをする
await page.getByRole('group', { name: '作業するデータセット' }).getByRole('button', { name: 'このデータを端末に取り込む' }).click()
await page.waitForFunction(() => document.body.textContent?.includes('取り込み完了'), { timeout: 60000 })
await page.getByRole('link', { name: '一覧' }).click()
await page.waitForTimeout(1000)
await page.waitForFunction(() => location.pathname === '/items', { timeout: 15000 })

// 2件目: code 検索で別の code に絞り、行タップから照会(client-side遷移)
const CODE2 = '1018'
await page.getByPlaceholder('コードの一部を入力').fill(CODE2)
await page.waitForFunction(
  // waitForFunction の関数はページ側にシリアライズされるので CODE2 は閉じ込められない(リテラルで書く)
  () => document.querySelector('.item-row .item-code')?.textContent?.trim() === '1018',
  { timeout: 6000 },
)
await page.getByRole('link', { name: CODE2 }).click()

let ok = true
try {
  await page.waitForFunction(
    () => {
      const card = document.querySelector('.result-card')?.textContent ?? ''
      // 前の行(1004 渡辺健斗)が消え、1018 の氏名が出れば切り替わり
      return card.includes('田中桔平') && !card.includes('渡辺健斗')
    },
    { timeout: 5000 },
  )
} catch {
  ok = false
}
const second = await page.textContent('.result-card')
console.log(`second(${CODE2}): url=${page.url()} contains田中桔平=${second.includes('田中桔平')} contains渡辺健斗=${second.includes('渡辺健斗')}`)
console.log(`api requests: ${log.filter((l) => l.includes('/api/') || l.startsWith('GET /result')).join(' | ')}`)
console.log(`verdict: ${ok ? 'OK(旧結果が消え新結果が表示された)' : 'FAIL(前の結果が残った)'}`)
await browser.close()
process.exit(ok ? 0 : 1)
