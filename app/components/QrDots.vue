<script setup lang="ts">
/**
 * ドットスタイル QR の SVG 描画(qrcode-vue3 の dot style 参考)。
 * 既存の qrcode ライブラリ(qrcode ^1.5.4)の QRCode.create で module 行列を作り、
 * shared/utils/qr-dots.ts の幾何で SVG に描き直すだけ。新しいライブラリは追加しない。
 *
 * finderStyle の既定は 'rounded'(经典比率 1:1:3:1:1 を保つ形)。アプリ内スキャン
 * (/register の jsQR 系エンジン)と外部リーダーの両方で読めることを実測済み。
 * 'ring' は外部カメラ専用(内部スキャンでは読めない)。
 */
import { buildDotQrGeometry, QR_THEME, type DotQrGeometry, type DotQrTheme, type FinderStyle } from '#shared/utils/qr-dots'

const props = withDefaults(
  defineProps<{
    value: string
    ecLevel?: 'L' | 'M' | 'Q' | 'H'
    finderStyle?: FinderStyle
    theme?: DotQrTheme
  }>(),
  // object の既定値は factory にする(vue-tsc は object 直渡しを props 関数と解釈する)
  { ecLevel: 'M', finderStyle: 'rounded', theme: () => QR_THEME },
)

// qrcode は client 側でのみ使う(SSR で QR を作らないため dynamic import)。
let qrCreate: ((text: string, opts: { errorCorrectionLevel: string }) => unknown) | null = null

const geom = ref<DotQrGeometry | null>(null)
const errorMessage = ref<string | null>(null)

async function render(value: string) {
  errorMessage.value = null
  if (!value) {
    geom.value = null
    return
  }
  try {
    if (!qrCreate) {
      const mod = await import('qrcode')
      qrCreate = mod.default.create as (text: string, opts: { errorCorrectionLevel: string }) => unknown
    }
    const qr = qrCreate(value, { errorCorrectionLevel: props.ecLevel }) as {
      modules: { size: number; get: (x: number, y: number) => boolean }
    }
    geom.value = buildDotQrGeometry(qr, { finderStyle: props.finderStyle })
  } catch {
    geom.value = null
    errorMessage.value = 'QRの生成に失敗しました'
  }
}

watch(() => props.value, (v) => { void render(v) })
onMounted(() => { void render(props.value) })

// 同じ value でも「QR再生成」で作り直せるように expose する。
defineExpose({ render })
</script>

<template>
  <div class="qr-dots">
    <svg
      v-if="geom"
      class="qr-svg"
      :viewBox="`0 0 ${geom.dim} ${geom.dim}`"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      :aria-label="`QRコード: ${props.value}`"
    >
      <rect :x="0" :y="0" :width="geom.dim" :height="geom.dim" :rx="1" :fill="props.theme.background" />
      <circle v-for="(d, i) in geom.dots" :key="`d${i}`" :cx="d.cx" :cy="d.cy" :r="d.r" :fill="props.theme.dotColor" />
      <template v-for="(f, i) in geom.finders" :key="`f${i}`">
        <!-- rounded: 角丸リング(stroke) + 内部の塗りつぶし正方形 -->
        <template v-if="props.finderStyle === 'rounded'">
          <rect
            :x="f.cx - f.ringR + f.stroke / 2"
            :y="f.cy - f.ringR + f.stroke / 2"
            :width="f.ringR * 2 - f.stroke"
            :height="f.ringR * 2 - f.stroke"
            :rx="1.2"
            fill="none"
            :stroke="props.theme.finderColor"
            :stroke-width="f.stroke"
          />
          <rect
            :x="f.cx - f.innerHalf"
            :y="f.cy - f.innerHalf"
            :width="f.innerHalf * 2"
            :height="f.innerHalf * 2"
            :rx="f.innerRx"
            :fill="props.theme.finderColor"
          />
        </template>
        <!-- ring: 太いリング + 内部 3x3 ドット -->
        <template v-else>
          <circle
            :cx="f.cx"
            :cy="f.cy"
            :r="f.ringR"
            fill="none"
            :stroke="props.theme.finderColor"
            :stroke-width="f.stroke"
          />
          <circle
            v-for="(fd, j) in f.innerDots"
            :key="`f${i}-${j}`"
            :cx="fd.cx"
            :cy="fd.cy"
            r="0.32"
            :fill="props.theme.finderColor"
          />
        </template>
      </template>
    </svg>
    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
  </div>
</template>

<style scoped>
.qr-svg {
  width: min(280px, 60vw);
  height: auto;
  display: block;
}
</style>
