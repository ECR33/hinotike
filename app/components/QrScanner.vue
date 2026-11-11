<script setup lang="ts">
// 照合は qr-scanner(nimiq) の標準UI(QrScanner の連続スキャン)のみ。
// 自作UI(中央の枠+十字・プレビューズーム・独自照合ループ)は廃除した。標準UIは
// requestVideoFrameCallback + 連続スキャンで応答が良く、zxing のフレーム全体デコード
// (隣のQRの壊れた読み取りで頻発していたエラー表示)も使わない。
//  - ライブラリが video の兄弟として生成する overlay が「スキャン範囲の枠
//    (highlightScanRegion)」と「検出したQRの輪郭(highlightCodeOutline)」を描く
//    (geometry・アニメーションはライブラリ標準、色だけアプリテーマに合わせる)。
//  - 照合範囲は2モード: 大(既定)= 短辺50%の中央正方形 / 小 = 短辺25%の中央正方形を
//    内部で nearest 3倍拡大。ライブラリは imageSmoothingEnabled=false で領域を
//    downScaled へ描くため、downScaled > width の拡大はデジタルズームになる
//    (小さいQRでもモジュールが数pxになり読める)。プレビューはライブラリ標準のまま
//    (無ズーム。ライブラリがミラー用の transform を書くので自前の scale は掛けない)。
//  - エンジンはライブラリ側が選択する(native BarcodeDetector があればHW加速、
//    なければ WebWorker の jsQR)。QRなし・壊れたQRの onDecodeError は swallow し、
//    エラー表示を出さない。
//  - スキャン範囲の選択(50%/25%)はスキャン→結果→スキャンの往復とリロードで維持する。
import { libraryScanRegion, CROP_FRAC, SMALL_CROP_FRAC } from '#shared/utils/qr-scan'

defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ detected: [code: string] }>()

const video = ref<HTMLVideoElement | null>(null)
const status = ref('カメラを起動しています…')
const error = ref<string | null>(null)
const running = ref(false)
// スキャン範囲の選択はスキャン→結果→スキャンの往復でも維持される(共有state)。
// localStorageにも保存し、ページリロード後や新しいセッションでも引き継ぐ。
const mode = useState<'large' | 'small'>('qr-scan-mode', () => 'large')
// ライト(torch)が使える場合のみライトボタンを出す(ライブラリの hasFlash 判定)。
const flashAvailable = ref(false)
const flashOn = ref(false)

const frac = computed(() => (mode.value === 'small' ? SMALL_CROP_FRAC : CROP_FRAC))
// 照合の拡大倍率(nearest)。小さいQRのモジュールを3px程度にして精度を上げる。
const scanZoom = computed(() => (mode.value === 'small' ? 3 : 1))

// qr-scanner は SSR で必要にならないため onMounted で動的importする(client-only)。
type QrScannerClass = typeof import('qr-scanner')['default']
type QrScannerInstance = InstanceType<QrScannerClass>
let qrScannerClass: QrScannerClass | null = null
// 連続スキャンのインスタンス。スキャン範囲の切り替え時に pause/start で枠を再適用する。
let libScanner: QrScannerInstance | null = null
// 検出後の重複コールバック(同じフレームで複数回の onDecode)を防ぐ。
let handled = false

function statusText(): string {
  return mode.value === 'small'
    ? 'スキャン中… 中央の枠(25%)を内部で3倍拡大して照合しています'
    : 'スキャン中… 中央の枠(50%)を照合しています'
}

function setMode(m: 'large' | 'small') {
  if (mode.value === m) return
  mode.value = m
  if (!running.value) return
  // 照合領域(QrScanner の _scanRegion)は start/play 時に確定するため、
  // 枠を変えたらスキャンを再開始する。pause(true) で即カメラ解放 → start() で再取得。
  void restartLibraryRegion()
}

async function restartLibraryRegion() {
  const s = libScanner
  if (!s) {
    status.value = statusText()
    return
  }
  try {
    await s.pause(true)
    await s.start()
    status.value = statusText()
  } catch (e) {
    status.value = 'スキャン範囲の切り替えに失敗しました。'
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function start() {
  error.value = null
  if (!video.value || running.value) return
  handled = false
  if (!qrScannerClass) {
    status.value = 'スキャンエンジン(qr-scanner)を読み込めませんでした。'
    error.value = 'qr-scanner の読み込みに失敗しました。ページを reloading してください。'
    return
  }
  try {
    libScanner = new qrScannerClass(video.value, onDecode, {
      returnDetailedScanResult: true,
      highlightScanRegion: true,
      highlightCodeOutline: true,
      onDecodeError: () => {},
      maxScansPerSecond: 12,
      preferredCamera: 'environment',
      calculateScanRegion: (videoEl: HTMLVideoElement) =>
        libraryScanRegion(videoEl.videoWidth, videoEl.videoHeight, frac.value, scanZoom.value),
    })
    await libScanner.start()
    running.value = true
    status.value = statusText()
    // hasFlash は start 後に呼ぶ(一時ストリームを開いて権限を尋ねるのを避ける)。
    flashAvailable.value = await libScanner.hasFlash().catch(() => false)
    flashOn.value = libScanner.isFlashOn()
  } catch (e) {
    const s = libScanner
    libScanner = null
    if (s) {
      s.pause(true)
      s.$overlay?.remove()
      s.destroy()
    }
    running.value = false
    status.value = 'カメラを開始できませんでした。開始ボタンを押してください。'
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function onDecode(result: { data: string }) {
  if (!running.value || handled) return
  handled = true
  stop()
  emit('detected', result.data)
}

async function toggleFlash() {
  const s = libScanner
  if (!s) return
  try {
    if (flashOn.value) {
      await s.turnFlashOff()
      flashOn.value = false
    } else {
      await s.turnFlashOn()
      flashOn.value = true
    }
  } catch (e) {
    flashOn.value = false
    error.value = `ライトを操作できませんでした: ${e instanceof Error ? e.message : String(e)}`
  }
}

function teardown() {
  running.value = false
  if (libScanner) {
    const s = libScanner
    libScanner = null
    // pause(true) は srcObject と track を即解放する(stop() は300ms後の解放なので
    // 再開始時に古いストリームを巻き込む可能性がある)。
    void s.pause(true)
    // overlay はライブラリが video の兄弟として生成する要素。destroy() はDOMから
    // 除去しないのでここで消す(次回 create で二重の枠が出ないよう)。
    s.$overlay?.remove()
    s.destroy()
  }
  if (video.value) video.value.srcObject = null
  flashAvailable.value = false
  flashOn.value = false
}

function stop() {
  teardown()
  status.value = '停止しました。開始ボタンで再開できます。'
}

// 開始ボタン押下なしで自動起動する(ブラウザの権限ダイアログのみ表示される)。
// 自動起動が失敗した場合(ジェスチャーが必要なブラウザ等)は開始ボタンで手动開始できる。
onMounted(async () => {
  // 保存されたスキャン範囲を復元(結果画面から戻った後も選択が維持される)。
  const saved = localStorage.getItem('qr-scan-mode')
  if (saved === 'small' || saved === 'large') mode.value = saved
  try {
    const mod = await import('qr-scanner')
    qrScannerClass = mod.default
  } catch {
    qrScannerClass = null
  }
  void start()
})

watch(mode, (m) => {
  try {
    localStorage.setItem('qr-scan-mode', m)
  } catch {
    // 記憶できない環境(localStorage不可)では選択はそのセッション内のみ維持
  }
})

onBeforeUnmount(() => {
  stop()
})
</script>

<template>
  <div>
    <div class="scan-box">
      <video ref="video" class="scan-video" playsinline muted autoplay></video>
      <!-- 枠と検出QRの輪郭はライブラリが生成する overlay(.scan-region-highlight /
           .code-outline-highlight)が描く。自前の枠は置かない。 -->
    </div>
    <div class="mode-row">
      <button
        class="btn secondary"
        :class="{ active: mode === 'large' }"
        :disabled="disabled"
        @click="setMode('large')"
      >スキャン範囲: 50%(大)</button>
      <button
        class="btn secondary"
        :class="{ active: mode === 'small' }"
        :disabled="disabled"
        @click="setMode('small')"
      >スキャン範囲: 25%(小・ズーム)</button>
    </div>
    <p class="muted">{{ status }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <button
      v-if="running && flashAvailable"
      class="btn secondary"
      :class="{ active: flashOn }"
      @click="toggleFlash"
    >{{ flashOn ? 'ライト: ON' : 'ライト: OFF' }}</button>
    <button v-if="running" class="btn secondary" @click="stop">スキャン停止</button>
    <button v-else class="btn" :disabled="disabled" @click="start">スキャン開始</button>
  </div>
</template>

<style scoped>
.scan-box {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  max-height: 60vh;
  background: #0b1220;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 12px;
}
.scan-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform-origin: center;
  /* ミラーの transform はライブラリがインラインで書く(facingMode に応じて scaleX(-1)) */
}
.mode-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.mode-row .btn {
  font-size: 14px;
}
.mode-row .btn.active {
  box-shadow: inset 0 0 0 2px rgba(120, 190, 255, 0.8);
}
</style>

<style>
/* ライブラリが video の兄弟として挿入する overlay の描画。
   ライブラリは svg に inline で stroke(#e9b213) を書くため、アプリのテーマ色にするには
   !important が必要(枠の geometry・アニメーションはライブラリ標準のまま、色だけ合わせる)。
   scoped外(ライブラリが生成する要素には Vue の scope属性が付かないため :deep() では効かない)。 */
.scan-box .scan-region-highlight-svg {
  stroke: #7ecbff !important;
  stroke-width: 5;
  fill: none !important;
}
.scan-box .code-outline-highlight {
  stroke: #7ecbff !important;
  stroke-width: 3;
  fill: none !important;
}
</style>
