// 端末データの削除と uid 紐づけを実測する(一時スクリプト。dev サーバ + ローカル Supabase 前提)。
// 取り込みは Google 鍵が要るので、ミラーはスクリプトが直接 IndexedDB に置く(削除と紐づけの経路だけ検証する)。
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://localhost:3000'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage()
const failures = []
const ok = (label, cond, extra = '') => {
  if (cond) console.log(`${label}: OK ${extra}`)
  else failures.push(`${label}${extra ? ` (${extra})` : ''}`)
}

const OPEN_DB = async () => new Promise((resolve, reject) => {
  const req = indexedDB.open('hinotike-offline', 1)
  req.onupgradeneeded = () => {
    for (const s of ['snapshot', 'items', 'queue']) {
      if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
    }
  }
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

async function seedMirror(uid, sourceId, name) {
  await page.evaluate(async ({ uid, sourceId, name }) => {
    const cfg = await (await fetch('/api/scan-config')).json()
    const src = (cfg.sources ?? []).find((s) => s.id === sourceId) ?? cfg.sources?.[0] ?? {
      id: sourceId, name: '検証データ', spreadsheetId: 'x', worksheet: null, codeColumn: 'ID',
      includeColumns: [], excludeColumns: [], filterColumn: null, filterValues: [], rename: {},
      enabled: true, updatedAt: null, updatedBy: null,
    }
    const meta = {
      enabled: true, sourceId, uid, sourceName: src.name ?? '検証データ', source: src,
      snapshotAt: new Date().toISOString(), itemCount: 1, config: cfg, capped: false,
    }
    localStorage.setItem('hinotike-offline-meta', JSON.stringify(meta))
    localStorage.setItem('hinotike-active-source', String(sourceId))
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('hinotike-offline', 1)
      req.onupgradeneeded = () => {
        for (const s of ['snapshot', 'items', 'queue']) {
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const at = new Date().toISOString()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'snapshot', 'queue'], 'readwrite')
      tx.objectStore('items').put({ code: 'TESTCODE', payload: { 氏名: name }, sourceId }, `${sourceId}|TESTCODE`)
      tx.objectStore('snapshot').put(meta, 'meta')
      tx.objectStore('queue').put({
        id: `1|TESTCODE|${at}`, sourceId, modeId: cfg.modes?.[0]?.id ?? 1, modeName: 'チェックイン',
        code: 'TESTCODE', status: 'ok', name, overwrite: false, at,
      }, `1|TESTCODE|${at}`)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    // ページキャッシュにも氏名入りの HTML を載せる(削除で消えることの確認用)
    if (typeof caches !== 'undefined') {
      const c = await caches.open('hinotike-pages')
      await c.put(new URL('/items', location.origin).href, new Response(`<html><body>氏名:${name}</body></html>`, { status: 200 }))
    }
    return at
  }, { uid, sourceId, name })
}

async function readState() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('hinotike-offline', 1)
      req.onupgradeneeded = () => {
        for (const s of ['snapshot', 'items', 'queue']) {
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const count = (store) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly')
      const req = tx.objectStore(store).count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const named = await new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readonly')
      const req = tx.objectStore('queue').getAll()
      req.onsuccess = () => resolve((req.result ?? []).filter((e) => e && typeof e.name === 'string' && e.name !== '').length)
      req.onerror = () => reject(req.error)
    })
    const items = await count('items')
    const snapshot = await count('snapshot')
    const queue = await count('queue')
    db.close()
    const cache = typeof caches === 'undefined' ? false : await caches.has('hinotike-pages')
    return {
      items,
      snapshot,
      queue,
      named,
      meta: localStorage.getItem('hinotike-offline-meta'),
      activeSource: localStorage.getItem('hinotike-active-source'),
      cache,
    }
  })
}

const body = () => page.textContent('body').catch(() => '')

try {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  // dev は Vite の hydration が後着する。先に押すと click ハンドラが未接続で通信が起きない。
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', { timeout: 15000 })
  const me = await page.evaluate(async () => (await (await fetch('/api/me')).json()))
  ok('me.uid が返る', typeof me.uid === 'string' && me.uid.length > 0, JSON.stringify({ authenticated: me.authenticated, authorized: me.authorized }))
  const cfg = await page.evaluate(async () => (await (await fetch('/api/scan-config')).json()))
  const sourceId = cfg.sources?.[0]?.id ?? 1

  // ── 別利用者のミラー(uid 不一致)──
  await seedMirror('someone-else-uid', sourceId, '別ユーザ太郎')
  await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
  ok('/scan が別利用者のミラーを使わない(banner)', (await body()).includes('別の利用者が取り込んだもの'))
  ok('/scan の summary に別利用者が出る', (await body()).includes('別利用者のデータ'))
  ok('/scan の chip に ✓端末 が出ない', !(await body()).includes('✓端末'))

  await page.goto(`${base}/items`, { waitUntil: 'networkidle' })
  const itemsBody = await body()
  ok('/items が別利用者のミラー一覧を出さない', !itemsBody.includes('この端末のデータ('), itemsBody.includes('別の利用者が取り込んだもの') ? '注記あり' : '注記なし')
  ok('/items の氏名がミラーから出ていない', !itemsBody.includes('別ユーザ太郎'))

  // dev(Vite)ではこの画面が networkidle に到達しない(HMR の接続が張り続ける)ので domcontentloaded+待ち
  await page.goto(`${base}/result?code=TESTCODE`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  // 照会は端末ミラーだけ(uid 一致のもの)。別利用者のミラーから氏名を出す経路は無い。
  // SSR は IDB を読めないので「この端末ではまだ取り込んでいない」案内になる。
  const resultBody = await body()
  ok('/result が別利用者のミラーから氏名を出さない', !resultBody.includes('別ユーザ太郎'), resultBody.slice(0, 120).replace(/\s+/g, ' '))

  // ── 自分のミラー(uid 一致)で削除 ──
  await seedMirror(me.uid, sourceId, '自分の太郎')
  await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
  ok('/scan が自分のミラーを使う(✓端末)', (await body()).includes('✓端末'))
  await page.locator('.admin-card > summary').click()
  await page.getByRole('button', { name: '端末のデータを完全に削除' }).click()
  await page.waitForFunction(() => (document.body.textContent ?? '').includes('この端末のデータを削除しました'), undefined, { timeout: 10000 }).catch(() => {})
  const after = await readState()
  console.log(`削除後: ${JSON.stringify(after)}`)
  ok('items ミラーが消える', after.items === 0)
  ok('snapshot が消える', after.snapshot === 0)
  ok('localStorage のメタが消える', after.meta === null)
  ok('localStorage のデータセット選択が消える', after.activeSource === null)
  ok('ページキャッシュが消える', after.cache === false)
  ok('ためた記録は残る(code。このスクリプトは2回 seed するので2件)', after.queue === 2)
  ok('ためた記録の氏名が除去される', after.named === 0)

  // ── ためた記録をすべて捨てる(2段階確認)──
  await page.getByRole('button', { name: /ためた記録をすべて捨てる/ }).click()
  ok('1回目で確認案内が出る', (await body()).includes('もう一度'))
  await page.getByRole('button', { name: /本当に捨てる/ }).click()
  await page.waitForFunction(() => !(document.body.textContent ?? '').includes('この端末にためた記録'), undefined, { timeout: 10000 }).catch(() => {})
  const afterDrop = await readState()
  ok('ためた記録が捨てられる', afterDrop.queue === 0, JSON.stringify(afterDrop))

  // ── ログアウトでも端末データが消える ──
  await seedMirror(me.uid, sourceId, ' logout太郎'.trim())
  await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /管理/ }).click()
  await page.getByRole('menuitem', { name: 'ログアウト' }).click()
  await page.waitForFunction(() => location.pathname === '/', { timeout: 15000 }).catch(() => {})
  const afterLogout = await readState()
  console.log(`ログアウト後: ${JSON.stringify({ items: afterLogout.items, snapshot: afterLogout.snapshot, queue: afterLogout.queue, named: afterLogout.named, meta: afterLogout.meta ? '残り' : 'なし', cache: afterLogout.cache })}`)
  ok('ログアウトで items ミラーが消える', afterLogout.items === 0)
  ok('ログアウトで snapshot が消える', afterLogout.snapshot === 0)
  ok('ログアウトでメタが消える', afterLogout.meta === null)
  ok('ログアウトでページキャッシュが消える', afterLogout.cache === false)
  ok('ログアウトで氏名だけ除去される', afterLogout.named === 0)
  ok('ログアウトでためた記録は残る', afterLogout.queue === 1)
} catch (e) {
  failures.push(`例外: ${e instanceof Error ? e.message : String(e)}`)
}
console.log(failures.length === 0 ? 'verdict: OK' : `FAIL: ${failures.join(' / ')}`)
await browser.close()
process.exit(failures.length === 0 ? 0 : 1)
