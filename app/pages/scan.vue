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

definePageMeta({ keepalive: true, scrollToTop: false })

/** セッションの1読み取り(画面側。flush 前 status='queued'、確定後に確定結果へ書き換える)。 */
interface SessionEntry extends ScanRecordEntry {
  /** 未確定(まだシートに書いていない)なら true */
  queued: boolean
  /** 確認モードで「上書き」を選んだなら flush に overwrite: true を送る */
  overwrite: boolean
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

const session = useState<SessionEntry[]>('scan-session', () => [])
const pending = useState<ScanCheckResponse | null>('scan-pending', () => null)
const busy = ref(false)
const errorMessage = ref<string | null>(null)
const flushNote = ref<string | null>(null)

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
    navigateTo(`/result?code=${encodeURIComponent(code)}`)
    return
  }
  if (busy.value) return
  busy.value = true
  errorMessage.value = null
  try {
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

/** 確認モードの確定(記録 / 上書き / 見送り)。 */
function confirmRecord(overwrite: boolean) {
  const p = pending.value
  if (!p) return
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
  })
  pending.value = null
  remountScanner()
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
          <span class="session-status">{{ entry.queued ? '未確定' : scanStatusMessage(entry.status) }}</span>
          <span class="session-at">{{ formatJst(entry.at) }}</span>
          <span v-if="entry.range" class="session-range">{{ entry.range }}</span>
        </li>
      </ul>
      <p v-if="session.length === 0" class="muted">まだ読み取りがありません。カメラでチケットのQRを次々とスキャンしてください。</p>
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
