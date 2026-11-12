/**
 * bottom navigation の headless Chrome 検証。
 * 使い方: node scripts/verify-bottom-nav.mjs [baseUrl] [email:password] [newcomerEmail:password]
 *   - baseUrl の既定は http://127.0.0.1:3000(dev サーバ)
 *   - 既定の許可済みユーザ: dev@example.com / dev-password-2026(npm run supabase:dev-user で作成)
 *   - 未登録ユーザのログインが失敗する場合はそのシナリオをスキップする。作成は
 *     node scripts/create-dev-user.mjs <email> <password> --no-registration
 *
 * 管理系(アプリ共有・利用者登録・同期・ログアウト)は「管理」dropdown に格納されたので
 * 遷移検証は dropdown を開いて menu 内項目をクリックする。
 */
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const approver = (process.argv[3] ?? 'dev@example.com:dev-password-2026').split(':')
const newcomer = (process.argv[4] ?? 'navtest@example.com:nav-password-2026').split(':')

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })

/** /login の dev フォームからログインして着地ページの nav を読む。失敗时 null */
async function login(email, password) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 720 } })
  const page = await ctx.newPage()
  const warns = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') warns.push(`${m.type()}: ${m.text().slice(0, 160)}`)
  })
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[placeholder="email"]', email)
  await page.fill('input[placeholder="password"]', password)
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForTimeout(1200)
  if (new URL(page.url()).pathname === '/login') {
    await ctx.close()
    return null
  }
  return { page, ctx, warns }
}

/** nav の項目ラベル(アクティブ項目には * を付く。dropdown トリガーは親 .nav-manage.active で光る) */
function navLabels(page) {
  return page.locator('.bottom-nav .nav-item').evaluateAll((els) =>
    els.map((el) => {
      const active = el.classList.contains('active') || el.parentElement?.classList.contains('active')
      return `${el.textContent.trim()}${active ? '*' : ''}`
    }),
  )
}

/** 管理 dropdown を開く(menu 項目ラベル。アクティブ項目には * を付く) */
async function openMenu(page) {
  await page.getByRole('button', { name: '管理' }).click()
  await page.waitForTimeout(300)
  return page.locator('.nav-menu .menu-item').evaluateAll((els) =>
    els.map((el) => `${el.textContent.trim()}${el.classList.contains('active') ? '*' : ''}`),
  )
}

/** dropdown が閉じているか(.nav-menu の個数。0 = 閉) */
function menuCount(page) {
  return page.locator('.nav-menu').count()
}

/** 最下部までスクロールしたとき、コンテンツが nav に重ならないか(余白ぶんは数えない) */
async function overlapGap(page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  return page.evaluate(() => {
    const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect()
    if (!nav) return null
    let minGap = Infinity
    for (const el of document.querySelectorAll('.card, .btn, .field, h1, h2, p, img, video')) {
      const r = el.getBoundingClientRect()
      if (r.height === 0) continue
      minGap = Math.min(minGap, nav.top - r.bottom)
    }
    return Math.round(minGap)
  })
}

const out = []
const path = (page) => {
  const u = new URL(page.url())
  return u.pathname + u.search
}
function record(name, value, url = '') {
  out.push(`${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}${url ? ` ${url}` : ''}`)
}

// --- 許可済みユーザ: トップ / QRスキャン / 一覧 / 管理(dropdown) ---
const ok = await login(...approver)
if (!ok) {
  out.push('許可済みユーザ: ログイン失敗(dev ユーザを作成してください)')
} else {
  record('ログイン着地', await navLabels(ok.page), path(ok.page))
  await ok.page.locator('.bottom-nav .nav-item', { hasText: 'トップ' }).click()
  await ok.page.waitForTimeout(600)
  record('トップ遷移', await navLabels(ok.page), path(ok.page))

  // 管理 dropdown を開いてアプリ共有へ(/share)。QRは client 側生成なので少し待つ。
  record('管理menu項目', await openMenu(ok.page))
  await ok.page.locator('.nav-menu .menu-item', { hasText: 'アプリ共有' }).click()
  await ok.page.waitForTimeout(800)
  record('アプリ共有遷移', await navLabels(ok.page), path(ok.page))
  record('共有画面のQR描画数', await ok.page.locator('.qr-svg').count())
  record('共有画面のリンク表示', await ok.page.locator('.page .mono').first().textContent().catch(() => null))
  record('遷移でmenu閉', await menuCount(ok.page))

  // 同じ dropdown から利用者登録・同期へ(格納先ルートでは「管理」が点灯する)
  await openMenu(ok.page)
  await ok.page.locator('.nav-menu .menu-item', { hasText: '利用者登録' }).click()
  await ok.page.waitForTimeout(600)
  record('利用者登録遷移', await navLabels(ok.page), path(ok.page))
  await openMenu(ok.page)
  await ok.page.locator('.nav-menu .menu-item', { hasText: '同期' }).click()
  await ok.page.waitForTimeout(600)
  record('同期遷移', await navLabels(ok.page), path(ok.page))

  // 外側クリックで閉じる
  await openMenu(ok.page)
  await ok.page.locator('.page h1').click()
  await ok.page.waitForTimeout(300)
  record('外側クリックでmenu閉', await menuCount(ok.page))

  // 照会結果はスキャンの延長なので QRスキャン が点灯する(管理は点灯しない)
  await ok.page.goto(`${base}/result?code=nope`, { waitUntil: 'networkidle' })
  record('照会結果のnav', await navLabels(ok.page), path(ok.page))
  record('照会結果の重なり余白', await overlapGap(ok.page), 'px')

  // dropdown からログアウト(menu は自分で閉じる → 未認証の nav に戻る)
  await openMenu(ok.page)
  await ok.page.locator('.nav-menu .menu-item', { hasText: 'ログアウト' }).click()
  await ok.page.waitForTimeout(900)
  record('navログアウト後', await navLabels(ok.page), path(ok.page))
  record('ログアウトでmenu閉', await menuCount(ok.page))
  record('console(warn/error)', ok.warns)
  await ok.ctx.close()
}

// --- 認証済み・未登録: トップ / 許可依頼 / 管理(dropdown: ログアウト) ---
const ng = await login(...newcomer)
if (!ng) {
  out.push(
    '未登録ユーザ: スキップ(作成: node scripts/create-dev-user.mjs <email> <password> --no-registration)',
  )
} else {
  record('未登録の着地', await navLabels(ng.page), path(ng.page))
  record('未登録のmenu項目', await openMenu(ng.page))
  record('unauthorized の重なり余白', await overlapGap(ng.page), 'px')
  record('console(warn/error)', ng.warns)
  await ng.ctx.close()
}

// --- 未認証: トップ / ログイン ---
const anonCtx = await browser.newContext({ viewport: { width: 390, height: 720 } })
const anon = await anonCtx.newPage()
const anonWarns = []
anon.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') anonWarns.push(`${m.type()}: ${m.text().slice(0, 160)}`)
})
await anon.goto(`${base}/`, { waitUntil: 'networkidle' })
record('未認証トップのnav', await navLabels(anon), path(anon))
await anon.locator('.bottom-nav .nav-item', { hasText: 'ログイン' }).click()
await anon.waitForTimeout(600)
record('ログイン遷移', await navLabels(anon), path(anon))
record('console(warn/error)', anonWarns)
await anonCtx.close()

await browser.close()
console.log(out.join('\n'))
