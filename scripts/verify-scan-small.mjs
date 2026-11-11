// /scan の小モード(スキャン範囲25% + 内部ズーム)で、小さいQRのみが検出されることを
// canvas.captureStream で実測する検証(標準UI)。中央の小さいQRは実データ 1004、
// 左右端の大きいQRは照合領域(中央の短辺25%)の外に置く。
// 標準UIのプレビューはライブラリ標準(無ズーム)で、拡大は照合内部(nearest 3倍)のみ。
// 使い方: node scripts/verify-scan-small.mjs [baseUrl]
import { chromium } from 'playwright-core'
import pkg from '@zxing/library'
const { QRCodeWriter, BarcodeFormat } = pkg

const base = process.argv[2] ?? 'http://127.0.0.1:3000'

function matrixData(text, size) {
  const m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, new Map())
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

await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'dev ログイン' }).click()
await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('QR'), { timeout: 10000 })
await page.waitForFunction(() => document.querySelector('.muted')?.textContent?.includes('スキャン中'), { timeout: 10000 })

// 小モードに切替: ライブラリ overlay の枠が短辺の25%になり、内部3倍拡大の案内が出ることを確認
// (切り替えは pause/start で照合領域を再適用するので、status が25%になってから撮る)
await page.getByRole('button', { name: 'スキャン範囲: 25%(小・ズーム)' }).click()
await page.waitForFunction(
  () => document.querySelector('.muted')?.textContent?.includes('25%'),
  { timeout: 10000 },
)
const ui = await page.evaluate(() => {
  const v = document.querySelector('video')
  const box = document.querySelector('.scan-box')
  const overlay = document.querySelector('.scan-region-highlight')
  return {
    status: document.querySelector('.muted')?.textContent ?? '',
    // プレビューは無ズーム(ライブラリは facingMode に応じたミラー transform だけを書く)
    transform: v ? getComputedStyle(v).transform : '',
    overlayRatio: overlay && box ? parseFloat(overlay.style.width) / box.clientHeight : null,
    error: document.querySelector('.error')?.textContent ?? null,
  }
})
console.log('small UI:', JSON.stringify(ui))
const uiOk = ui.overlayRatio !== null && Math.abs(ui.overlayRatio - 0.25) < 0.06 &&
  !ui.transform.includes('matrix(4') && ui.error === null && ui.status.includes('25%') && ui.status.includes('3倍拡大')

const codes = {
  center: matrixData('1004', 90), // 小さいQR(90px < 小枠120px)中央配置
  left: matrixData('NOPE-LEFT', 100),
  right: matrixData('NOPE-RIGHT', 100),
}

let ok = uiOk
await page.evaluate((c) => {
  const video = document.querySelector('video')
  const w = video.videoWidth || 640
  const h = video.videoHeight || 480
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#000'
  const draw = (data, size, offsetX, offsetY) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[y * size + x]) ctx.fillRect(offsetX + x, offsetY + y, 1, 1)
      }
    }
  }
  draw(c.center, 90, Math.floor((w - 90) / 2), Math.floor((h - 90) / 2)) // 中央(小枠内)
  draw(c.left, 100, 0, Math.floor((h - 100) / 2)) // 左端(小枠 x=260.. の外)
  draw(c.right, 100, w - 100, Math.floor((h - 100) / 2)) // 右端(小枠 x=..379 の外)
  video.srcObject = canvas.captureStream(10)
  void video.play?.()?.catch?.(() => {})
}, codes).catch(() => console.log('evaluate was interrupted by navigation(engine detected immediately)'))

try {
  await page.waitForFunction(() => location.search.includes('code=1004'), { timeout: 15000 })
  // 結果カードのフェッチ完了まで待つ(遷移直後のテキストは空になり得る)
  await page.waitForFunction(
    () => document.querySelector('.result-card')?.textContent?.includes('渡辺健斗'),
    { timeout: 10000 },
  ).catch(() => {})
  ok = ok && true
} catch {
  ok = false
  console.log(`FAIL: 遷移URL=${page.url()} / 画面=${(await page.textContent('body').catch(() => '')).slice(0, 120)}`)
}
const listText = ok ? await page.textContent('.result-card').catch(() => '') : ''
console.log(`detected url: ${page.url()}`)
console.log(`result shows 渡辺健斗: ${listText.includes('渡辺健斗')}`)

// 結果表示後にスキャンへ戻り(まっさらな読み込みでも)、選択したスキャン範囲が維持されるか
if (ok && listText.includes('渡辺健斗')) {
  await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('.muted')?.textContent?.includes('25%'),
    { timeout: 10000 },
  )
  const persisted = await page.evaluate(() => {
    const v = document.querySelector('video')
    const box = document.querySelector('.scan-box')
    const overlay = document.querySelector('.scan-region-highlight')
    return {
      status: document.querySelector('.muted')?.textContent ?? '',
      transform: v ? getComputedStyle(v).transform : '',
      overlayRatio: overlay && box ? parseFloat(overlay.style.width) / box.clientHeight : null,
      overlayPresent: !!overlay,
      error: document.querySelector('.error')?.textContent ?? null,
    }
  })
  console.log('persisted after return:', JSON.stringify(persisted))
  ok =
    persisted.overlayPresent &&
    persisted.overlayRatio !== null && Math.abs(persisted.overlayRatio - 0.25) < 0.06 &&
    !persisted.transform.includes('matrix(4') &&
    persisted.error === null &&
    persisted.status.includes('25%')
}

console.log(ok && listText.includes('渡辺健斗') ? 'verdict: OK(小枠+内部ズームで小さいQRを検出・実データ表示・選択維持)' : 'verdict: FAIL')
await browser.close()
process.exit(ok && listText.includes('渡辺健斗') ? 0 : 1)
