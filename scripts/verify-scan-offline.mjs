// `/scan` のオフラインモードを実測する検証(dev サーバ + ローカル Supabase 前提)。
// 流れ: 準備(通信あり)→ チェックインをオフライン(context.setOffline)で確認→記録 → IndexedDB の
// キューに積む → 画面を閉じて reload しても復旧確定Bannerが残る( persistence 検証)→
// VERIFY_OFFLINE_FLUSH=1 のとき復旧確定(/api/scan-offline-flush でシートへ書き込み、証跡にオフライン時刻)。
//
//   node scripts/verify-scan-offline.mjs [baseUrl]
//
// 注意: 復旧確定は **dev シートに 来場済/来場日時 を書く**(verify-scan-confirm と同じ制約)。
// デフォルトでは確定せず、待機キューを IndexedDB から掃除して終わる。
//
// オフラインでのページ起動(SW の HTML cache)とオフライン SPA 遷移(/scan→/result のローカル照会)は
// dev では SW が登録されないためここでは検証しない(本番 build の SW で動く。このスクリプトは
// setOffline 下でも「スナップショットが有効なら通信を使わない記録」が動くことを検証する)。
import { chromium } from 'playwright-core'
import pkg from '@zxing/library'

const { QRCodeWriter, BarcodeFormat } = pkg

const base = process.argv[2] ?? 'http://127.0.0.1:3000'

function matrixData(text) {
  const m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 100, 100, new Map())
  const data = []
  for (let y = 0; y < m.getHeight(); y++) for (let x = 0; x < m.getWidth(); x++) data.push(m.get(x, y) ? 1 : 0)
  return data
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`console(${m.type()}): ${m.text()}`)
})

/** 中央枠に1つのQRだけ描く(captureStream は作った canvas に紐付くので同じ canvas を再利用する)。 */
async function streamCode(text) {
  const data = matrixData(text)
  await page
    .evaluate((d) => {
      const video = document.querySelector('video')
      const w = video.videoWidth || 640
      const h = video.videoHeight || 480
      const side = Math.floor(Math.min(w, h) * 0.5)
      let canvas = window.__scanCanvas
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        window.__scanCanvas = canvas
        video.srcObject = canvas.captureStream(10)
        void video.play?.()?.catch?.(() => {})
      }
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#000'
      const m = Math.max(2, Math.floor(side / 100))
      const qrPx = 100 * m
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          if (d[y * 100 + x]) ctx.fillRect(Math.floor((w - qrPx) / 2) + x * m, Math.floor((h - qrPx) / 2) + y * m, m, m)
        }
      }
    }, data)
    .catch(() => console.log(`streamCode(${text}) was interrupted by the page`))
}

const scanning = () => () => [...document.querySelectorAll('.muted')].map((p) => p.textContent ?? '').join(' | ').includes('スキャン中')

const failures = []
try {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', { timeout: 15000 })
  await page.waitForFunction(scanning, undefined, { timeout: 15000 })

  // 開始前にローカルキューを空にする(前の実行の残りが件数断言に混ざらないようにする)
  await page.evaluate(async () => {
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
    await new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite')
      tx.objectStore('queue').clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }).catch(() => {})

  // 実在する code と氏名を items から選ぶ(ハードコードせず dev データに追随する)。
  // 来場済=済 の行は dedupe で復旧確定がスキップになるので、未記録の行を選ぶ(実行を反復できる)。
  const picked = await page.evaluate(async () => {
    const j = await (await fetch('/api/items-list?limit=100')).json()
    const row = (j.rows ?? []).find((r) => r.payload?.['来場済'] !== '済')
    return row ? { code: String(row.code), name: row.payload?.['氏名'] ?? null } : null
  })
  if (!picked?.code) {
    failures.push('items にコードが無い(dev Supabase の同期 / /sync が必要)')
  } else {
    const CODE = picked.code
    const NAME = picked.name ?? CODE

    // ── オフライン準備(通信あり)── オフライン欄は管理欄(details)の中なので開いてから押す
    await page.locator('.admin-card > summary').click()
    await page.getByRole('button', { name: 'オフラインモード準備' }).click()
    await page
      .waitForFunction(() => document.body.textContent?.includes('オフライン準備完了'), undefined, { timeout: 60000 })
      .catch(() => failures.push('オフライン準備完了の注記が出ない'))
    console.log(`準備: ${(await page.textContent('body').catch(() => '')).match(/オフライン準備完了\([^)]*\)/)?.[0] ?? ''}`)

    // ── チェックインモード(確認モード)を選択 → 通信を切ってスキャン ──
    await page.getByRole('button', { name: 'チェックイン' }).click()
    await page.waitForTimeout(1500)
    await page.waitForFunction(scanning, undefined, { timeout: 10000 })

    // スマホサイズで確認カードの収まりを見る(カードはカメラ枠の内側下部に出る。
    // 枠の下に積むと 390x640 で bottom-nav に隠れてスクロールが必要だった)
    await page.setViewportSize({ width: 390, height: 640 })
    await page.waitForTimeout(300)

    await page.context().setOffline(true)
    // 偽カメラは再マウント直後に検出を1回取り逃すことがあるので、カードが出なければ描き直して再試行する
    let pendingShown = false
    for (let attempt = 0; attempt < 2 && !pendingShown; attempt++) {
      await streamCode(CODE)
      await page.waitForFunction((n) => document.querySelector('.pending-card')?.textContent?.includes(n), NAME, { timeout: 12000 }).catch(() => {})
      pendingShown = await page.textContent('.pending-card').catch(() => '').then((t) => t.includes(NAME))
    }
    if (!pendingShown) failures.push('オフライン確認カードに氏名が現れない(ローカルスナップショット照合が動いていない)')
    const pending = await page.textContent('.pending-card').catch(() => '')
    console.log(`オフライン確認カード: ${pending.replace(/\s+/g, ' ').slice(0, 160)}`)

    // 「記録」は busy の間 disabledになる(disabled は hit-test されない)ので、有効化されてから
    // hit を測る(押せる状態の実測)。待機がタイムアウトした場合は下の断言で失敗になる。
    await page.waitForFunction(() => {
      const b = document.querySelector('.pending-card button')
      return !!b && !b.disabled
    }, undefined, { timeout: 15000 }).catch(() => {})
    // 準備操作(管理欄は画面下)で画面が下にスクロールしたままなので、スキャンの実際の位置(最上部)に
    // 戻してから測る(= 実使用で「スクロールせずに押せる」を見る)。
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(200)
    const fit = await page.evaluate(() => {
      const p = document.querySelector('.pending-card')?.getBoundingClientRect()
      const box = document.querySelector('.scan-box')?.getBoundingClientRect()
      const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect()
      const btn = document.querySelector('.pending-card button')
      const r = btn?.getBoundingClientRect()
      const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null
      return {
        insideCamera: !!(p && box && p.top >= box.top && p.bottom <= box.bottom + 1),
        aboveNav: !!(p && nav && p.bottom <= nav.top),
        recordHit: !!(btn && hit && btn.contains(hit)),
        // 画面内に本当に見える(スクロールなしで押せる)こと
        btnInViewport: !!(r && r.top >= 0 && r.bottom <= window.innerHeight),
        // 失敗したときの原因を見えるようにする(disabled は hit-test されない / 別の要素が被さる)
        btnDisabled: btn?.disabled ?? null,
        hitTag: hit?.tagName ?? null,
        hitClass: hit?.className ?? null,
      }
    })
    console.log(`オフライン確認カードの収まり: ${JSON.stringify(fit)}`)
    if (!fit.insideCamera) failures.push('オフライン確認カードがカメラ枠の内側に出ていない(縦を積んでいる)')
    if (!fit.aboveNav) failures.push('オフライン確認カードが bottom-nav に隠れる(スクロールが必要)')
    if (!fit.recordHit) failures.push('オフライン確認カードの「記録」ボタンが別の要素に押されている')
    if (!fit.btnInViewport) failures.push('オフライン確認カードの「記録」が画面内に見えない(スクロールが必要)')

    // 記録 → ローカルキュー(IDB)に積む(通信しない)
    await page.getByRole('button', { name: /^記録$/ }).click()
    await page
      .waitForFunction(() => document.body.textContent?.includes('ローカルに記録'), undefined, { timeout: 10000 })
      .catch(() => failures.push('ローカル記録の注記が出ない'))
    await page
      .waitForFunction((c) => document.body.textContent?.includes(`オフラインの記録 ${c}件`), 1, { timeout: 10000 })
      .catch(() => failures.push('復旧確定Banner(オフラインの記録 1件)が出ない'))
    if (!(await page.textContent('body').catch(() => '')).includes('未確定(ローカル)')) failures.push('セッション欄が未確定(ローカル)表示にならない')
    console.log('オフライン記録: 確認カード→記録→ローカルキュー 1件 OK')

    // ── persistence: reload(通信あり)してもキューが残る ──
    await page.context().setOffline(false)
    await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
    await page
      .waitForFunction((c) => document.body.textContent?.includes(`オフラインの記録 ${c}件`), 1, { timeout: 10000 })
      .catch(() => failures.push('reload 後に復旧確定Bannerが消えた(IndexedDB の persistence が壊れている)'))
    console.log('reload 後も オフラインの記録 1件 が残る(IndexedDB persistence OK)')

    // ── オフライン items 一覧(/scan のスナップショットからローカルで絞り込み・分页)──
    await page.goto(`${base}/items`, { waitUntil: 'networkidle' })
    await page
      .waitForFunction(() => document.body.textContent?.includes('オフラインのスナップショット'), undefined, { timeout: 10000 })
      .catch(() => failures.push('/items のオフライン注記が出ない(スナップショット一覧が動いていない)'))
    console.log(`/items 注記: ${(await page.textContent('body').catch(() => '')).match(/オフラインのスナップショット\([^)]*\)/)?.[0] ?? ''}`)
    await page
      .waitForFunction(() => document.querySelectorAll('.item-list li').length > 0, undefined, { timeout: 10000 })
      .catch(() => failures.push('/items のスナップショット一覧が空(IDB から1ページ目が出ていない)'))
    // 氏名で絞り込む(デバウンス後にスナップショットからローカル照合。通信しない)
    await page.getByLabel('氏名(部分一致)').fill(NAME)
    await page
      .waitForFunction((n) => document.querySelectorAll('.item-list li').length === 1 && document.body.textContent?.includes(n), NAME, { timeout: 10000 })
      .catch(() => failures.push('/items の氏名絞り込みがスナップショットから効かない'))
    console.log(`/items 氏名絞り込み: ${NAME} → ${(await page.textContent('.status').catch(() => '')).replace(/\s+/g, ' ').trim()} / ${await page.evaluate(() => document.querySelector('.item-list li')?.textContent?.slice(0, 40) ?? '')}`)

    // 年・組の欄を開いて、選択肢がスナップショットから生成されていることを確認する(chip が出る=facetError でない)
    await page.getByRole('button', { name: /年・組の絞り込み/ }).click().catch(() => {})
    await page
      .waitForFunction(() => document.querySelectorAll('.facet .chip').length > 0 && !document.querySelector('.facet .chips')?.textContent?.includes('読み込み中'), undefined, { timeout: 5000 })
      .catch(() => failures.push('/items の年・組の chip がスナップショットから出ない(facet 導出が壊れている)'))
    console.log(`/items facet chips: ${await page.evaluate(() => document.querySelectorAll('.facet .chip').length)}個`)

    // ── 復旧確定(ゲート: dev シートへ 来場済/来場日時 を書く)──
    if (process.env.VERIFY_OFFLINE_FLUSH === '1') {
      await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: /^オフラインの記録を確定/ }).click()
      await page
        .waitForFunction(() => document.body.textContent?.includes('復旧確定'), undefined, { timeout: 20000 })
        .catch(() => failures.push('復旧確定の注記が出ない'))
      const note = (await page.textContent('body').catch(() => '')).match(/復旧確定:.*/)?.[0] ?? ''
      console.log(`復旧確定: ${note.replace(/\s+/g, ' ').slice(0, 180)}`)
      if (!note.includes('1件をシートに書き込みました')) failures.push('復旧確定で 1件が書き込まれない')

      // 記録後の状態を API で読む(シート→payload の往復がオフライン時の日時で載る)
      const check = await page.evaluate(async (code) => {
        const cfg = await (await fetch('/api/scan-config')).json()
        const modeId = cfg.modes.find((m) => m.name === 'チェックイン')?.id
        if (!modeId) return { modeId: null }
        const j = await (await fetch('/api/scan-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modeId, code }),
        })).json()
        return { modeId, state: j.state, recordedAt: j.recordedAt }
      }, CODE)
      console.log(`記録後の状態: ${JSON.stringify(check)}`)
      if (check.state !== '済') failures.push('復旧確定後の状態が済にならない')
      if (!check.recordedAt) failures.push('復旧後の記録日時が載らない')

      // 証跡 scan_events(/records)にオフライン時刻(off-line の at)がそのまま残る
      await page.goto(`${base}/records`, { waitUntil: 'networkidle' })
      const history = await page.textContent('body').catch(() => '')
      if (!history.includes(CODE)) failures.push(`/records に ${CODE} の証跡がない`)
      console.log(`/records: ${CODE} の証跡 ${history.includes(CODE) ? 'あり' : 'なし'}`)
    } else {
      // ゲート未指定: シートを書かず、待機キューだけ掃除して元の状態に戻す
      await page.evaluate(async () => {
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
        await new Promise((resolve, reject) => {
          const tx = db.transaction('queue', 'readwrite')
          tx.objectStore('queue').clear()
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
        db.close()
      }).catch((e) => console.log(`cleanup failed: ${e instanceof Error ? e.message : String(e)}`))
      console.log('VERIFY_OFFLINE_FLUSH=1 を付けると復旧確定(シート書き込み+証跡)まで検証します(待機キューは掃除済み)')
    }
  }
} catch (e) {
  failures.push(`例外: ${e instanceof Error ? e.message : String(e)}`)
}
if (errors.length) failures.push(`画面エラー: ${errors.join(' | ')}`)
if (failures.length) {
  console.log(`FAIL: ${failures.join(' / ')}`)
  console.log(`画面=${(await page.textContent('body').catch(() => '')).slice(0, 200)}`)
}
const verdict = failures.length === 0
  ? `OK(準備→オフライン確認→ローカル記録→persistence→itemsスナップショット一覧${process.env.VERIFY_OFFLINE_FLUSH === '1' ? '→復旧確定→証跡' : ''})`
  : 'FAIL'
console.log(`verdict: ${verdict}`)
await browser.close()
process.exit(failures.length === 0 ? 0 : 1)
