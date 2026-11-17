<script setup lang="ts">
// 保護は app/middleware/auth.global.ts(グローバル+ホワイトリスト)で行う。
// ページ単位の definePageMeta({ middleware: 'auth' }) は不要になった。
// ログアウトは BottomNav(app/components/BottomNav.vue)の項目で行う(ページ内ボタンは重複のため撤去)。
// 手入力欄(テスト用)は撤去: 本番でも常に表示されていた(dev 限定の gating はなかった)。
// code を直接照会する用途は /items の一覧+code 検索が同じ役割を果たすのでそちらに寄せる。
//
// 記録モード(doc/docs/scan-modes.md): モード選択で「照会(従来)」/「配布・チェックイン・任意の記録」を切り替える。
// - 照会: 検出1回で /result へ遷移(QrScanner の既定の1回停止)
// - 記録(連続): 検出しても止めない。scan-check で即時フィードバック → 確定(/api/scan-flush)でシートへ書く
// - 記録(確認): 検出すると pending card(氏名・現在の状態)を出し、ボタンで記録/上書き/見送り
// - 「新しい記録を作る」でモードとシート列をその場で作れる(動的増減)
import type { ScanCheckResponse, ScanConfigResponse, ScanDedupe, ScanFlushResponse, ScanMode, ScanRecordEntry } from '#shared/utils/scan'
import { formatJst, modeColumnsMissing, scanModeSummary, scanStatusMessage, SCAN_AUTO_FLUSH_COUNT, SCAN_FLAG_VALUE } from '#shared/utils/scan'
import type { OfflineItemRow } from '~/utils/offlineStore'
import type { OfflineFlushResponse, OfflineMeta, OfflineQueueEntry } from '#shared/utils/offline'
import { makeOfflineQueueId, offlineScanCheckResponse, OFFLINE_FLUSH_CHUNK, OFFLINE_ITEM_MAX, OFFLINE_PAGE_BATCH, OFFLINE_QUEUE_MAX } from '#shared/utils/offline'
import { parseRegistrationCode } from '#shared/utils/registration'

/**
 * オフラインモード(地下など電波状況の悪い場所でのスキャン・照会・チェックイン):
 * - 「オフラインモード準備」で items 全件 + scan-config を IndexedDB にダウンロードし、
 *   localStorage に有効化フラグを置く(SSR は storage を読めないので初回描画は「無効」。onMounted で有効化する)。
 * - オフライン中の記録は /api/scan-check を叩かずローカル payload で照合し、読み取りを IndexedDB の
 *   キューにためる(画面を閉じても残る)。シートへの書き込みは復旧後の「オフラインの記録を確定」で行う。
 * - オフライン中の照会(照会モード)は /result へ SPA 遷移し、/result がローカルスナップショットで照会する
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

// 選択したモード(null = 照会。スキャン→結果→スキャンの往復でも選択を維持する)。
const selectedModeId = useState<number | null>('scan-mode-id', () => null)
const modes = computed<ScanMode[]>(() => configState.value?.modes ?? [])
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
onBeforeUnmount(() => offAfterEach())

const session = useState<SessionEntry[]>('scan-session', () => [])
const pending = useState<ScanCheckResponse | null>('scan-pending', () => null)
const busy = ref(false)
const errorMessage = ref<string | null>(null)
const flushNote = ref<string | null>(null)
const offlineNote = ref<string | null>(null)
// 復旧確定(/api/scan-offline-flush)の失敗用。セッション欄の errorMessage と分ける(照会モードでもBannerに出せるようにする)
const queueError = ref<string | null>(null)

// オフラインモードの状態(useOfflineState は onMounted で localStorage のメタ + IndexedDB のキュー件数を引き当てる。
// top-level に分解するので template の自動 unwrap が効く)。
const { meta: offlineMeta, queueCount: offlineQueueCount, enabled: offlineEnabled, refreshQueueCount } = useOfflineState()
// スナップショット有効時は SSR 缓存の旧設定より準備時のスナップショットを優先する(モードチップと欠け列注記の根)。
onMounted(() => {
  if (offlineMeta.value?.enabled) configState.value = offlineMeta.value.config
})
/** 読み取りごとに localStorage を sync で読む(判定を onMounted 状態に依存しないため)。SSR では null = 無効。 */
function offlineActive(): boolean {
  return readOfflineMetaFromStorage()?.enabled === true
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
  if (!mode) {
    // 照会モード: オフラインでも /result へ SPA 遷移する(SW の precache で JS が読め、/result がローカル照会にフォールバックする)
    navigateTo(`/result?code=${encodeURIComponent(code)}`)
    return
  }
  if (busy.value) return
  busy.value = true
  errorMessage.value = null
  try {
    // オフラインモード: /api/scan-check を叩かずローカルスナップショット(payload)で照合する。
    // シート行の存在(sheet_missing)はオフラインでは判定できない(payload を鏡として扱う)。復旧後の flush で確定する。
    if (offlineActive()) {
      if (mode.id === null) {
        errorMessage.value = 'オフラインではまだ保存されていないモードを記録できません(先に「記録の設定」で保存してください)'
        return
      }
      if (parseRegistrationCode(code)) {
        errorMessage.value = '利用者登録用のQRです(記録対象のチケットコードをスキャンしてください)'
        return
      }
      const row = await offlineGetItem(code).catch(() => undefined)
      const checked = offlineScanCheckResponse(mode.id, mode, code, row?.payload ?? null, new Date().toISOString())
      if (mode.confirmBeforeRecord) {
        // 確認モード(チェックイン): オフラインでも氏名と現在の状態を出してから確定する(安全弁はオンラインと同じ)
        pending.value = checked
        return
      }
      // 連続モード: オンラインと同じく ok のぶんだけを待機積みにする(duplicate/skip は表示のみ)
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
          errorMessage.value = `オフラインの待機記録が上限(${OFFLINE_QUEUE_MAX}件)に達しました。通信が復旧したら確定してください`
        } else {
          await offlineAddQueueEntry({
            id: makeOfflineQueueId(mode.id, checked.code, checked.at),
            modeId: mode.id,
            modeName: mode.name,
            code: checked.code,
            status: 'ok',
            name: checked.name,
            overwrite: false,
            at: checked.at,
          })
          await refreshQueueCount()
          // オンラインの自動flush閾値は通信するが、オフライン中は通信しない(ローカル蓄積の注記だけ出す)
          if (session.value.filter((e) => e.offlineQueued).length >= SCAN_AUTO_FLUSH_COUNT) {
            offlineNote.value = 'オフライン中: 読み取りをローカルにためています(通信が復旧したら「オフラインの記録を確定」でまとめてシートへ書き込みます)'
          }
        }
      }
      return
    }
    const checked = await $fetch<ScanCheckResponse>('/api/scan-check', { method: 'POST', body: { modeId: mode.id, code } })
    if (mode.confirmBeforeRecord) {
      // 確認モード: 氏名と現在の状態を出してから確定する(誤読の安全弁)
      pending.value = checked
      return
    }
    // 連続モード: その場でキューに積み、自動flushの閾値で確定する
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
    })
    if (queued && session.value.filter((e) => e.queued).length >= SCAN_AUTO_FLUSH_COUNT) {
      await flush()
    }
  } catch (e: unknown) {
    errorMessage.value = describeError(e)
  } finally {
    busy.value = false
  }
}

function describeError(e: unknown): string {
  const err = e as { statusCode?: number; statusMessage?: string; data?: { columns?: string[] } }
  if (err?.statusCode === 401) return 'ログインが必要です'
  if (err?.statusCode === 403) return 'この操作は users テーブルに紐付け済みのユーザのみ実行できます'
  if (err?.statusMessage === 'column_missing' || (err?.statusMessage?.includes('ヘッダーにありません') ?? false)) {
    return err.statusMessage ?? '記録カラムがシートにありません'
  }
  if (err?.statusMessage) return err.statusMessage
  return '失敗しました。もう一度お試しください'
}

/** 未確定の読み取りをまとめてシートへ書く(/api/scan-flush)。 */
async function flush() {
  // オフライン中は通信しない(ローカルキューにためて、復旧後に「オフラインの記録を確定」で書く)
  if (offlineActive()) {
    offlineNote.value = 'オフライン中はシートに書き込みません(通信が復旧したら「オフラインの記録を確定」でまとめて書き込みます)'
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
    flushNote.value = `${res.wrote}件をシートに書き込みました(${res.sheetTitle})${res.dbUpdated ? '' : ' ※items の更新に失敗したぶんがあります(シートは保存済み。次の同期で一致します)'}`
  } catch (e: unknown) {
    errorMessage.value = describeError(e)
  } finally {
    busy.value = false
  }
}

/** 確認モードの確定(記録 / 上書き / 見送り)。オフラインはローカルキューにためて復旧後に確定する。 */
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
    if (mode?.id != null) {
      void offlineAddQueueEntry({
        id: makeOfflineQueueId(mode.id, p.code, p.at),
        modeId: mode.id,
        modeName: mode.name,
        code: p.code,
        status: 'ok', // 復旧後の flush 側で現在の状態から ok/duplicate/skipped を再確定する
        name: p.name,
        overwrite,
        at: p.at,
      }).then(() => refreshQueueCount())
    }
    offlineNote.value = 'オフライン: 氏名を確認してローカルに記録しました(通信が復旧したら「オフラインの記録を確定」でシートへ書き込みます)'
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

// ── オフラインモードの準備・解除・復旧確定 ──────────────

const prepBusy = ref(false)
const prepProgress = ref('')
const prepError = ref<string | null>(null)

/**
 * オフラインモード準備: scan-config + items-list の分页を最後まで読み、IndexedDB に保存して
 * localStorage のフラグを ON にする。SW の NetworkFirst にもページ(/ と /scan)の HTML をためる
 * (fetch は SW がinterceptするので、準備時に1回読むだけでオフライン起動できる)。
 */
async function prepareOffline() {
  if (prepBusy.value) return
  prepBusy.value = true
  prepError.value = null
  offlineNote.value = null
  prepProgress.value = '設定を読み込み中…'
  try {
    const cfg = await $fetch<ScanConfigResponse>('/api/scan-config')
    configState.value = cfg
    const rows: OfflineItemRow[] = []
    let cursor = ''
    let capped = false
    for (;;) {
      const page = await $fetch<{ rows: OfflineItemRow[]; nextCursor: string | null; total: number }>('/api/items-list', {
        query: { limit: OFFLINE_PAGE_BATCH, ...(cursor ? { cursor } : {}) },
      })
      rows.push(...page.rows)
      prepProgress.value = `${rows.length}/${page.total ?? rows.length}件 をダウンロード中…`
      if (!page.nextCursor) break
      if (rows.length >= OFFLINE_ITEM_MAX) {
        capped = true
        break
      }
      cursor = page.nextCursor
    }
    const meta: OfflineMeta = {
      enabled: true,
      snapshotAt: new Date().toISOString(),
      itemCount: rows.length,
      config: cfg,
      capped,
    }
    await offlineSaveSnapshot(meta, rows)
    writeOfflineMetaToStorage(meta)
    offlineMeta.value = meta
    await refreshQueueCount()
    // オフライン起動用のページキャッシュをためる(SW が NetworkFirst で缓存。dev では SW が無いので素通し)
    await fetch('/scan').catch(() => {})
    await fetch('/').catch(() => {})
    await fetch('/items').catch(() => {})
    offlineNote.value = `オフライン準備完了(${rows.length}件${capped ? `、上限 ${OFFLINE_ITEM_MAX}件で打ち切り` : ''}・設定 ${cfg.modes.length}モード)。地下でもスキャン・照会・チェックイン・items一覧が使えます。`
  } catch (e: unknown) {
    prepError.value = describeError(e)
  } finally {
    prepBusy.value = false
    prepProgress.value = ''
  }
}

/** オフライン解除: フラグだけ OFF(スナップショットとキューは残る。再準備で更新できる)。 */
function disableOffline() {
  const m = offlineMeta.value
  if (!m) return
  const next: OfflineMeta = { ...m, enabled: false }
  writeOfflineMetaToStorage(next)
  offlineMeta.value = next
}

/** スナップショット削除(items + meta)。オフラインの待機記録は復旧確定できるので残す。 */
async function deleteOfflineData() {
  try {
    await offlineDeleteSnapshot()
  } catch (e: unknown) {
    prepError.value = describeError(e)
    return
  }
  clearOfflineMetaStorage()
  offlineMeta.value = null
  await refreshQueueCount()
  offlineNote.value = `スナップショットを削除しました${offlineQueueCount.value > 0 ? `(オフラインの待機記録 ${offlineQueueCount.value}件は残ります)` : ''}`
}

/**
 * 復旧確定: ローカルキューを modeId でグループ化し、1モードごとに chunk(≤ OFFLINE_FLUSH_CHUNK)で
 * /api/scan-offline-flush に送る。シートの日時と証跡にはオフライン時の読み取り時刻(at)がそのまま載る。
 * write_failed はキューに残す(もう一度確定できる)。
 * オフラインモードの ON/OFF とは独立(接続が戻っていれば書ける。戻らなければ $fetch が失敗し
 * キューはそのまま残る — 「失敗 N件は再確定できます」の注記が出る)。
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
          // セッション欄の該当行を確定結果に書き換える(オンライン flush と同じ扱い)
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
    // 成功注記は offlineNote(オフラインモード欄に出す)。Banner はキュー 0 だと消えるので注記置き場にしない
    offlineNote.value =
      `復旧確定: ${wrote}件をシートに書き込みました${skipped > 0 ? ` / 既に済だった ${skipped}件は書き込みませんでした` : ''}${failed > 0 ? ` / 失敗 ${failed}件は再確定できます` : ''}${offlineQueueCount.value > 0 ? ` / ローカル残り ${offlineQueueCount.value}件` : ''}`
  } catch (e: unknown) {
    queueError.value = describeError(e)
  } finally {
    busy.value = false
  }
}

// ── 新しい記録を作る(モード + シート列をその場で作れる)──────────

const createOpen = useState<boolean>('scan-create-open', () => false)
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
    // 1) シート列を作る(列が既にあれば existing で返る。取り込みカラムへの追記も選ぶ)
    if (newAddColumns.value) {
      const columns = flag && at ? [flag, at] : [flag]
      const res = await $fetch<{ created: string[]; existing: string[]; includeColumnsUpdated: boolean }>('/api/scan-columns', {
        method: 'POST',
        body: { columns, addToIncludeColumns: true },
      })
      createNote.value = `シート列: 追加 ${res.created.join(', ') || 'なし'} / 既存 ${res.existing.join(', ') || 'なし'}${res.includeColumnsUpdated ? ' / 取り込みカラムに追加しました' : ''}`
    }
    // 2) モードを保存(既存モードのリストに新モードを足して送る = リストが正)
    const newMode: Partial<ScanMode> = {
      name,
      actions: [{ column: flag, columnAt: at, literal: SCAN_FLAG_VALUE, payloadKey: flag, payloadAtKey: at }],
      dedupe: newDedupe.value,
      confirmBeforeRecord: newConfirm.value,
      requireFound: true,
      enabled: true,
    }
    const res = await $fetch<ScanConfigResponse>('/api/scan-config', {
      method: 'POST',
      body: { modes: [...(configState.value?.modes ?? []), newMode] },
    })
    configState.value = res
    const created = res.modes.find((m) => m.name === name)
    if (created) {
      selectedModeId.value = created.id
      session.value = []
      pending.value = null
      remountScanner()
      createOpen.value = false
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
    const next = modes.value.map((m) => (m.id === mode.id ? { ...m, enabled: !m.enabled } : m))
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

    <!-- モード選択(照会 + 記録モード)。無効化されたモードは出さない -->
    <div class="mode-row" role="group" aria-label="スキャンのモード">
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
      <button class="btn secondary" :aria-expanded="createOpen" @click="createOpen = !createOpen">
        新しい記録を作る
      </button>
      <!-- 設定の導線(モードの追加・変更・削除は /scan-settings でまとめて確認できる) -->
      <NuxtLink class="btn secondary" to="/scan-settings">記録の設定</NuxtLink>
    </div>
    <p v-if="recording" class="muted">{{ activeSummary }}</p>
    <p v-if="activeMissingColumns.length" class="error">
      このモードの列がシートにありません: {{ activeMissingColumns.join(', ') }}
      (「記録の設定」で列を追加してからスキャンしてください)
    </p>

    <!-- オフラインモード(地下など電波状況の悪い場所でのスキャン・照会・チェックイン) -->
    <div class="card offline-card">
      <h2>オフラインモード</h2>
      <p v-if="offlineMeta?.enabled" class="muted">
        有効 — スナップショット {{ formatJst(offlineMeta.snapshotAt) }} / {{ offlineMeta.itemCount }}件{{ offlineMeta.capped ? `(上限 ${OFFLINE_ITEM_MAX}件で打ち切り)` : '' }}。スキャン・照会・記録・items一覧は通信を使いません。
      </p>
      <p v-else class="muted">
        電波の良い場所で「オフラインモード準備」を押すと、一覧データと記録の設定をこの端末に保存します。地下などでもスキャン・照会・チェックインができ、記録は通信が復旧したらまとめてシートへ書き込みます。
      </p>
      <div class="mode-row">
        <button class="btn" :disabled="prepBusy" @click="prepareOffline">{{ prepBusy ? `準備中… ${prepProgress}` : 'オフラインモード準備' }}</button>
        <button v-if="offlineMeta?.enabled" class="btn secondary" @click="disableOffline">オフライン解除</button>
        <button v-if="offlineMeta?.enabled" class="btn secondary" @click="deleteOfflineData">スナップショット削除</button>
      </div>
      <p v-if="prepError" class="error">{{ prepError }}</p>
      <p v-if="offlineNote" class="muted">{{ offlineNote }}</p>
    </div>

    <!-- 新しい記録を作る(モード + シート列。列が無ければここで追加できる) -->
    <div v-if="createOpen" class="card create-card">
      <h2>新しい記録</h2>
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

    <div class="card">
      <QrScanner
        :key="scannerKey"
        :continuous="recording"
        :busy="busy || (recording && pending !== null)"
        @detected="onDetected"
      />
    </div>

    <!-- 確認モードの pending card(氏名・現在の状態 → 記録/上書き/見送り) -->
    <div v-if="pending" class="card pending-card">
      <p class="pending-name">{{ pending.name || '(氏名不明)' }}</p>
      <p class="muted">{{ pending.code }}</p>
      <p class="pending-state">{{ pendingLabel(pending) }}</p>
      <div class="mode-row">
        <button class="btn" :disabled="busy" @click="confirmRecord(false)">記録</button>
        <button v-if="pending.status === 'duplicate'" class="btn secondary" :disabled="busy" @click="confirmRecord(true)">上書き</button>
        <button class="btn secondary" @click="dismissPending">見送り</button>
      </div>
    </div>

    <!-- 記録セッション -->
    <div v-if="recording" class="card session-card">
      <p class="muted">
        このセッション: 記録 {{ okCount }}件 / 重複 {{ duplicateCount }}件 / 問題 {{ problemCount }}件 / 未確定 {{ queuedCount }}件
      </p>
      <div class="mode-row">
        <button class="btn" :disabled="busy || queuedCount === 0" @click="flush">
          {{ queuedCount > 0 ? `書き込みを確定(${queuedCount}件)` : '書き込みを確定' }}
        </button>
        <button class="btn secondary" :disabled="busy" @click="toggleActiveModeEnabled">
          {{ activeMode?.enabled ? 'このモードを無効化' : 'このモードを有効化' }}
        </button>
        <button class="btn secondary danger" :disabled="busy" @click="deleteActiveMode">このモードを削除</button>
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

    <!-- オフラインの待機記録(通信が復旧したらまとめてシートへ書き込む) -->
    <div v-if="offlineQueueCount > 0" class="card offline-card">
      <p>オフラインの記録 {{ offlineQueueCount }}件(通信が復旧したらまとめてシートへ書き込みます)</p>
      <div class="mode-row">
        <!-- オフラインモードの ON/OFF とは独立: 接続が戻っていれば確定できる(戻っていなければ失敗し、キューは残る) -->
        <button class="btn" :disabled="busy" @click="flushOfflineQueue">オフラインの記録を確定({{ offlineQueueCount }}件)</button>
      </div>
      <p v-if="queueError" class="error">{{ queueError }}</p>
    </div>
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
.mode-row .btn.active {
  box-shadow: inset 0 0 0 2px rgba(120, 190, 255, 0.8);
}
.mode-row .btn.danger {
  color: var(--danger);
}
.create-card {
  margin-bottom: 12px;
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
.pending-card {
  margin-bottom: 12px;
}
.offline-card {
  margin-bottom: 12px;
}
.offline-card h2 {
  font-size: 16px;
  margin: 0 0 6px;
}
.offline-card p {
  font-size: 14px;
  margin: 0 0 8px;
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
