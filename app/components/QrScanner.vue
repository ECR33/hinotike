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
//  - スキャン範囲とライトの制御はカメラ枠の内側(右上)に置く。向ける先を決めている視線の
//    すぐそこで操作するため(行として下に並べると制御を探すためにカメラから目が離れる)。
import { libraryScanRegion, CROP_FRAC, SMALL_CROP_FRAC } from '#shared/utils/qr-scan'
import { isSameScan } from '#shared/utils/scan'

const props = defineProps<{ disabled?: boolean; busy?: boolean; continuous?: boolean }>()
const emit = defineEmits<{ detected: [code: string] }>()

const video = ref<HTMLVideoElement | null>(null)
const status = ref('カメラを起動しています…')
const error = ref<string | null>(null)
const running = ref(false)
// start() は await(libScanner.start()) を挟むので、同時に2回走るとインスタンスを
// 2つ作ってしまう(二重の枠・二重のカメラ)。開始中フラグで防ぐ。
let starting = false
// 「スキャン停止」ボタンでの停止はユーザーの意思なので、画面を戻っても自動再開しない
// (スキャン範囲の選択と同じく `useState` で引き継ぎ、開始ボタンで解除する)。
// 照会モードの検出後の停止(= 結果画面へ遷移するための停止)は意思ではないので自動再開する。
const userStopped = useState<boolean>('qr-scan-stopped', () => false)
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
// 重複読み取り除外(同じコードを短時間で再度読んだら無視する)。`useState` に置くのは
// スキャナーの再マウント(モード切替や、結果画面から戻ったときの自動再開)で実体が
// 作り直されるため、instance-local の lastCode/lastAt では窓がリセットされて
// 直前のQRを再読してしまうから。
const lastScan = useState<{ code: string; at: number }>('qr-last-scan', () => ({ code: '', at: 0 }))
// 連続モードの読み取り件数(記録セッションの件数とは別。読み取った回数の表示用)。
const reads = ref(0)

function statusText(): string {
  const base = mode.value === 'small'
    ? 'スキャン中… 中央の枠(25%)を内部で3倍拡大して照合しています'
    : 'スキャン中… 中央の枠(50%)を照合しています'
  // 連続モードは検出しても止めない(読み取り件数を出す)
  return props.continuous ? `${base}(連続・読み取り ${reads.value}件)` : base
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
  if (!video.value || running.value || starting) return
  starting = true
  userStopped.value = false
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
  } finally {
    starting = false
  }
}

function onDecode(result: { data: string }) {
  if (!running.value) return
  if (props.continuous) {
    // 連続モード: 検出しても stop しない(次々と読む)。
    // busy(照会・書き込み中)は積み上げない / 同じコードの短時間重複(2.5s 窓)も無視する。
    if (props.busy) return
    const code = result.data
    const now = Date.now()
    if (isSameScan(code, lastScan.value.code, lastScan.value.at, now)) return
    lastScan.value = { code, at: now }
    reads.value += 1
    status.value = statusText()
    emit('detected', code)
    return
  }
  if (handled) return
  // 照会モードも同じコードの短時間重複(2.5s 窓)は無視する。結果画面から戻ったときに
  // 手元にある同じQRをすぐ再読すると「戻る → 即結果」の往復になってしまう(次のQRを読む
  // ために画面を戻る、が想定動作なので)。
  const code = result.data
  const now = Date.now()
  if (isSameScan(code, lastScan.value.code, lastScan.value.at, now)) return
  lastScan.value = { code, at: now }
  handled = true
  stop()
  emit('detected', code)
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

/** 「スキャン停止」ボタン。ユーザーの停止なので画面を戻っても自動再開しない。 */
function stopByUser() {
  userStopped.value = true
  stop()
}

// 開始ボタン押下なしで自動起動する(ブラウザの権限ダイアログのみ表示される)。
// 自動起動が失敗した場合(ジェスチャーが必要なブラウザ等)は開始ボタンで手動開始できる。
onMounted(async () => {
  // 保存されたスキャン範囲を復元(結果画面から戻った後も選択が維持される)。
  const saved = localStorage.getItem('qr-scan-mode')
  if (saved === 'small' || saved === 'large') mode.value = saved
  // 「スキャン停止」で止めたまま画面を戻ってきたら自動再開しない(開始ボタンで解除する)。
  if (userStopped.value) {
    status.value = '停止しました。開始ボタンで再開できます。'
    return
  }
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

// 画面を戻った後の自動再開は `app/pages/scan.vue` の route watcher が scanner の再マウントで
// 扱う(keepalive の再 activated だけでは video の ref とライブラリの実体がズレて映像が流れない
// ことがあった。再マウントは既存の「記録モードの切替で再マウント」と同じ導線で一貫する)。
</script>

<template>
  <div>
    <div class="scan-box">
      <!-- 範囲とライトの制御は枠の内側(右上)。向ける先を決めている視線のすぐそこで操作する
           (行として下に並べると、制御を探す間にカメラから目が離れて QR を探しにくい)。
           aria-label でアクセシブル名を「スキャン範囲: …」にする(見た目は "50%"/"25%×3")。 -->
      <div class="scan-corners">
        <button
          class="scan-corner-btn"
          :class="{ active: mode === 'large' }"
          aria-label="スキャン範囲: 50%"
          :aria-pressed="mode === 'large'"
          :disabled="disabled"
          @click="setMode('large')"
        >50%</button>
        <button
          class="scan-corner-btn"
          :class="{ active: mode === 'small' }"
          aria-label="スキャン範囲: 25%(ズーム)"
          :aria-pressed="mode === 'small'"
          :disabled="disabled"
          @click="setMode('small')"
        >25%×3</button>
        <button
          v-if="running && flashAvailable"
          class="scan-corner-btn"
          :class="{ active: flashOn }"
          :aria-pressed="flashOn"
          @click="toggleFlash"
        >{{ flashOn ? 'ライト: ON' : 'ライト: OFF' }}</button>
      </div>
      <video ref="video" class="scan-video" playsinline muted autoplay></video>
      <!-- 枠と検出QRの輪郭はライブラリが生成する overlay(.scan-region-highlight /
           .code-outline-highlight)が描く。自前の枠は置かない。 -->
      <!-- 状態はカメラ内下部のキャプション(別行にすると小さい画面で bottom-nav に隠れる)。
           muted class は既存の検証スクリプトが .muted を見て「スキャン中」を確認するため維持 -->
      <p class="scan-status muted">{{ status }}</p>
    </div>
    <!-- 停止/開始だけカメラ直下の行に残す(範囲とライトは上の枠内トグルへ移した) -->
    <div class="mode-row">
      <button v-if="running" class="btn secondary" @click="stopByUser">スキャン停止</button>
      <button v-else class="btn" :disabled="disabled" @click="start">スキャン開始</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.scan-box {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  /* 画面の上部にカメラが来る配置(/scan)なので、空いたぶんだけ大きく見せる(上限は画面割合)。
     照合は映像解像度で行うので表示縮小は影響せず、390x640 でも停止/開始行とモード選択が
     bottom-nav の上に収まる高さにとどめる(実測は scripts/verify-camera.mjs の layout 節)。 */
  max-height: clamp(240px, 42vh, 450px);
  background: #0b1220;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 10px;
}
/* 枠の内側右上に寄せる範囲・ライトのトグル(枠の geometry はライブラリ overlay のまま) */
.scan-corners {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: flex;
  gap: 6px;
  align-items: center;
}
.scan-corner-btn {
  /* 現場は片手で端末、もう片手でQRを掲げるので、押し損ねないだけの当たりを確保する
     (カメラの写る範囲を狭めないよう、枠の内側の高さは保ったまま min-height を上げる) */
  min-height: 34px;
  padding: 6px 11px;
  border: 1px solid rgba(207, 230, 255, 0.55);
  border-radius: 999px;
  background: rgba(11, 18, 32, 0.72);
  color: #cfe6ff;
  font-size: 13px;
  line-height: 1.2;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.scan-corner-btn.active {
  border-color: #7ecbff;
  box-shadow: inset 0 0 0 1px rgba(126, 203, 255, 0.9);
}
.scan-corner-btn:disabled {
  opacity: 0.6;
}
.scan-status {
  position: absolute;
  left: 10px;
  bottom: 8px;
  margin: 0;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(11, 18, 32, 0.6);
  color: #cfe6ff;
  font-size: 13px;
  pointer-events: none;
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
  font-size: 13px;
  padding: 7px 12px;
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
