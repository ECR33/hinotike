<script setup lang="ts">
// 保護は app/middleware/auth.global.ts(グローバル+ホワイトリスト)で行う。
// ページ単位の definePageMeta({ middleware: 'auth' }) は不要になった。
// ログアウトは BottomNav(app/components/BottomNav.vue)の項目で行う(ページ内ボタンは重複のため撤去)。
// 手入力欄(テスト用)は撤去: 本番でも常に表示されていた(dev 限定の gating はなかった)。
// code を直接照会する用途は /items の一覧+code 検索が同じ役割を果たすのでそちらに寄せる。
//
// 記録モード(doc/docs/scan-modes.md): モード選択で「照会(従来)」/「配布・チェックイン・任意の記録」を切り替える。
// - 照会: 検出1回で /result へ遷移(QrScanner の既定の1回停止)。照会は**この端末のミラー**を読む
//   (通信経由のシート照合 API は無いので、取り込み済みでないと照合できない)
// - 記録(連続): 検出しても止めない。**端末ミラーの payload** で即時照合(shared/utils/offline の
//   `offlineScanCheckResponse`)→ 端末のキューに積む → 確定でシートへ書く
// - 記録(確認): 検出すると pending card(氏名・現在の状態)を出し、ボタンで記録/上書き/見送り
// - 「新しい記録を作る」でモードとシート列をその場で作れる(動的増減)。モードは**1データセットに紐づく**
//
// データセット(doc/docs/datasets.md): 作業前に「どの Spreadsheet のデータで作業するか」を決める。
// - /sync に複数の定義(public.sync_sources)を保持する。この画面の「データの取り込み」で
//   選んだ1データを端末(IndexedDB)に置き、以後の照会・一覧・記録は端末内のミラーに対して走る。
// - **スキャンの照合は端末ミラーのみ**(通信経由の照合 API は無くなった)。未取り込み(別利用者が
//   取り込んだミラーを含む)では「このデータセットをこの端末に取り込んでください」の案内を出す。
// - 記録の確定はサーバーが**その時点のシート値**を読んでから書く(他の端末の書き込みを吸収する)。
//   端末のミラーには応答の written を写す(シートが唯一の正)。
//
// 画面の並びは「スキャン運用の頻度」で決める(カメラを上に寄せる):
// - カメラ(h1 の直下)= スマホのレンズは本体上部にあるため、プレビューが画面中央だと
//   向けるべき位置とズレて QR を探しにくい。枠内右上にスキャン範囲・ライトのトグルを置く
//   (app/components/QrScanner.vue)。
// - カメラ直下: 停止/開始 → モード選択(その場で切り替える運用なのでタップ圏に残す)。
// - 管理欄(1行サマリ の details): データの取り込み/解除/削除、モードの無効化・削除、
//   新しい記録の作成、記録の設定への導線。通信の良い場所でやる管理操作なのでカメラから離す
//   (底面バーの「管理」dropdown と同じ役割の欄。閉じた高さは1行ぶんに抑える)。
// - 例外: 運用中に確認すべきもの(確認カード・端末にためた記録の banner・エラー・注記)は
//   折りたたみ外に出す。確認カードはさらに **カメラ枠の内側下部**(QrScanner の overlay slot)に
//   被せる — 枠の下に積むと小さい画面で「記録/見送り」が bottom-nav に隠れてスクロールが必要。
import { describeApiError } from '#shared/utils/apiError'
import type { ScanCheckResponse, ScanConfigResponse, ScanDedupe, ScanFlushResponse, ScanMode, ScanRecordEntry } from '#shared/utils/scan'
import { modesForSource, modeColumnsMissing, scanModeSummary, scanStatusMessage, SCAN_AUTO_FLUSH_COUNT, SCAN_FLAG_VALUE, formatJst } from '#shared/utils/scan'
import type { ImportPageResponse, SyncSource } from '#shared/utils/sync'
import type { MeState } from '#shared/utils/auth'
import { readBeepMutedFromStorage, writeBeepMutedToStorage } from '~/utils/scanBeep'
import type { OfflineItemRow } from '~/utils/offlineStore'
import { offlineClearQueue, purgeDeviceData } from '~/utils/offlineStore'
import type { OfflineFlushResponse, OfflineMeta, OfflineQueueEntry } from '#shared/utils/offline'
import { makeOfflineQueueId, mirrorBelongsToUser, offlineScanCheckResponse, OFFLINE_FLUSH_CHUNK, OFFLINE_ITEM_MAX, OFFLINE_PAGE_BATCH, OFFLINE_QUEUE_MAX } from '#shared/utils/offline'
import { parseRegistrationCode } from '#shared/utils/registration'

/**
 * ローカルデータセットでの作業(地下など電波状況の悪い場所でも使える):
 * - 「データの取り込み」で選んだデータセットのシートを `/api/import` の分页で読み、IndexedDB に保存し、
 *   localStorage に「作業中のデータセット」のメタを置く(SSR は storage を読めないので初回描画は「無効」。onMounted で有効化する)。
 * - **スキャンの照合は端末内のミラー(payload)だけ**で行う(通信経由の照合 API は無い)。取り込み済みで
 *   ない(別利用者が取り込んだミラーを含む)ときは照合できないので、取り込みを案内する。
 * - 記録の読み取りは IndexedDB のキューにためる(画面を閉じても残る)。シートへの書き込みは
 *   「ためた記録を確定」(`/api/scan-offline-flush`)で行う(取り込みを解除したぶんは `/api/scan-flush` で確定できる)。
 * - 照会(照会モード)は /result へ SPA 遷移し、/result がローカルミラーで照会する
 *   (SW が precache した JS チャンクで開くため HTML のネットワークは不要)。
 */

definePageMeta({ keepalive: true, scrollToTop: false })

/** セッションの1読み取り(画面側。flush 前 status='queued'、確定後に確定結果へ書き換える)。 */
interface SessionEntry extends ScanRecordEntry {
  /** 未確定(まだシートに書いていない)なら true */
  queued: boolean
  /** 確認モードで「上書き」を選んだなら flush に overwrite: true を送る */
  overwrite: boolean
  /** オフライン読み取りでローカルキュー(IndexedDB)にためたぶん。復旧後に /api/scan-offline-flush で確定する */
  offlineQueued?: boolean
}

const configState = useState<ScanConfigResponse | null>('scan-config', () => null)
if (configState.value === null) {
  configState.value = await $fetch<ScanConfigResponse>('/api/scan-config', {
    headers: useRequestHeaders(['cookie']),
  }).catch(() => null)
}

// ローカルデータセットの状態(useOfflineState は onMounted で localStorage のメタ + IndexedDB のキュー件数を引き当てる。
// top-level に分解するので template の自動 unwrap が効く)。SSR は storage を読めない = 初回は「未取り込み」。
// localWork は「有効フラグ + uid 一致」(この端末のデータを**取り込んだ利用者**だけ使える)。
const {
  meta: offlineMeta,
  queueCount: offlineQueueCount,
  localWork,
  uidMismatch,
  refreshQueueCount,
  refreshMeta,
} = useOfflineState()
/** 認証状態(SSR が埋め込む)。ミラーの uid と比較して別ユーザのローカル作業を無効にする。 */
const authState = useState<MeState | null>('auth-state', () => null)

/**
 * **作業中のデータセット**(どの Spreadsheet のデータで作業するか)。
 * - 取り込み済みならその id(meta.sourceId)。未取り込みは有効な最初のソース(onMounted で選ぶ)。
 * - モード選択・記録の書き込み先・ローカル照合はすべてこの id に追随する。
 * - 切替は selectSource(id): そのデータが端末にあればミラーの設定を引き直し、無ければサーバーから
 *   設定(モード一覧 + シートヘッダー)を引き直す。スキャンは取り込み済みのデータセットでしか走らない
 *   (照合は端末ミラーのみなので、取り込みボタンで端末に置いてからスキャンする)。
 */
const activeSourceId = useState<number | null>('scan-source-id', () => null)
const sources = computed<SyncSource[]>(() => configState.value?.sources ?? [])
const enabledSources = computed<SyncSource[]>(() => sources.value.filter((s) => s.enabled))
const activeSource = computed<SyncSource | null>(
  () => sources.value.find((s) => s.id === activeSourceId.value) ?? null,
)
/** 取り込み済みのデータセットで作業しているか(= ローカルミラーが作業中のソースと**その利用者**に一致する)。 */
const workingLocally = computed(
  () => localWork.value && offlineMeta.value?.sourceId === activeSourceId.value,
)

// 選択したモード(null = 照会。スキャン→結果→スキャンの往復でも選択を維持する)。
const selectedModeId = useState<number | null>('scan-mode-id', () => null)
/** モードはデータセットに紐づく(scan_modes.source_id)ので、作業中のソースのモードだけ選ぶ。 */
const modes = computed<ScanMode[]>(() => modesForSource(configState.value?.modes ?? [], activeSourceId.value))
/**
 * **全データセットのモード**(保存の送信用)。scan-config の POST は「送られたリストが正」なので、
 * 作業中のソースのモードだけ送ると他のソースのモードが消える。表示は modes(ソースで絞る)、送信は allModes。
 */
const allModes = computed<ScanMode[]>(() => configState.value?.modes ?? [])
const activeMode = computed<ScanMode | null>(() => {
  if (selectedModeId.value === null) return null
  return modes.value.find((m) => m.id === selectedModeId.value) ?? null
})
const recording = computed(() => activeMode.value !== null)

// スキャン範囲の選択は QrScanner 側が useState('qr-scan-mode') で維持する(従来まま)。
// 記録モードの切替はカメラの性質が変わるので scannerKey で再マウントする。
const scannerKey = ref(0)
function remountScanner() {
  scannerKey.value += 1
}

// keepalive の /scan は `/result`(照会結果)に開いても生存する。照会モードは検出1回で
// スキャナーを stop して結果画面へ遷移するので、**戻ったら再マウントして自動再開する**
// (`/result` の「スキャンに戻る」→ 次のQRをそのまま読みたい。開始ボタンをもう1回押させるのは
//  照会→結果の往復ごとにタップが増えるので運用に反する)。
// ユーザーが「スキャン停止」で止めた場合は QrScanner 側が `useState('qr-scan-stopped')` で
// 意思を引き継ぐので、再マウントしても開始ボタンが必要なまま(自動再開しない)。
//
// `useRoute()` は keepalive のページでは「そのページが生成されたときの route」が残るので
// watcher では遷移を拾えない(実測で発火せず)。router の afterEach(グローバルな遷移後のhook)で
// 拾い、ページが unmount されたら解除する。
const router = useRouter()
const offAfterEach = router.afterEach((to, from) => {
  if (to.path === '/scan' && from && from.path !== '/scan') remountScanner()
})
// keepalive の /scan は画面を遷移しても unmount されず deactivate されるだけなので、
// QrScanner の onBeforeUnmount が走らずカメラが裏で動き続ける(track が live のままだった)。
// 去る時に stop する(ユーザーの「スキャン停止」とは違い userStopped を立てないので、
// 戻った時の afterEach の再マウントで自動再開される — 照会→/result の往復の動作はそのまま)。
const scannerRef = ref<{ stop: () => void } | null>(null)
const offBeforeLeave = router.beforeEach((to, from) => {
  if (from && from.path === '/scan' && to.path !== '/scan') scannerRef.value?.stop()
})
onBeforeUnmount(() => {
  offAfterEach()
  offBeforeLeave()
})

const session = useState<SessionEntry[]>('scan-session', () => [])
const pending = useState<ScanCheckResponse | null>('scan-pending', () => null)
const busy = ref(false)
const errorMessage = ref<string | null>(null)
// 読み取り音の静音(QrScanner と同じ共有 state。この欄のスイッチが操作する)。
// SSR は localStorage を読めないため既定「鳴る」で描画し、onMounted で復元する(hydration mismatch 回避)。
const beepMuted = useState<boolean>('qr-scan-beep-muted', () => false)
const beepStateReady = ref(false)
onMounted(() => {
  beepMuted.value = readBeepMutedFromStorage()
  beepStateReady.value = true
})
watch(beepMuted, (muted) => writeBeepMutedToStorage(muted))
/** 静音のON/OFFはラベルに出すが、SSRの時点では復元前なので「読み取り音」だけを出す(復元後にON/OFFになる)。 */
const beepSwitchLabel = computed(() =>
  beepStateReady.value ? (beepMuted.value ? '読み取り音: OFF' : '読み取り音: ON') : '読み取り音',
)
const flushNote = ref<string | null>(null)
const offlineNote = ref<string | null>(null)
// 復旧確定(/api/scan-offline-flush)の失敗用。セッション欄の errorMessage と分ける(照会モードでもBannerに出せるようにする)
const queueError = ref<string | null>(null)

// 作業中のデータセットの初期化(SSR は storage を読めない)。取り込み済みならそのソース+設定を引き当てる。
// 未取り込みは有効な最初のソースを選ぶ(取り込み前も「どちらのデータの作業か」を明示する。スキャンは取り込み後)。
// **uid 一致**のミラーだけ復元する(別利用者が取り込んだミラーは設定の根にしない = 氏名を読ませない)。
// auth-state の uid が後から解決される(缓存 HTML を開いた等)場合は watch でやり直す。
function restoreMirrorState(): void {
  const m = readOfflineMetaFromStorage()
  if (m?.enabled && mirrorBelongsToUser(m, authState.value?.uid)) {
    // ミラーの有効時は SSR 缓存の旧設定より取り込み時のスナップショットを優先する(モードチップと欠け列注記の根)
    configState.value = m.config
    activeSourceId.value = m.sourceId
    writeActiveSourceToStorage(m.sourceId)
  } else {
    // 未取り込み・別利用者のミラー: 「この端末がどのデータの作業をしているか」の選択(破損・未設定は有効な最初のソース)
    activeSourceId.value = readActiveSourceFromStorage() ?? enabledSources.value[0]?.id ?? null
  }
  // 作業中のソースのシート実測(ヘッダー)が缓存に無いときは引き直す(欠け列注記・列作成の根)。
  if (activeSourceId.value !== null && !workingLocally.value) void refreshConfigForSource(activeSourceId.value)
}

onMounted(async () => {
  // 中央消去指示(0011)を先に apply してからミラー状態を読む(指示があればメタは消えている = 無効化側になる)
  await checkDevicePurge()
  await refreshMeta()
  restoreMirrorState()
})
watch(localWork, (ok) => {
  if (ok) restoreMirrorState()
})

/** 作業中のデータセットの設定(モード + 対象シートのヘッダー)をサーバーから引き直す。 */
async function refreshConfigForSource(sourceId: number): Promise<void> {
  try {
    const cfg = await $fetch<ScanConfigResponse>('/api/scan-config', {
      query: { sourceId },
      headers: useRequestHeaders(['cookie']),
    })
    configState.value = cfg
  } catch (e: unknown) {
    errorMessage.value = describeError(e)
  }
}

/**
 * 作業するデータセットを選ぶ。取り込み済みのソースならミラーの設定を引き直し、
 * 未取り込みのソースはサーバーから設定(モード一覧 + シートヘッダー)を読む(取り込みは別ボタン)。
 * モードはソースに紐づくので選択はリセットする(別シートのモード id を引き継がない)。
 */
async function selectSource(source: SyncSource | null): Promise<void> {
  if (!source || source.id === null) return
  activeSourceId.value = source.id
  writeActiveSourceToStorage(source.id) // ページ間(/items・/result)で同じデータの作業を続ける
  selectedModeId.value = null
  pending.value = null
  flushNote.value = null
  session.value = []
  if (localWork.value && offlineMeta.value?.sourceId === source.id) {
    configState.value = offlineMeta.value.config
  } else {
    await refreshConfigForSource(source.id)
  }
  remountScanner()
  offlineNote.value = `作業中のデータセット: "${source.name}"${
    workingLocally.value ? '(この端末に取り込み済み)' : '(未取り込み — スキャンするにはこの端末への取り込みが必要です)'
  }。記録は "${source.name}" のシートへ書き込まれます。`
}

/**
 * 読み取りごとに localStorage を sync で読む(判定を onMounted 状態に依存しないため)。SSR では null = 無効。
 * **uid 一致**も条件(別利用者のミラーでは照合しない = 取り込みの案内を出す。通信の照会経路は無い)。
 * 作業中のデータセット(`activeSourceId`)とミラーの sourceId の一致も条件(別データセットのデータで照合しない)。
 */
function offlineActive(): boolean {
  const m = readOfflineMetaFromStorage()
  return m?.enabled === true && mirrorBelongsToUser(m, authState.value?.uid) && m.sourceId === activeSourceId.value
}

function selectMode(mode: ScanMode | null) {
  selectedModeId.value = mode?.id ?? null
  pending.value = null
  errorMessage.value = null
  flushNote.value = null
  // 照会(1回停止)↔ 記録(連続)の切り替えは scanner の性質が変わるので再マウント
  remountScanner()
}

/** pending card の表示用文言(済/未 + 記録済み日時)。 */
function pendingLabel(p: ScanCheckResponse): string {
  if (p.state === '済') return `済み(${p.recordedAt || '日時不明'})`
  return '未'
}

function pushEntry(entry: SessionEntry) {
  session.value.push(entry)
  // 直近が見えれば十分(数百人のチェックインでも DOM を膨らませない)
  if (session.value.length > 200) session.value.splice(0, session.value.length - 200)
}

async function onDetected(code: string) {
  const mode = activeMode.value
  // **照合は端末ミラーのみ**(通信経由の照合 API は無い)。取り込み済み(この利用者のミラーが
  // 作業中のデータセットと一致)でなければ照合できないので、取り込みの案内を出す。
  // 照会モードは session-card が無いので `offlineNote`(データセット欄)にも同じ案内を書く。
  if (!offlineActive()) {
    const guide = `スキャンするにはこのデータセット${
      activeSource.value ? ` "${activeSource.value.name}"` : ''
    } をこの端末に取り込む必要があります(管理欄の「このデータを端末に取り込む」)。別利用者が取り込んだデータは使いません`
    errorMessage.value = guide
    offlineNote.value = guide
    return
  }
  if (!mode) {
    // 照会モード: 端末ミラーの data で /result へ SPA 遷移する(SW の precache で JS が読め、
    // /result が同じミラーを照会する。通信経由の照会は無い)
    navigateTo(`/result?code=${encodeURIComponent(code)}`)
    return
  }
  if (busy.value) return
  busy.value = true
  errorMessage.value = null
  try {
    if (mode.id === null) {
      errorMessage.value = 'ローカル作業ではまだ保存されていないモードを記録できません(先に「記録の設定」で保存してください)'
      return
    }
    if (parseRegistrationCode(code)) {
      errorMessage.value = '利用者登録用のQRです(記録対象のチケットコードをスキャンしてください)'
      return
    }
    const sourceId = offlineMeta.value?.sourceId ?? activeSourceId.value
    if (sourceId == null) {
      errorMessage.value = '作業中のデータセットが決まっていません(「データの取り込み」でデータセットを選んでください)'
      return
    }
    // 端末内のミラー(payload)で照合する。シート行の存在(sheet_missing)はローカルでは判定できない
    // (payload を鏡として扱う)。確定時のサーバーがその時点のシート値から再確定する。
    const row = await offlineGetItem(sourceId, code).catch(() => undefined)
    const checked = offlineScanCheckResponse(mode.id, mode, code, row?.payload ?? null, new Date().toISOString())
    if (mode.confirmBeforeRecord) {
      // 確認モード(チェックイン): 氏名と現在の状態を出してから確定する(誤読の安全弁。確定はサーバーが現在のシート値から行う)
      pending.value = checked
      return
    }
    // 連続モード: ok のぶんだけを待機積みにする(duplicate/skip は表示のみ)
    const queued = checked.status === 'ok'
    pushEntry({
      code: checked.code,
      status: queued ? 'ok' : checked.status,
      name: checked.name,
      written: {},
      range: null,
      at: checked.at,
      queued,
      overwrite: false,
      offlineQueued: queued,
    })
    if (queued) {
      if (offlineQueueCount.value >= OFFLINE_QUEUE_MAX) {
        errorMessage.value = `端末にためた記録が上限(${OFFLINE_QUEUE_MAX}件)に達しました。通信が戻ったら確定してください`
      } else {
        await offlineAddQueueEntry({
          id: makeOfflineQueueId(mode.id, checked.code, checked.at),
          sourceId,
          modeId: mode.id,
          modeName: mode.name,
          code: checked.code,
          status: 'ok',
          name: checked.name,
          overwrite: false,
          at: checked.at,
        })
        await refreshQueueCount()
        // 閾値では通信しない(ローカル蓄積の注記だけ出す。確定は「ためた記録を確定」で行う)
        if (session.value.filter((e) => e.offlineQueued).length >= SCAN_AUTO_FLUSH_COUNT) {
          offlineNote.value = 'ローカル作業中: 読み取りを端末にためています(通信が戻ったら「記録を確定」でシートへ書き込みます)'
        }
      }
    }
  } catch (e: unknown) {
    errorMessage.value = describeError(e)
  } finally {
    busy.value = false
  }
}

/**
 * API の失敗を画面向けの案内にする(shared/utils/apiError の理由コード → 文言)。
 * 日本語の statusMessage は h3 が status line から ASCII に落とすため、以前は
 * `400 "" ()` のような欠けた文言が出ていた。理由は `data.reason` か body の `message` で復元する。
 */
function describeError(e: unknown): string {
  return describeApiError(e).friendly
}

/** 未確定の読み取りをまとめてシートへ書く(/api/scan-flush)。書き込み先は作業中のデータセットのシート。 */
async function flush() {
  // ローカル作業中は通信しない(端末にためて、任意のタイミングの「記録を確定」で書く)
  if (offlineActive()) {
    offlineNote.value = 'ローカル作業中はシートに書き込みません(通信が戻ったら「端末にためた記録を確定」で書き込みます)'
    return
  }
  const mode = activeMode.value
  const queuedEntries = session.value.filter((e) => e.queued)
  if (!mode || queuedEntries.length === 0) return
  busy.value = true
  errorMessage.value = null
  try {
    const res = await $fetch<ScanFlushResponse>('/api/scan-flush', {
      method: 'POST',
      body: {
        modeId: mode.id,
        codes: queuedEntries.map((e) => ({ code: e.code, overwrite: e.overwrite })),
      },
    })
    const byCode = new Map(res.results.map((r) => [r.code, r]))
    for (const entry of session.value) {
      if (!entry.queued) continue
      const result = byCode.get(entry.code)
      if (!result) continue
      entry.status = result.status
      entry.written = result.written
      entry.range = result.range
      entry.at = result.at
      entry.queued = false
      entry.overwrite = false
    }
    // 端末ミラー(this data set の IndexedDB)に書き込んだ値を反映する(シートが正。一覧・照会が即追随する)
    const mirror = activeSourceId.value
    if (mirror !== null) {
      for (const r of res.results) {
        if (r.status !== 'ok' && r.status !== 'duplicate') continue
        await offlineMergePayload(mirror, r.code, r.written).catch(() => {})
      }
    }
    flushNote.value = `${res.wrote}件をシートに書き込みました(${res.sheetTitle})${res.auditWritten ? '' : ' ※記録履歴の保存に失敗したぶんがあります(シートは保存済み)'}`
    // flush は通信のタイミングなので中央消去指示(0011)もここで apply する
    if (await checkDevicePurge()) {
      await refreshMeta()
      await refreshQueueCount()
      restoreMirrorState()
    }
  } catch (e: unknown) {
    errorMessage.value = describeError(e)
  } finally {
    busy.value = false
  }
}

/**
 * 確認モードの確定(記録 / 上書き / 見送り)。取り込み済みなら端末のキューにためて「ためた記録を確定」で
 * シートへ書く。取り込みを解除した後の未確定ぶんはここで `/api/scan-flush` を叩いてその場で確定する
 * (pending card が出るのは取り込み済みのスキャンだけなので、通常はキュー側が進む)。
 */
function confirmRecord(overwrite: boolean) {
  const p = pending.value
  if (!p) return
  const mode = activeMode.value
  const offlineMode = offlineActive()
  const status: ScanRecordEntry['status'] = p.status === 'duplicate' ? 'duplicate' : 'ok'
  pushEntry({
    code: p.code,
    status,
    name: p.name,
    written: {},
    range: null,
    at: p.at,
    queued: true,
    overwrite,
    offlineQueued: offlineMode,
  })
  pending.value = null
  remountScanner()
  if (offlineMode) {
    const sourceId = offlineMeta.value?.sourceId ?? activeSourceId.value
    if (mode?.id != null && sourceId != null) {
      void offlineAddQueueEntry({
        id: makeOfflineQueueId(mode.id, p.code, p.at),
        sourceId,
        modeId: mode.id,
        modeName: mode.name,
        code: p.code,
        status: 'ok', // 確定時のサーバーが現在のシート値から ok/duplicate/skipped を再確定する
        name: p.name,
        overwrite,
        at: p.at,
      }).then(() => refreshQueueCount())
    }
    offlineNote.value = 'ローカル作業: 氏名を確認して端末に記録しました(通信が戻ったら「端末にためた記録を確定」でシートへ書き込みます)'
    return
  }
  // 確認モードは「確認ボタンで1件を確定する」運用なので、その場で flush する
  // (5件ためる連続モードの閾値だと、確認したのにシートに書されない状態になる)。
  if (activeMode.value?.confirmBeforeRecord || session.value.filter((e) => e.queued).length >= SCAN_AUTO_FLUSH_COUNT) {
    void flush()
  }
}

function dismissPending() {
  pending.value = null
  remountScanner()
}

// ── データの取り込み・ローカル作業の解除・ためた記録の確定 ──────

const prepBusy = ref(false)
const prepProgress = ref('')
const prepError = ref<string | null>(null)

/**
 * ミラーのメタに写す **uid**(取り込んだ利用者)。auth-state が未解決なら `/api/me` で引く
 * (通信が無い・解決できないときは null = 取り込みしない。uid 無いメタは別ユーザが読めるので置かない)。
 */
async function currentUid(): Promise<string | null> {
  const known = authState.value?.uid
  if (known) return known
  try {
    const me = await $fetch<MeState>('/api/me')
    authState.value = me
    return me.uid
  } catch {
    return null
  }
}

/**
 * **データの取り込み**: 指定データセットのシートを `/api/import` の分页で読み、IndexedDB のミラーを
 * そのデータセットで置き換えて、localStorage のメタを ON にする(= 以後の照会・一覧・記録は端末内のデータに対して走る)。
 * ミラーは**1データセットだけ**(別のデータセットを取り込むと前の行は消える = 「今どちらの作業か」は1つ)。
 * SW の NetworkFirst にもページ(/ と /scan・/items)の HTML をためる(通信が無い時の起動用)。
 */
async function importDataset(source: SyncSource | null): Promise<void> {
  if (prepBusy.value) return
  if (!source || source.id === null) {
    prepError.value = '取り込みするデータセットを選んでください(/sync で定義を追加できます)'
    return
  }
  const sourceId = source.id
  const uid = await currentUid()
  if (!uid) {
    prepError.value = 'ログイン情報が解決できないため取り込みできません(再ログインしてから通信の良い場所で実行してください)'
    return
  }
  prepBusy.value = true
  prepError.value = null
  offlineNote.value = null
  prepProgress.value = 'シートを読み込み中…'
  try {
    // 取り込み時の設定(モード一覧 + 対象シートのヘッダー)をこのソースで引き直す
    const cfg = await $fetch<ScanConfigResponse>('/api/scan-config', {
      query: { sourceId },
      headers: useRequestHeaders(['cookie']),
    })
    configState.value = cfg
    const rows: OfflineItemRow[] = []
    let cursor = ''
    let capped = false
    let sheetTitle = ''
    // 取り込み時の purge_epoch(/api/import が応答に載せる。0011 の消去指示比較の基準)
    let purgeEpoch = 0
    for (;;) {
      const page = await $fetch<ImportPageResponse>('/api/import', {
        query: { sourceId, limit: OFFLINE_PAGE_BATCH, ...(cursor ? { cursor } : {}) },
      })
      sheetTitle = page.sheetTitle
      purgeEpoch = page.purgeEpoch ?? 0
      rows.push(...page.rows.map((r) => ({ code: r.code, payload: r.payload, sourceId })))
      prepProgress.value = `${rows.length}/${page.total ?? rows.length}件 を取り込み中…`
      if (!page.nextCursor) break
      if (rows.length >= OFFLINE_ITEM_MAX) {
        capped = true
        break
      }
      cursor = page.nextCursor
    }
    const meta: OfflineMeta = {
      enabled: true,
      sourceId,
      uid,
      sourceName: source.name,
      source,
      snapshotAt: new Date().toISOString(),
      itemCount: rows.length,
      config: cfg,
      capped,
      purgeEpoch,
    }
    await offlineSaveSnapshot(meta, rows)
    writeOfflineMetaToStorage(meta)
    offlineMeta.value = meta
    activeSourceId.value = sourceId
    selectedModeId.value = null
    await refreshQueueCount()
    // ローカル作業起動用のページキャッシュをためる(SW が NetworkFirst で缓存。dev では SW が無いので素通し)
    await fetch('/scan').catch(() => {})
    await fetch('/').catch(() => {})
    await fetch('/items').catch(() => {})
    offlineNote.value = `取り込み完了: "${source.name}"(${sheetTitle}) ${rows.length}件${capped ? `、上限 ${OFFLINE_ITEM_MAX}件で打ち切り` : ''}・モード ${cfg.modes.length}個。通信がなくてもスキャン・照会・チェックイン・items一覧が使えます。`
  } catch (e: unknown) {
    prepError.value = describeError(e)
  } finally {
    prepBusy.value = false
    prepProgress.value = ''
  }
}

/**
 * ローカル作業の解除: フラグだけ OFF(ミラーとためた記録は残る。再取り込みで更新できる)。
 * 解除するとスキャンは照合できないので「このデータセットをこの端末に取り込んでください」の案内が出る
 * (通信経由の照合は無い。ためた記録の確定は解除してもできる = 「ためた記録を確定」)。
 */
function disableOffline() {
  const m = offlineMeta.value
  if (!m) return
  const next: OfflineMeta = { ...m, enabled: false }
  writeOfflineMetaToStorage(next)
  offlineMeta.value = next
}

/**
 * **この端末のデータを完全に削除**: ミラー(items+meta)・localStorage のメタとデータセット選択・
 * SW のページキャッシュ(氏名・email が載った缓存 HTML)を捨てる。ためた記録は捨てず、
 * **氏名だけ除去**して code / modeId / at を残す(通信が戻れば確定できる)。
 */
async function deleteOfflineData() {
  try {
    const { strippedNames, queueKept } = await purgeDeviceData()
    offlineMeta.value = null
    offlineQueueCount.value = queueKept
    discardArmed.value = false
    offlineNote.value =
      `この端末のデータを削除しました(取り込みデータとページキャッシュを消しました)${
        strippedNames > 0 ? ` / ためた記録 ${strippedNames}件の氏名を除去しました` : ''
      }${queueKept > 0 ? ` / ためた記録 ${queueKept}件は code として残ります(確定できます)` : ''}`
  } catch (e: unknown) {
    prepError.value = describeError(e)
  }
}

/** ためた記録の待機をすべて捨てる(未確定の記録はシートに書かれないまま消える)。2段階確認で実行する。 */
const discardArmed = ref(false)
async function discardQueue() {
  if (!discardArmed.value) {
    discardArmed.value = true
    queueError.value = `ためた記録 ${offlineQueueCount.value}件を捨てます(シートには書き込まれません)。もう一度「すべて捨てる」で実行`
    return
  }
  const dropped = offlineQueueCount.value
  try {
    await offlineClearQueue()
    await refreshQueueCount()
    discardArmed.value = false
    queueError.value = null
    offlineNote.value = `ためた記録 ${dropped}件を捨てました(シートに書き込みませんでした)`
  } catch (e: unknown) {
    queueError.value = describeError(e)
  }
}

/**
 * ためた記録の確定: キューを modeId でグループ化し、1モードごとに chunk(≤ OFFLINE_FLUSH_CHUNK)で
 * `/api/scan-offline-flush` に送る。サーバーはその時点のシートを読み直して行位置と現在の状態を確定し、
 * シートの日時・証跡には端末での読み取り時刻(at)がそのまま載る。write_failed はキューに残す(もう一度確定できる)。
 * ローカル作業の ON/OFF とは独立(接続が戻っていれば書ける。戻らなければ $fetch が失敗しキューはそのまま残る)。
 */
async function flushOfflineQueue() {
  if (busy.value) return
  const entries = await offlineListQueue().catch(() => [])
  if (entries.length === 0) {
    await refreshQueueCount()
    return
  }
  busy.value = true
  errorMessage.value = null
  queueError.value = null
  try {
    const groups = new Map<number, OfflineQueueEntry[]>()
    for (const e of entries) {
      const part = groups.get(e.modeId)
      if (part) part.push(e)
      else groups.set(e.modeId, [e])
    }
    let wrote = 0
    let skipped = 0
    let failed = 0
    const doneIds: string[] = []
    for (const [modeId, part] of groups) {
      for (let from = 0; from < part.length; from += OFFLINE_FLUSH_CHUNK) {
        const chunk = part.slice(from, from + OFFLINE_FLUSH_CHUNK)
        const res = await $fetch<OfflineFlushResponse>('/api/scan-offline-flush', {
          method: 'POST',
          body: {
            entries: chunk.map((e) => ({ modeId: e.modeId, code: e.code, at: e.at, overwrite: e.overwrite })),
          },
        })
        const byKey = new Map(res.results.map((r) => [`${r.modeId}|${r.code}`, r]))
        for (const e of chunk) {
          const r = byKey.get(`${e.modeId}|${e.code}`)
          if (!r || r.status === 'write_failed') {
            failed += 1
            continue
          }
          doneIds.push(e.id)
          if (r.status === 'ok' || r.status === 'duplicate') wrote += 1
          else skipped += 1
          // 端末ミラーに書き込んだ値を反映する(シートが正。取り込み済みのデータなら一覧・照会が即追随する)
          if (r.written && Object.keys(r.written).length > 0) {
            await offlineMergePayload(e.sourceId, e.code, r.written).catch(() => {})
          }
          // セッション欄の該当行を確定結果に書き換える(`/api/scan-flush` の確定と同じ扱い)
          for (const s of session.value) {
            if (s.offlineQueued && s.code === e.code && s.at === e.at) {
              s.status = r.status
              s.written = r.written
              s.range = r.range
              s.at = r.at
              s.queued = false
              s.offlineQueued = false
              s.overwrite = false
            }
          }
        }
      }
    }
    await offlineRemoveQueueEntries(doneIds)
    await refreshQueueCount()
    discardArmed.value = false
    // 成功注記は offlineNote(データセット欄に出す)。Banner はキュー 0 だと消えるので注記置き場にしない
    offlineNote.value =
      `確定: ${wrote}件をシートに書き込みました${skipped > 0 ? ` / 既に済だった ${skipped}件は書き込みませんでした` : ''}${failed > 0 ? ` / 失敗 ${failed}件は再確定できます` : ''}${offlineQueueCount.value > 0 ? ` / 端末に残り ${offlineQueueCount.value}件` : ''}`
    // 確定は通信のタイミングなので中央消去指示(0011)もここで apply する(指示があればそのデータセットのミラーを捨てる)
    if (await checkDevicePurge()) {
      await refreshMeta()
      await refreshQueueCount()
      restoreMirrorState()
      offlineNote.value = `${offlineNote.value} / イベント終了の消去指示が出ていたためこのデータセットの端末コピーを捨てました`
    }
  } catch (e: unknown) {
    queueError.value = describeError(e)
  } finally {
    busy.value = false
  }
}

// ── 新しい記録を作る(モード + シート列をその場で作れる)──────────

// 管理欄の中の「新しい記録を作る」はネストした details(折りたたみ)。作成できたら閉じて
// 管理欄をcompactに戻す(open は DOM 側の状態なので ref で触る)。
const createDetails = ref<HTMLDetailsElement | null>(null)
const newName = ref('')
const newFlagColumn = ref('')
const newAtColumn = ref('')
const newConfirm = ref(false)
const newDedupe = ref<ScanDedupe>('warn')
const newAddColumns = ref(true)
const createBusy = ref(false)
const createError = ref<string | null>(null)
const createNote = ref<string | null>(null)

async function createMode() {
  const name = newName.value.trim()
  const flag = newFlagColumn.value.trim()
  const at = newAtColumn.value.trim()
  if (!name || !flag) {
    createError.value = 'モード名と済/未カラム名が必要です'
    return
  }
  createBusy.value = true
  createError.value = null
  createNote.value = null
  try {
    // 1) シート列を作る(作業中のデータセットのシート。列が既にあれば existing で返る。取り込みカラムへの追記も選ぶ)
    if (newAddColumns.value) {
      const columns = flag && at ? [flag, at] : [flag]
      const res = await $fetch<{ created: string[]; existing: string[]; includeColumnsUpdated: boolean }>('/api/scan-columns', {
        method: 'POST',
        body: { columns, sourceId: activeSourceId.value, addToIncludeColumns: true },
      })
      createNote.value = `シート列: 追加 ${res.created.join(', ') || 'なし'} / 既存 ${res.existing.join(', ') || 'なし'}${res.includeColumnsUpdated ? ' / 取り込みカラムに追加しました' : ''}`
    }
    // 2) モードを保存(**全データセットのモード**に新モードを足して送る = リストが正。
    //    表示は作業中のソースのモードだけなので、ソース別のモードを消さないために全件を送る)
    const newMode: Partial<ScanMode> = {
      name,
      sourceId: activeSourceId.value,
      actions: [{ column: flag, columnAt: at, literal: SCAN_FLAG_VALUE, payloadKey: flag, payloadAtKey: at }],
      dedupe: newDedupe.value,
      confirmBeforeRecord: newConfirm.value,
      requireFound: true,
      enabled: true,
    }
    const res = await $fetch<ScanConfigResponse>('/api/scan-config', {
      method: 'POST',
      body: { modes: [...allModes.value, newMode], sourceId: activeSourceId.value },
    })
    configState.value = res
    const created = res.modes.find((m) => m.name === name)
    if (created) {
      selectedModeId.value = created.id
      session.value = []
      pending.value = null
      remountScanner()
      if (createDetails.value) createDetails.value.open = false
      newName.value = ''
      newFlagColumn.value = ''
      newAtColumn.value = ''
    }
  } catch (e: unknown) {
    createError.value = describeError(e)
  } finally {
    createBusy.value = false
  }
}

/** 選択中のモードを無効化/有効化(履歴のあるモードは削除できないので無効化で隠す)。 */
async function toggleActiveModeEnabled() {
  const mode = activeMode.value
  if (!mode || mode.id === null) return
  busy.value = true
  try {
    const next = allModes.value.map((m) => (m.id === mode.id ? { ...m, enabled: !m.enabled } : m))
    const res = await $fetch<ScanConfigResponse>('/api/scan-config', { method: 'POST', body: { modes: next } })
    configState.value = res
    if (!res.modes.find((m) => m.id === mode.id)?.enabled) selectMode(null)
  } catch (e: unknown) {
    errorMessage.value = describeError(e)
  } finally {
    busy.value = false
  }
}

/** 選択中のモードを削除(記録履歴があるモードは API が 400 を返す)。 */
async function deleteActiveMode() {
  const mode = activeMode.value
  if (!mode || mode.id === null) return
  busy.value = true
  try {
    const next = modes.value.filter((m) => m.id !== mode.id)
    const res = await $fetch<ScanConfigResponse>('/api/scan-config', { method: 'POST', body: { modes: next } })
    configState.value = res
    selectMode(null)
  } catch (e: unknown) {
    errorMessage.value = describeError(e)
  } finally {
    busy.value = false
  }
}

const queuedCount = computed(() => session.value.filter((e) => e.queued).length)
const okCount = computed(() => session.value.filter((e) => e.status === 'ok' && !e.queued).length)
const duplicateCount = computed(() => session.value.filter((e) => e.status === 'duplicate').length)
const problemCount = computed(() => session.value.filter((e) => e.status === 'not_found' || e.status === 'sheet_missing' || e.status === 'write_failed').length)
const modeChips = computed(() => modes.value.filter((m) => m.enabled))
/** 選択中のモードの「何を記録するか」の表示(照会モードのときは空)。 */
const activeSummary = computed(() => (activeMode.value ? scanModeSummary(activeMode.value) : ''))
/** 選択中のモードの列がシートに無いときのスキャンは 400 になるので、先に注記を出す(設定画面の導線)。 */
const activeMissingColumns = computed(() =>
  activeMode.value ? modeColumnsMissing(activeMode.value, configState.value?.sheetHeaders ?? null) : [],
)
</script>

<template>
  <div class="page">
    <h1>{{ recording ? activeMode?.name : 'QRコードを読む' }}</h1>

    <!-- 画面の最上部にカメラ(h1 の次)。スマホのレンズは本体上部にあるので、プレビューが
         画面中央だと向けるべき位置とズレて QR を探しにくい。スキャン範囲とライトのトグルは
         カメラ枠の内側(右上)にまとめている(app/components/QrScanner.vue) -->
    <div class="card">
      <QrScanner
        ref="scannerRef"
        :key="scannerKey"
        :continuous="recording"
        :busy="busy || (recording && pending !== null)"
        @detected="onDetected"
      >
        <!-- 確認モードの pending card はカメラ枠の内側下部に被せる(枠のすぐそこで記録/見送りを選ぶ)。
             枠の下に積むと小さい画面でカードが bottom-nav に隠れてスクロールが必要だった
             (実測 390x640 で158px隠れ)。確認中はスキャンが busy なのでプレビューを覆う実害はなく、
             記録/見送りを押すと枠がそのまま復帰して次のQRを読める。 -->
        <template #overlay v-if="pending">
          <div class="pending-card" role="status" aria-live="polite">
            <p class="pending-name">{{ pending.name || '(氏名不明)' }}</p>
            <p class="pending-code">{{ pending.code }}</p>
            <p class="pending-state">{{ pendingLabel(pending) }}</p>
            <div class="mode-row pending-actions">
              <button class="btn" :disabled="busy" @click="confirmRecord(false)">記録</button>
              <button v-if="pending.status === 'duplicate'" class="btn secondary" :disabled="busy" @click="confirmRecord(true)">上書き</button>
              <button class="btn secondary" @click="dismissPending">見送り</button>
            </div>
          </div>
        </template>
      </QrScanner>
    </div>

    <!-- データセット選択(どの Spreadsheet のデータで作業するか)。記録は選んだデータのシートへ書き込まれる。
         取り込み済みのデータは端末内のミラーで照会・記録するので通信が要らない(chip に ✓端末 を出す) -->
    <div class="mode-row chip-row" role="group" aria-label="作業するデータセット">
      <button
        v-for="source in enabledSources"
        :key="source.id ?? source.name"
        class="btn secondary"
        :class="{ active: source.id === activeSourceId }"
        @click="selectSource(source)"
      >{{ source.name }}<span v-if="localWork && offlineMeta?.sourceId === source.id"> ✓端末</span></button>
      <button class="btn secondary" :disabled="prepBusy || activeSource === null" @click="importDataset(activeSource)">
        {{ prepBusy ? `取り込み中… ${prepProgress}` : 'このデータを端末に取り込む' }}
      </button>
    </div>
    <p v-if="sources.length === 0" class="error">
      データセットがありません。「データの設定」(/sync)でスプレッドシートを追加してください。
    </p>
    <p v-if="activeSource" class="muted">
      作業中のデータ: {{ activeSource.name }} / シート {{ configState?.sheetTitle ?? '未読' }}
      {{ workingLocally ? '(この端末に取り込み済み)' : '(未取り込み — スキャンするにはこの端末への取り込みが必要です)' }}
    </p>

    <!-- モード選択(照会 + 記録モード)。無効化されたモードは出さない。compact(chip-row)で高さを節約し、
         カメラのすぐ下のタップ圏に置く(「新しい記録を作る」「記録の設定」は管理欄へ移した) -->
    <div class="mode-row chip-row" role="group" aria-label="スキャンのモード">
      <button
        class="btn secondary"
        :class="{ active: !recording }"
        @click="selectMode(null)"
      >照会</button>
      <button
        v-for="mode in modeChips"
        :key="mode.name"
        class="btn secondary"
        :class="{ active: recording && mode.id === activeMode?.id }"
        @click="selectMode(mode)"
      >{{ mode.name }}</button>
    </div>
    <!-- 選んだモードの列がシートのヘッダーに無いとスキャンが 400 になるため、先に注記を出す(管理欄に設定画面の導線) -->
    <p v-if="activeMissingColumns.length" class="error">
      このモードの列がシートにありません: {{ activeMissingColumns.join(', ') }}
      (「管理」欄の「記録の設定」で列を追加してからスキャンしてください)
    </p>

    <!-- 「何を記録するか」の要約はスキャン開始に不要なのでカメラの下に出す(確認カードは枠内) -->
    <p v-if="recording" class="muted">{{ activeSummary }}</p>

    <!-- 端末にためた記録(通信が戻ったらシートへ書き込む)。未確定のデータへの注意なので管理欄(折りたたみ)の外に残す -->
    <div v-if="offlineQueueCount > 0" class="card offline-card">
      <p>この端末にためた記録 {{ offlineQueueCount }}件(通信が戻ったらシートへ書き込みます)</p>
      <div class="mode-row">
        <!-- ローカル作業の ON/OFF とは独立: 接続が戻っていれば確定できる(戻っていなければ失敗し、キューは残る) -->
        <button class="btn" :disabled="busy" @click="flushOfflineQueue">ためた記録を確定({{ offlineQueueCount }}件)</button>
        <!-- 捨てるは2段階確認(1回目で案内、2回目で実行)。未確定の記録はシートに書かれないまま消える -->
        <button class="btn secondary danger" :disabled="busy" @click="discardQueue">
          {{ discardArmed ? `本当に捨てる(${offlineQueueCount}件)` : 'ためた記録をすべて捨てる' }}
        </button>
      </div>
      <p v-if="queueError" class="error">{{ queueError }}</p>
    </div>

    <!-- この端末のミラーは別利用者が取り込んだもの(氏名・備考を含む)。この画面では使わない旨を外に出す -->
    <div v-if="uidMismatch" class="error card">
      この端末のデータは別の利用者が取り込んだものです(氏名・備考を含むためここでは使いません)。
      通信のある場所で自分のログインで取り込み直すか、管理欄の「端末のデータを完全に削除」で捨ててください。
    </div>

    <!-- 記録セッション(モードの無効化・削除は管理欄へ移した。ここは「書く」操作だけ) -->
    <div v-if="recording" class="card session-card">
      <p class="muted">
        このセッション: 記録 {{ okCount }}件 / 重複 {{ duplicateCount }}件 / 問題 {{ problemCount }}件 / 未確定 {{ queuedCount }}件
      </p>
      <div class="mode-row">
        <button class="btn" :disabled="busy || queuedCount === 0" @click="flush">
          {{ queuedCount > 0 ? `書き込みを確定(${queuedCount}件)` : '書き込みを確定' }}
        </button>
        <NuxtLink class="btn secondary" to="/records">記録履歴</NuxtLink>
      </div>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
      <p v-if="flushNote" class="muted">{{ flushNote }}</p>
      <ul class="session-list">
        <li v-for="entry in session.slice(-40)" :key="`${entry.code}-${entry.at}`">
          <span class="session-name">{{ entry.name || entry.code }}</span>
          <span class="session-status">{{ entry.queued ? (entry.offlineQueued ? '未確定(ローカル)' : '未確定') : scanStatusMessage(entry.status) }}</span>
          <span class="session-at">{{ formatJst(entry.at) }}</span>
          <span v-if="entry.range" class="session-range">{{ entry.range }}</span>
        </li>
      </ul>
      <p v-if="session.length === 0" class="muted">まだ読み取りがありません。カメラでチケットのQRを次々とスキャンしてください。</p>
    </div>
    <!-- 管理欄: 通信の良い場所・スキャンの合間にやる操作を1行サマリの折りたたみにまとめる
         (データの取り込み/解除/削除・このモードの無効化/削除・新しい記録を作る・記録の設定) -->
    <details class="card admin-card offline-card">
      <summary class="offline-summary">
        管理 — 端末内のデータ: {{ offlineMeta?.enabled ? (uidMismatch ? `別利用者のデータ(この画面では使用しません)` : `有効("${offlineMeta.sourceName}" 取り込み ${formatJst(offlineMeta.snapshotAt)}・${offlineMeta.itemCount}件${offlineMeta.capped ? `、上限 ${OFFLINE_ITEM_MAX}件で打ち切り` : ''})`) : '未取り込み(通信の良い場所で取り込む)' }}
      </summary>

      <h2>データの取り込み(この端末で作業する)</h2>
      <p v-if="offlineMeta?.enabled" class="offline-desc">
        "{{ offlineMeta.sourceName }}" をこの端末に持っています。スキャン・照会・記録・items一覧は通信を使いません。記録は通信が戻ったら「ためた記録を確定」でそのシートへ書き込みます。
      </p>
      <p v-else class="offline-desc">
        通信の良い場所で「このデータを端末に取り込む」を押すと、作業中のデータセットのシートをこの端末に保存します。**スキャンの照合はこの端末の取り込みデータで行うので、取り込むまではこのデータセットではスキャンできません**。取り込み済みなら地下などでもスキャン・照会・チェックインが使え、記録は通信が戻ったら「ためた記録を確定」でそのシートへ書き込みます。
      </p>
      <div class="mode-row">
        <button class="btn" :disabled="prepBusy || activeSource === null" @click="importDataset(activeSource)">{{ prepBusy ? `取り込み中… ${prepProgress}` : 'このデータを端末に取り込む' }}</button>
        <button v-if="offlineMeta?.enabled" class="btn secondary" @click="disableOffline">ローカル作業を解除</button>
        <!-- ミラー + localStorage + ページキャッシュをまとめて捨てる(ためた記録は氏名だけ除去して残す) -->
        <button v-if="offlineMeta?.enabled" class="btn secondary danger" @click="deleteOfflineData">端末のデータを完全に削除</button>
        <NuxtLink class="btn secondary" to="/sync">データの設定</NuxtLink>
      </div>
      <p v-if="prepError" class="error">{{ prepError }}</p>
      <!-- 注記(取り込み完了・ローカル記録など)はこの欄の中で出す(閉じている間はカメラを押し下げない) -->
      <p v-if="offlineNote" class="offline-desc offline-note-line">{{ offlineNote }}</p>

      <h2>読み取り音</h2>
      <p class="offline-desc">
        QRが読めた瞬間に短い「ピッ」を鳴らす(合成音なので通信不要 = オフラインでも鳴る。同じQRを2.5秒以内に再読したときは鳴らない)。選び方はこの端末に記憶する。
      </p>
      <div class="mode-row">
        <button class="btn secondary" :aria-pressed="!beepMuted" @click="beepMuted = !beepMuted">{{ beepSwitchLabel }}</button>
      </div>

      <h2>スキャンしているモード</h2>
      <p v-if="!recording" class="offline-desc">照会モードです(記録モードを選ぶと、ここにモードの操作が出ます)。</p>
      <div class="mode-row">
        <button class="btn secondary" :disabled="busy || !recording" @click="toggleActiveModeEnabled">
          {{ activeMode?.enabled ? 'このモードを無効化' : 'このモードを有効化' }}
        </button>
        <button class="btn secondary danger" :disabled="busy || !recording" @click="deleteActiveMode">このモードを削除</button>
        <NuxtLink class="btn secondary" to="/records">記録履歴</NuxtLink>
        <NuxtLink class="btn secondary" to="/scan-settings">記録の設定</NuxtLink>
      </div>

      <!-- 新しい記録を作る(モード + シート列。列が無ければここで追加できる)。
           管理欄の中でもさらに折りたたみ(1行サマリ)にして、通常は高さを出さない -->
      <details ref="createDetails" class="sub-details">
        <summary>新しい記録を作る(モードとシートの列をその場で追加)</summary>
        <div class="create-card">
          <div class="create-grid">
            <ClearableInput v-model="newName" label="記録の名前" placeholder="例: ボランティア確認" />
            <ClearableInput v-model="newFlagColumn" label="済/未を書くカラム" placeholder="例: 確認済" />
            <ClearableInput v-model="newAtColumn" label="日時を書くカラム(任意)" placeholder="例: 確認日時" />
          </div>
          <div class="mode-row">
            <button class="btn secondary" :class="{ active: newConfirm }" @click="newConfirm = !newConfirm">
              {{ newConfirm ? '氏名を確認してから記録' : '連続で次々と記録' }}
            </button>
            <button class="btn secondary" :class="{ active: newDedupe === 'warn' }" @click="newDedupe = 'warn'">重複: 警告</button>
            <button class="btn secondary" :class="{ active: newDedupe === 'skip' }" @click="newDedupe = 'skip'">重複: 記録しない</button>
            <button class="btn secondary" :class="{ active: newDedupe === 'allow' }" @click="newDedupe = 'allow'">重複: 上書き</button>
          </div>
          <button class="btn secondary" :class="{ active: newAddColumns }" @click="newAddColumns = !newAddColumns">
            {{ newAddColumns ? 'シートの列を追加する(取り込みカラムにも追加)' : '既存の列だけ使う' }}
          </button>
          <p v-if="createError" class="error">{{ createError }}</p>
          <p v-if="createNote" class="muted">{{ createNote }}</p>
          <button class="btn" :disabled="createBusy" @click="createMode">{{ createBusy ? '作成中…' : '作成してスキャン開始' }}</button>
        </div>
      </details>
    </details>
  </div>
</template>

<style scoped>
.mode-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.mode-row .btn {
  font-size: 14px;
}
/* モード選択行(画面上部)は compact にして高さを節約し、カメラをスクロールなしで見せる */
.chip-row .btn {
  font-size: 13px;
  padding: 7px 12px;
}
.mode-row .btn.active {
  box-shadow: inset 0 0 0 2px rgba(120, 190, 255, 0.8);
}
.mode-row .btn.danger {
  color: var(--danger);
}
.create-card {
  margin: 10px 0 0;
}
.create-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
  margin-bottom: 10px;
}
.create-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--muted);
}
/* 確認カードは QrScanner の overlay slot(枠の内側下部)の中に出すので、枠内の余白だけ扱う */
.pending-card {
  margin: 0;
}
.pending-actions {
  margin-bottom: 0;
}
/* code は .muted class を使わない(検証スクリプトは「画面上の最初の .muted」をカメラの状態行として読む) */
.pending-code {
  font-size: 13px;
  color: var(--muted);
  margin: 0 0 4px;
}
.offline-card {
  margin-bottom: 12px;
}
/* 折りたたみ(details)の1行サマリ。閉じたときは状態だけ見え、カメラの高さを確保する */
.offline-card summary {
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.offline-card summary:hover {
  color: var(--accent);
}
.offline-card p {
  font-size: 14px;
  margin: 0 0 8px;
}
/* 管理欄(admin-card)の見出し。栏の中でもcompactな1行にして縦に伸ばさない */
.admin-card h2 {
  font-size: 14px;
  margin: 14px 0 6px;
  color: var(--accent);
}
.admin-card h2:first-of-type {
  margin-top: 10px;
}
/* 管理欄の中のネストした折りたたみ(新しい記録を作る) */
.sub-details {
  margin-top: 14px;
  border-top: 1px solid #1f2b3d;
  padding-top: 10px;
}
.sub-details > summary {
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.sub-details > summary:hover {
  color: var(--accent);
}
.sub-details .mode-row:last-of-type {
  margin-bottom: 10px;
}
/* 説明文は muted class を使わない(検証スクリプトや将来のコードが画面上の最初の .muted を
   「スキャン中」の状態行として読むため、カメラの状態行より上に .muted を置かない) */
.offline-desc {
  font-size: 14px;
  color: var(--muted);
  margin: 0 0 8px;
}
.offline-card[open] summary {
  margin-bottom: 8px;
}
/* 注記(準備完了・ローカル記録など)は管理欄の中の1行(閉じている間はカメラを押し下げない) */
.offline-note-line {
  font-size: 12px;
  margin: 8px 0 0;
}
.pending-name {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 4px;
}
.pending-state {
  margin: 6px 0 10px;
  color: var(--accent);
}
.session-card {
  margin-bottom: 12px;
}
.session-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.session-list li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 14px;
  border-bottom: 1px solid #1f2b3d;
  padding-bottom: 5px;
}
.session-name {
  font-weight: 600;
}
.session-status {
  color: var(--accent);
}
.session-at,
.session-range {
  color: var(--muted);
  font-size: 12px;
}
</style>
