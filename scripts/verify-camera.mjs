// ヘッドレス Chrome(fake camera device)で /scan のスキャン挙動を実測する検証。
// 新仕様に合わせている: 自動起動(開始ボタン押下なし)、中央枠 overlay、スキャン停止/再開、
// カメラを画面上部に置くレイアウト(390x640 などでカメラ+停止/開始+モード選択が bottom-nav 上に
// スクロールなしで収まり、枠の内側右上の範囲トグルが押せること)。
// 使い方: node scripts/verify-camera.mjs [baseUrl]
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:3000'

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream', // 権限ダイアログを自動許可(dev/test用)
  ],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  // dev は Vite の hydration が後着する。先に押すと click ハンドラが未接続で通信が起きない。
  await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'dev ログイン' }).click()
await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('QR'), { timeout: 10000 })

// 開始ボタンを押さずに自動起動しているか(fake-ui 自動許可で権限ダイアログなし)
await page.waitForFunction(
  () => document.querySelector('.muted')?.textContent?.includes('スキャン中'),
  { timeout: 10000 },
)
const runningState = await page.evaluate(() => {
  const v = document.querySelector('video')
  const stream = v?.srcObject ?? null
  return {
    status: document.querySelector('.muted')?.textContent ?? '',
    error: document.querySelector('.error')?.textContent ?? null,
    srcObjectActive: !!stream,
    trackState: stream?.getVideoTracks?.()[0]?.readyState ?? null,
    videoReadyState: v?.readyState ?? 0,
    aimFrame: !!document.querySelector('.aim-frame'),
    overlayPresent: !!document.querySelector('.scan-region-highlight'),
    overlayInsideBox: !!document.querySelector('.scan-region-highlight') && !!document.querySelector('.scan-box')?.contains(document.querySelector('.scan-region-highlight')),
    overlaySiblingOfVideo: document.querySelector('.scan-region-highlight')?.previousElementSibling?.tagName === 'VIDEO',
    svgStroke: document.querySelector('.scan-region-highlight-svg') ? getComputedStyle(document.querySelector('.scan-region-highlight-svg')).stroke : null,
    codeOutlineSvgPresent: !!document.querySelector('.code-outline-highlight'),
    aimCross: !!document.querySelector('.aim-cross-h') && !!document.querySelector('.aim-cross-v'),
    stopButton: [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('スキャン停止')),
  }
})
console.log('running(auto-start):', JSON.stringify(runningState))

// 枠の内側(右上)トグル: 範囲の選択が効く + overlay(pointer-events:none)に押されずに click できる
const cornerClick = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.scan-box .scan-corner-btn')].find((b) => b.getAttribute('aria-label')?.includes('25%'))
  if (!btn) return { present: false }
  const r = btn.getBoundingClientRect()
  const box = document.querySelector('.scan-box')?.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return {
    present: true,
    insideBox: !!box && r.top >= box.top - 1 && r.right <= box.right + 1,
    hitIsButton: !!hit && (hit === btn || btn.contains(hit)),
  }
})
console.log('corner toggle(範囲/ライト):', JSON.stringify(cornerClick))

// レイアウト: スマホサイズでカメラが画面上部にあり、停止/開始+モード選択が bottom-nav 上に収まるか
const layoutSizes = [[390, 640], [430, 800], [412, 915]]
const layouts = []
for (const [width, height] of layoutSizes) {
  await page.setViewportSize({ width, height })
  await page.waitForTimeout(300)
  layouts.push(await page.evaluate((size) => {
    const box = document.querySelector('.scan-box')?.getBoundingClientRect()
    const scannerRow = document.querySelector('.scan-box')?.parentElement?.querySelector('.mode-row')?.getBoundingClientRect()
    const chips = document.querySelector('.chip-row')?.getBoundingClientRect()
    const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect()
    return {
      size: `${size[0]}x${size[1]}`,
      cameraTop: box ? Math.round(box.top) : null,
      // カメラの中心が viewport の上部寄りにあるか(= レンズ位置とプレビューのズレが小さいか)
      cameraCenterRatio: box ? Math.round(((box.top + box.height / 2) / innerHeight) * 100) / 100 : null,
      fitsWithoutScroll: !!(box && scannerRow && chips && nav && box.top >= 0 && chips.bottom <= nav.top + 1),
      controlsBottom: chips ? Math.round(chips.bottom) : null,
      navTop: nav ? Math.round(nav.top) : null,
    }
  }, [width, height]))
}
console.log('layout:', JSON.stringify(layouts))
await page.setViewportSize({ width: 1280, height: 900 })
await page.waitForTimeout(300)

// スキャン停止 → カメラ解放・開始ボタン復帰
await page.getByRole('button', { name: 'スキャン停止' }).click()
await page.waitForTimeout(400)
const stoppedState = await page.evaluate(() => ({
  status: document.querySelector('.muted')?.textContent ?? '',
  srcObjectActive: !!document.querySelector('video')?.srcObject,
  overlayPresent: !!document.querySelector('.scan-region-highlight'),
  startButton: [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('スキャン開始')),
}))
console.log('stopped:', JSON.stringify(stoppedState))

// 手動再開 → 再びスキャン中
await page.getByRole('button', { name: 'スキャン開始' }).click()
await page.waitForFunction(
  () => document.querySelector('.muted')?.textContent?.includes('スキャン中'),
  { timeout: 10000 },
)
const resumed = await page.evaluate(() => ({
  status: document.querySelector('.muted')?.textContent ?? '',
  srcObjectActive: !!document.querySelector('video')?.srcObject,
  overlayPresent: !!document.querySelector('.scan-region-highlight'),
  error: document.querySelector('.error')?.textContent ?? null,
}))
console.log('resumed:', JSON.stringify(resumed))

const ok =
  runningState.srcObjectActive && runningState.videoReadyState >= 2 && runningState.error === null &&
  !runningState.aimFrame && runningState.overlayPresent && runningState.overlayInsideBox &&
  runningState.overlaySiblingOfVideo && runningState.svgStroke === 'rgb(126, 203, 255)' &&
  cornerClick.present && cornerClick.insideBox && cornerClick.hitIsButton &&
  layouts.length === layoutSizes.length &&
  layouts.every((l) => l.fitsWithoutScroll && l.cameraTop !== null && l.cameraTop <= 160 && l.cameraCenterRatio !== null && l.cameraCenterRatio <= 0.45) &&
  runningState.codeOutlineSvgPresent && runningState.stopButton &&
  !stoppedState.srcObjectActive && !stoppedState.overlayPresent && stoppedState.startButton &&
  resumed.srcObjectActive && resumed.overlayPresent && resumed.error === null && errors.length === 0

console.log(errors.length ? `pageerrors: ${errors.join(' | ')}` : 'pageerrors: none')
console.log(ok ? 'verdict: OK(自動起動・標準UIの枠・停止/再開・カメラ上部のレイアウト・トグル操作)' : 'verdict: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
