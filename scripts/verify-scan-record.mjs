// /scan の「記録モード + 連続スキャン」を実測する検証(fakeカメラの代わりに canvas.captureStream で
// 複数のQRを順に流す)。既定はシート書き込み(flush)を行わず、読み取り→待機列までを確認する。
//
//   node scripts/verify-scan-record.mjs [baseUrl]                … 読み取りと待機列だけ(シートに触らない)
//   VERIFY_SCAN_FLUSH=1 node scripts/verify-scan-record.mjs      … 確定書き込みまで(/records の履歴も確認)
//     → 注意: VERIFY_SCAN_FLUSH は設定されたスプレッドシートに 配布済 / 配布日時 を書く。
//       ローカルの dev シート(scripts/service-account.json が指す ID)に対してだけ実行すること。
//
// 使うコードは実行時にローカル items から 未記録(配布済≠済)の行を3件 pick する
// (ハードコードだと flush 実行後に済へ変わって dedupe warn になり再実行できない)。
// モードは「チケット配布」(confirm_before_record=false = 連続で次々と記録)を選ぶ。
import { chromium } from 'playwright-core'
import pkg from '@zxing/library'

const { QRCodeWriter, BarcodeFormat } = pkg

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const doFlush = process.env.VERIFY_SCAN_FLUSH === '1'

function matrixData(text) {
  const m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 100, 100, new Map())
  const data = []
  for (let y = 0; y < m.getHeight(); y++) {
    for (let x = 0; x < m.getWidth(); x++) data.push(m.get(x, y) ? 1 : 0)
  }
  return data
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const page = await browser.newPage()

async function loginAndOpenScan() {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', { timeout: 15000 })
  // fakeカメラがスキャン中になるまで待つ(canvas の解像度を video.videoWidth に合わせるため)
  await page.waitForFunction(() => document.querySelector('.muted')?.textContent?.includes('スキャン中'), { timeout: 15000 })
}

/** 中央枠(libraryScanRegion frac=0.5)に1つのQRだけ描いて映像を差し替える(隣のQRは描かない)。 */
async function streamCode(text) {
  const data = matrixData(text)
  await page
    .evaluate((d) => {
      const video = document.querySelector('video')
      const w = video.videoWidth || 640
      const h = video.videoHeight || 480
      const side = Math.floor(Math.min(w, h) * 0.5)
      // captureStream は作った canvas に紐付くので、同じ canvas を再利用し描画だけ更新する
      // (canvas を作り直すと古い stream が continues して検出が止まる)。
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
      return { width: w, height: h, stream: video.srcObject?.constructor?.name ?? 'none' }
    }, data)
    .catch(() => console.log(`streamCode(${text}) was interrupted by the page`))
}

function mutedText() {
  return page.evaluate(() => [...document.querySelectorAll('.muted')].map((p) => p.textContent ?? '').join(' | '))
}

async function listText() {
  return (await page.textContent('.session-list').catch(() => '')) ?? ''
}

let failures = []
try {
  await loginAndOpenScan()

  // 未記録の行を3件 pick(チケット配布は 配布済 を書く。スキャン済み=済の行は
  // dedupe warn になるので、開始時に未記録の行を選ぶことで再実行できる)。
  // 待機列の行は氏名を出す(entry.name があれば氏名、なければ code)ので実データの氏名で確認する。
// /api/import はシートを読むだけで端末に書かない(このスクリプトはミラーを作らない)。
  // シートの行を /api/import から読む(server の照会APIは撤去した。取り込み応答が唯一の行読み)。
  const picked = await page.evaluate(async () => {
    const rows = []
    let cursor = 0
    for (let i = 0; i < 10; i++) {
      const j = await (await fetch(`/api/import?limit=200&cursor=${cursor}`)).json()
      rows.push(...(j.rows ?? []))
      if (!j.nextCursor) break
      cursor = Number(j.nextCursor)
    }
    return rows
      .filter((r) => r.payload?.['配布済'] !== '済' && (r.payload?.['氏名'] ?? '') !== '')
      .slice(0, 3)
      .map((r) => ({ code: String(r.code), name: String(r.payload['氏名']) }))
  })
  if (picked.length < 3) {
    failures.push(`未記録(配布済≠済)の items 行が3件無い(${picked.length}件)。/sync か dev シートの 配布済 を戻す`)
  }

  // 記録モードを選ぶ(チップの「チケット配布」= 連続記録)
  await page.getByRole('button', { name: 'チケット配布' }).click()
  // モード選択でスキャナーを再マウントする(scannerKey)。再マウント前に描いたQRは
  // 旧 video に流れ、新しい側の session は空になるので1件目が消える。待ってから描く。
  await page.waitForTimeout(1500)
  await page.waitForFunction(
    () => [...document.querySelectorAll('.muted')].map((p) => p.textContent ?? '').join(' | ').includes('スキャン中'),
    { timeout: 10000 },
  )

  // 1件目 → 2件目 → 3件目を順に流す(同じQRの再読み取りは dedupe 窓で無視される)
  for (const { code, name } of picked) {
    await streamCode(code)
    await page
      .waitForFunction((n) => document.querySelector('.session-list')?.textContent?.includes(n), name, { timeout: 12000 })
      .catch(() => failures.push(`待機列に ${code}(${name}) が現れない`))
    // 同じ映像を数回読ませる(重複無視の動作確認。件数が1回しか増えないこと)
    await page.waitForTimeout(600)
  }

  const reads = Number((await mutedText()).match(/読み取り (\d+)件/)?.[1] ?? 0)
  const list = await listText()
  const queued = (list.match(/未確定/g) ?? []).length
  if (!picked.every(({ name }) => list.includes(name))) failures.push('待機列に3件が並んでいない')
  if (reads < picked.length) failures.push(`読み取り件数が少ない(${reads}件 < ${picked.length}件)`)
  // 同じQRを窓内で再読しても未確定は3件(重複が積み上がらない)
  if (queued !== picked.length) failures.push(`未確定が ${queued}件(期待 ${picked.length}件 = 窓内の再読は無視される)`)

  console.log(`モード: チケット配布 / pick ${picked.map(({ code, name }) => `${code}(${name})`).join(' / ')} / 読み取り ${reads}件 / 未確定 ${queued}件`)
  console.log(`待機列: ${list.replace(/\s+/g, ' ').slice(0, 220)}`)

  if (doFlush) {
    await page.getByRole('button', { name: /書き込みを確定/ }).click()
    await page
      .waitForFunction(() => document.body.textContent?.includes('シートに書き込み'), { timeout: 20000 })
      .catch(() => failures.push('flush の注記が出ない'))
    console.log(`flush 注記: ${(await page.textContent('body').catch(() => '')).match(/\d+件をシートに書き込みました[^※]*/)?.[0] ?? ''}`)

    await page.goto(`${base}/records`, { waitUntil: 'networkidle' })
    const all = await page.textContent('body').catch(() => '')
    const seen = picked.filter(({ code }) => all.includes(code)).map(({ code }) => code)
    if (seen.length < picked.length) failures.push(`/records に ${seen.join(', ')} の履歴だけが現れた`)
    console.log(`/records の履歴: ${seen.join(' / ')}`)
  } else {
    console.log('flush は未実施(VERIFY_SCAN_FLUSH=1 でシート書き込みまで確認する)')
  }
} catch (e) {
  failures.push(`例外: ${e instanceof Error ? e.message : String(e)}`)
}

// dev サーバにサービスアカウント鍵が無いと check/flush が 400 になり、上の失敗は全部その副作用なので原因を先頭に書く。
  // 鍵は dev では `GOOGLE_SERVICE_ACCOUNT_JSON_PATH`(.env.development にある)から fs で読むか `.dev.vars` の
  //  JSON(`globalThis.__env__`)を使う(server/utils/googleSheets.ts の readServiceAccountKey)。
  //  ここが 400 になるのは「鍵ファイルも .dev.vars も無い」場合(scripts/service-account.json を置くか .dev.vars を作る)
  if ((await page.textContent('body').catch(() => '')).includes('GOOGLE_SERVICE_ACCOUNT_JSON')) {
    failures.unshift(
      'dev サーバに サービスアカウント鍵が無いので書き込みが 400 で落ちた(`GOOGLE_SERVICE_ACCOUNT_JSON_PATH` が指すファイル(scripts/service-account.json)か `.dev.vars` の鍵 JSON が必要です)',
    )
  }

  if (failures.length) {
  console.log(`FAIL: ${failures.join(' / ')}`)
  console.log(`画面=${(await page.textContent('body').catch(() => '')).slice(0, 200)}`)
}
const verdict = failures.length === 0
console.log(`verdict: ${verdict ? 'OK(連続スキャンで3件が待機列に積まれた)' : 'FAIL'}`)
await browser.close()
process.exit(verdict ? 0 : 1)
