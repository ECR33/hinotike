// `/scan` の**データセットの取り込みとローカル作業**を実測する検証(dev サーバ + ローカル Supabase 前提)。
// 流れ: 取り込み(通信あり)→ チェックインをローカル作業(context.setOffline)で確認→記録 → IndexedDB の
// キューに積む → 画面を閉じて reload しても「ためた記録を確定」Banner が残る(persistence 検証)→
// VERIFY_OFFLINE_FLUSH=1 のとき確定(/api/scan-offline-flush でシートへ書き込み、証跡に端末での読み取り時刻)。
// ゲート未指定の末尾では「端末のデータを完全に削除」を実測する(items/snapshot/localStorage のメタ・
// 選択/ページキャッシュが消え、ためた記録は氏名だけ除去されて code が残る)→「ためた記録をすべて捨てる」で queue 0。
//
//   node scripts/verify-scan-offline.mjs [baseUrl]
//
// 注意: 確定は **dev シートに 来場済/来場日時 を書く**(verify-scan-confirm と同じ制約)。
// デフォルトでは確定せず、待機キューを IndexedDB から掃除して終わる。
//
// ローカルでのページ起動(SW の HTML cache)とローカル SPA 遷移(/scan→/result のローカル照会)は
// dev では SW が登録されないためここでは検証しない(本番 build の SW で動く。このスクリプトは
// setOffline 下でも「取り込み済みなら通信を使わない記録」が動くことを検証する)。
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

// シートの行を /api/import の分页で読む(server の照会APIは撤去した。取り込み応答が唯一の sheet 読み)。
async function sheetRows(pg, maxPages = 10) {
  return pg.evaluate(async (pages) => {
    const rows = []
    let cursor = 0
    for (let i = 0; i < pages; i++) {
      const j = await (await fetch(`/api/import?limit=200&cursor=${cursor}`)).json()
      rows.push(...(j.rows ?? []))
      if (!j.nextCursor) break
      cursor = Number(j.nextCursor)
    }
    return rows
  }, maxPages)
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

  // 実在する code と氏名を**作業中のデータセット**から選ぶ(ハードコードせず dev データに追随する)。
  // 来場済=済 の行は dedupe で確定がスキップになるので、未記録の行を選ぶ(実行を反復できる)。
  const rows = await sheetRows(page)
  const picked = rows.find((r) => r.payload?.['来場済'] !== '済')
    ? { code: String(rows.find((r) => r.payload?.['来場済'] !== '済').code), name: rows.find((r) => r.payload?.['来場済'] !== '済').payload?.['氏名'] ?? null }
    : null
  if (!picked?.code) {
    failures.push('データセットにコードが無い(/sync でスプレッドシートを定義し、シートに data があること)')
  } else {
    const CODE = picked.code
    const NAME = picked.name ?? CODE

    // ── データの取り込み(通信あり)── データセット欄は管理欄(details)の中なので開いてから押す
    await page.locator('.admin-card > summary').click()
    await page.getByRole('button', { name: 'このデータを端末に取り込む' }).click()
    await page
      .waitForFunction(() => document.body.textContent?.includes('取り込み完了'), undefined, { timeout: 60000 })
      .catch(() => failures.push('取り込み完了の注記が出ない'))
    console.log(`取り込み: ${(await page.textContent('body').catch(() => '')).match(/取り込み完了:[^。]*/)?.[0] ?? ''}`)

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
    if (!pendingShown) failures.push('ローカル作業の確認カードに氏名が現れない(端末ミラーの照合が動いていない)')
    const pending = await page.textContent('.pending-card').catch(() => '')
    console.log(`ローカル確認カード: ${pending.replace(/\s+/g, ' ').slice(0, 160)}`)

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
    console.log(`ローカル確認カードの収まり: ${JSON.stringify(fit)}`)
    if (!fit.insideCamera) failures.push('確認カードがカメラ枠の内側に出ていない(縦を積んでいる)')
    if (!fit.aboveNav) failures.push('確認カードが bottom-nav に隠れる(スクロールが必要)')
    if (!fit.recordHit) failures.push('確認カードの「記録」ボタンが別の要素に押されている')
    if (!fit.btnInViewport) failures.push('確認カードの「記録」が画面内に見えない(スクロールが必要)')

    // 記録 → 端末のキュー(IDB)に積む(通信しない)
    await page.getByRole('button', { name: /^記録$/ }).click()
    await page
      .waitForFunction(() => document.body.textContent?.includes('端末に記録しました'), undefined, { timeout: 10000 })
      .catch(() => failures.push('ローカル記録の注記が出ない'))
    await page
      .waitForFunction((c) => document.body.textContent?.includes(`ためた記録 ${c}件`), 1, { timeout: 10000 })
      .catch(() => failures.push('確定Banner(この端末にためた記録 1件)が出ない'))
    if (!(await page.textContent('body').catch(() => '')).includes('未確定(ローカル)')) failures.push('セッション欄が未確定(ローカル)表示にならない')
    console.log('ローカル記録: 確認カード→記録→端末キュー 1件 OK')

    // ── persistence: reload(通信あり)してもキューが残る ──
    await page.context().setOffline(false)
    await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
    await page
      .waitForFunction((c) => document.body.textContent?.includes(`ためた記録 ${c}件`), 1, { timeout: 10000 })
      .catch(() => failures.push('reload 後に確定Bannerが消えた(IndexedDB の persistence が壊れている)'))
    console.log('reload 後も ためた記録 1件 が残る(IndexedDB persistence OK)')

    // ── ローカル items 一覧(取り込み済みデータからローカルで絞り込み・分页)──
    await page.goto(`${base}/items`, { waitUntil: 'networkidle' })
    await page
      .waitForFunction(() => document.body.textContent?.includes('この端末のデータ'), undefined, { timeout: 10000 })
      .catch(() => failures.push('/items のローカル注記が出ない(端末ミラーの一覧が動いていない)'))
    console.log(`/items 注記: ${(await page.textContent('body').catch(() => '')).match(/この端末のデータ\([^)]*\)/)?.[0] ?? ''}`)
    await page
      .waitForFunction(() => document.querySelectorAll('.item-list li').length > 0, undefined, { timeout: 10000 })
      .catch(() => failures.push('/items の端末一覧が空(IDB から1ページ目が出ていない)'))
    // 氏名で絞り込む(デバウンス後に端末ミラーからローカル照合。通信しない)
    await page.getByLabel('氏名(部分一致)').fill(NAME)
    await page
      .waitForFunction((n) => document.querySelectorAll('.item-list li').length === 1 && document.body.textContent?.includes(n), NAME, { timeout: 10000 })
      .catch(() => failures.push('/items の氏名絞り込みが端末データから効かない'))
    console.log(`/items 氏名絞り込み: ${NAME} → ${(await page.textContent('.status').catch(() => '')).replace(/\s+/g, ' ').trim()} / ${await page.evaluate(() => document.querySelector('.item-list li')?.textContent?.slice(0, 40) ?? '')}`)

    // 年・組の欄を開いて、選択肢が端末データから生成されていることを確認する(chip が出る=facetError でない)
    await page.getByRole('button', { name: /年・組の絞り込み/ }).click().catch(() => {})
    await page
      .waitForFunction(() => document.querySelectorAll('.facet .chip').length > 0 && !document.querySelector('.facet .chips')?.textContent?.includes('読み込み中'), undefined, { timeout: 5000 })
      .catch(() => failures.push('/items の年・組の chip が端末データから出ない(facet 導出が壊れている)'))
    console.log(`/items facet chips: ${await page.evaluate(() => document.querySelectorAll('.facet .chip').length)}個`)

    // ── ミラーの uid 紐づけ(取り込みした利用者の uid がメタに載る=別ユーザのローカル作業の根)──
    const metaUid = await page.evaluate(() => {
      const raw = localStorage.getItem('hinotike-offline-meta')
      if (!raw) return null
      try {
        return JSON.parse(raw)?.uid ?? null
      } catch {
        return null
      }
    })
    if (typeof metaUid !== 'string' || metaUid === '') {
      failures.push('取り込みメタに uid が載らない(別ユーザが読めるミラーになる = parseOfflineMeta が無効扱いにする)')
    } else {
      console.log(`ミラーの uid: ${metaUid}`)
    }

    // ── ためた記録の確定(ゲート: dev シートへ 来場済/来場日時 を書く)──
    if (process.env.VERIFY_OFFLINE_FLUSH === '1') {
      await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: /^ためた記録を確定/ }).click()
      await page
        .waitForFunction(() => document.body.textContent?.includes('確定:'), undefined, { timeout: 20000 })
        .catch(() => failures.push('確定の注記が出ない'))
      const note = (await page.textContent('body').catch(() => '')).match(/確定:.*/)?.[0] ?? ''
      console.log(`確定: ${note.replace(/\s+/g, ' ').slice(0, 180)}`)
      if (!note.includes('1件をシートに書き込みました')) failures.push('確定で 1件が書き込まれない')

      // 記録後の状態を**シートから**読む(確定で flush がシート索引のキャッシュを打ち直しているので再読は新値)。
      // server の照合 API(/api/scan-check)は撤去したため、取り込み応答の payload で済/未と日時を見る。
      const after = (await sheetRows(page)).find((r) => String(r.code) === CODE)
      const check = { state: after?.payload?.['来場済'] ?? null, recordedAt: after?.payload?.['来場日時'] ?? null }
      console.log(`記録後の状態: ${JSON.stringify(check)}`)
      if (check.state !== '済') failures.push('復旧確定後の状態が済にならない')
      if (!check.recordedAt) failures.push('復旧後の記録日時がシートに載らない')

      // 証跡 scan_events(/records)に端末での読み取り時刻(at)がそのまま残る
      await page.goto(`${base}/records`, { waitUntil: 'networkidle' })
      const history = await page.textContent('body').catch(() => '')
      if (!history.includes(CODE)) failures.push(`/records に ${CODE} の証跡がない`)
      console.log(`/records: ${CODE} の証跡 ${history.includes(CODE) ? 'あり' : 'なし'}`)
    } else {
      // ゲート未指定: シートを書かず、**端末のデータを完全に削除**して状態を戻す(削除の検証も兼ねる)。
      // 削除はミラー(items/snapshot)+localStorage のメタ/選択+ページキャッシュを消し、
      // ためた記録は氏名だけ除去して code/modeId/at を残す(確定能力は失わない)。
      await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: /管理 — 端末内のデータ/ }).click().catch(() => {})
      await page.getByRole('button', { name: '端末のデータを完全に削除' }).click()
      await page
        .waitForFunction(() => document.body.textContent?.includes('この端末のデータを削除しました'), undefined, { timeout: 10000 })
        .catch(() => failures.push('端末データの削除の注記が出ない'))
      const purged = await page.evaluate(async () => {
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
        const counts = {}
        for (const store of ['items', 'snapshot', 'queue']) {
          counts[store] = await new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readonly')
            const req = tx.objectStore(store).count()
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
          })
        }
        const named = await new Promise((resolve, reject) => {
          const tx = db.transaction('queue', 'readonly')
          const req = tx.objectStore('queue').getAll()
          req.onsuccess = () => resolve((req.result ?? []).filter((e) => e && typeof e.name === 'string' && e.name !== '').length)
          req.onerror = () => reject(req.error)
        })
        db.close()
        const cacheLeft = typeof caches === 'undefined' ? false : await caches.has('hinotike-pages')
        return {
          items: counts.items,
          snapshot: counts.snapshot,
          queue: counts.queue,
          named,
          metaLeft: localStorage.getItem('hinotike-offline-meta'),
          activeSourceLeft: localStorage.getItem('hinotike-active-source'),
          cacheLeft,
        }
      }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))
      if (purged.error) {
        failures.push(`削除後のストレージが読めない: ${purged.error}`)
      } else {
        console.log(`削除後: items=${purged.items} snapshot=${purged.snapshot} queue=${purged.queue}(氏名入り ${purged.named}) meta=${purged.metaLeft ? '残り' : 'なし'} activeSource=${purged.activeSourceLeft ? '残り' : 'なし'} cache=${purged.cacheLeft ? '残り' : 'なし'}`)
        if (purged.items !== 0) failures.push('削除後も items ミラーが残っている(氏名が端末に残る)')
        if (purged.snapshot !== 0) failures.push('削除後も snapshot が残っている')
        if (purged.metaLeft) failures.push('削除後も localStorage のメタが残っている(ローカル作業が復元される)')
        if (purged.activeSourceLeft) failures.push('削除後も「作業中のデータセット」の選択が残っている')
        if (purged.named !== 0) failures.push(`削除後もためた記録に氏名が残っている(${purged.named}件)`)
        if (purged.cacheLeft) failures.push('削除後もページキャッシュ(hinotike-pages)が残っている(缓存 HTML に氏名・email が載る)')
        if (purged.queue !== 1) failures.push(`削除でためた記録が消えた(${purged.queue}件 = 記録そのものは残す設計)`)
      }

      // ためた記録をすべて捨てる(2段階確認: 1回目で案内、2回目で実行)
      await page.getByRole('button', { name: /ためた記録をすべて捨てる/ }).click().catch(() => {})
      await page.getByRole('button', { name: /本当に捨てる/ }).click().catch(() => {})
      await page
        .waitForFunction(() => !document.body.textContent?.includes('この端末にためた記録'), undefined, { timeout: 10000 })
        .catch(() => failures.push('ためた記録を捨てても Banner が消えない(queue が消されていない)'))
      const queueLeft = await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('hinotike-offline', 1)
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains('queue')) req.result.createObjectStore('queue')
          }
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const n = await new Promise((resolve, reject) => {
          const tx = db.transaction('queue', 'readonly')
          const req = tx.objectStore('queue').count()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        db.close()
        return n
      }).catch(() => -1)
      if (queueLeft !== 0) failures.push(`ためた記録を捨てても queue に残る(${queueLeft}件)`)
      console.log('端末データの完全削除(items/snapshot/meta/cache)+ためた記録の氏名除去+捨てるときの queue 掃除 OK')
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
  ? `OK(取り込み→ローカル確認→端末記録→persistence→items端末一覧${process.env.VERIFY_OFFLINE_FLUSH === '1' ? '→確定→証跡' : ''})`
  : 'FAIL'
console.log(`verdict: ${verdict}`)
await browser.close()
process.exit(failures.length === 0 ? 0 : 1)
