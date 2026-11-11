// アイコンPNG生成: SVG(インライン化)をchromiumで指定サイズにレンダリングしてスクショ。
// 使い方: node scripts/render-icons.mjs
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const SOURCES = {
  normal: 'docs/icon-drafts/icon-512.svg',
  maskable: 'docs/icon-drafts/icon-maskable-512.svg',
}

const TARGETS = [
  { src: SOURCES.normal, out: 'public/icons/icon-192.png', size: 192 },
  { src: SOURCES.normal, out: 'public/icons/icon-512.png', size: 512 },
  { src: SOURCES.maskable, out: 'public/icons/icon-maskable-192.png', size: 192 },
  { src: SOURCES.maskable, out: 'public/icons/icon-maskable-512.png', size: 512 },
]

// chromiumバイナリ: 明示指定 > playwright cache > システムの google-chrome の順。
const candidates = [
  process.env.RENDER_CHROMIUM,
  (() => { try { return chromium.executablePath() } catch { return null } })(),
  '/usr/bin/google-chrome-stable',
].filter(Boolean)
const exists = (p) => { try { readFileSync(p); return true } catch { return false } }
const exe = candidates.find(exists)
if (!exe) throw new Error('chromium not found (set RENDER_CHROMIUM)')

mkdirSync('public/icons', { recursive: true })
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] })
for (const t of TARGETS) {
  const svg = readFileSync(t.src, 'utf8')
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size } })
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block;width:100%;height:100%}</style>${svg}`,
  )
  await page.screenshot({ path: t.out })
  await page.close()
}
await browser.close()
console.log('icons rendered:', TARGETS.map((t) => t.out).join(', '))
