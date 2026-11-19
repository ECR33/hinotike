// `/scan` の「確認モード(氏名を確認してから記録)」を実測する検証。
// チェックイン(confirm_before_record=true)で 1件のQRを流し、pending card の氏名 → 「記録」ボタン →
// その場で flush されてシートに書かれる(= payload の済/未が済になる)までを確認する。
//
//   node scripts/verify-scan-confirm.mjs [baseUrl]
//
// 注意: 確認モードは記録ボタンで即 flush するので、**設定されたスプレッドシートに 来場済 / 来場日時 を書く**。
// ローカルの dev シート(scripts/service-account.json が指す ID)に対してだけ実行すること。
// /api/scan-check で状態を読むので、列がシートに存在する必要がある(`/scan-settings` で列を追加する)。
import { chromium } from 'playwright-core'
import pkg from '@zxing/library'

const { QRCodeWriter, BarcodeFormat } = pkg

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const CODE = '1018' // ローカル items に実在(田中桔平)
const NAME = '田中桔平'

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
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 140)}`)
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

// ページ側で評価する関数(Node の `page` は中で使えないので式をインラインにする)
const scanning = () =>
  () => [...document.querySelectorAll('.muted')].map((p) => p.textContent ?? '').join(' | ').includes('スキャン中')

const failures = []
try {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', { timeout: 15000 })
  await page.waitForFunction(scanning, undefined, { timeout: 15000 })

  // チェックイン(confirm_before_record=true)= 氏名を確認してから記録するモード
  await page.getByRole('button', { name: 'チェックイン' }).click()
  // モード選択でスキャナーを再マウントするので待ってから描く
  await page.waitForTimeout(1500)
  await page.waitForFunction(scanning, undefined, { timeout: 10000 })

  await streamCode(CODE)
  await page
    .waitForFunction((n) => document.querySelector('.pending-card')?.textContent?.includes(n), NAME, { timeout: 15000 })
    .catch(() => failures.push('確認カードに氏名が現れない'))
  const pending = await page.textContent('.pending-card').catch(() => '')
  console.log(`確認カード: ${pending.replace(/\s+/g, ' ').slice(0, 180)}`)
  const buttons = await page.evaluate(() => [...document.querySelectorAll('.pending-card button')].map((b) => b.textContent?.trim()))
  console.log(`確認カードのボタン: ${JSON.stringify(buttons)}`)

  // 連続モードと違い、確認前に待機列へ勝手に積まない(誤読の安全弁)
  const sessionBefore = await page.textContent('.session-list').catch(() => '')
  if (sessionBefore.includes(NAME)) failures.push('確認モードが待機列に勝手に積んだ')

  await page.getByRole('button', { name: /^記録$/ }).click()
  await page
    .waitForFunction(() => document.body.textContent?.includes('シートに書き込み'), undefined, { timeout: 20000 })
    .catch(() => failures.push('記録(flush)の注記が出ない'))
  console.log(`flush 注記: ${(await page.textContent('body').catch(() => '')).match(/\d+件をシートに書き込みました[^※]*/)?.[0] ?? ''}`)

  // 記録された状態(payload から正規化した済/未)を API で読む
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
  if (check.modeId === null) failures.push('チェックインのモードが見つからない')
  if (check.state !== '済') failures.push('記録後の状態が済にならない')
  if (!check.recordedAt) failures.push('記録日時が載らない')

  await page.goto(`${base}/records`, { waitUntil: 'networkidle' })
  const history = await page.textContent('body').catch(() => '')
  if (!history.includes(CODE)) failures.push(`/records に ${CODE} の履歴がない`)
  if (!history.includes('来場済')) failures.push('/records の履歴に 来場済 が表示されない')
  console.log(`/records: ${CODE} の履歴 ${history.includes(CODE) ? 'あり' : 'なし'} / 来場済の表示 ${history.includes('来場済') ? 'あり' : 'なし'}`)
} catch (e) {
  failures.push(`例外: ${e instanceof Error ? e.message : String(e)}`)
}
if (errors.length) failures.push(`画面エラー: ${errors.join(' | ')}`)
// dev サーバにサービスアカウント鍵が無いと check/flush が 400 になり、上の失敗は全部その副作用なので原因を先頭に書く。
  // (.env.development の GOOGLE_SERVICE_ACCOUNT_JSON=./scripts/service-account.json は Nuxt には パス文字列 として渡り、
  //  鍵 JSON として parse されないため dev では「鍵なし」扱いになる。書き込み側まで検証したいときは鍵の JSON 文字列を env に渡して起動する)
  if ((await page.textContent('body').catch(() => '')).includes('GOOGLE_SERVICE_ACCOUNT_JSON')) {
    failures.unshift(
      'dev サーバに サービスアカウント鍵が無いので書き込みが 400 で落ちた(.env.development の GOOGLE_SERVICE_ACCOUNT_JSON はパス指定なので鍵として読まれない。鍵の JSON 文字列を env に渡して dev サーバを起動し直すこと)',
    )
  }

  if (failures.length) {
  console.log(`FAIL: ${failures.join(' / ')}`)
  console.log(`画面=${(await page.textContent('body').catch(() => '')).slice(0, 200)}`)
}
console.log(`verdict: ${failures.length === 0 ? 'OK(氏名確認→記録→シート書き込みまで動作)' : 'FAIL'}`)
await browser.close()
process.exit(failures.length === 0 ? 0 : 1)
