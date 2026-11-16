<script setup lang="ts">
import type { ScanConfigResponse, ScanDedupe, ScanMode } from '#shared/utils/scan'
import { SCAN_FLAG_VALUE, modeColumns, modeColumnsMissing, modeColumnsOutsideInclude, scanModeSummary } from '#shared/utils/scan'

/**
 * 記録モードの設定画面(`/scan-settings`)。追加・変更・削除・有効/無効をここから行える。
 *
 * 既定の2モード(チケット配布・チェックイン)もマイグレーションのシード行なので、他のモードと同じように
 * 編集・削除できる(=`public.scan_modes` の行が正。DB が空のときだけ既定プリセットを表示する)。
 * 保存は `POST /api/scan-config` に**ドラフトのリストを丸ごと**送る(リストが正 = 無い id は削除)。
 * シートの列作成は `POST /api/scan-columns`(`addDimensionRange` + ヘッダーの `values.update`)。
 *
 * `keepalive: true` — `/scan` や `/records` に開いても編集の途中に戻る。
 */
definePageMeta({ keepalive: true, scrollToTop: false })

const configState = useState<ScanConfigResponse | null>('scan-settings-config', () => null)
if (configState.value === null) {
  configState.value = await $fetch<ScanConfigResponse>('/api/scan-config', { headers: useRequestHeaders(['cookie']) })
}

/** 画面の編集状態(DB の値のコピー)。保存で DB に書き、破棄で config を引き直す。 */
const drafts = useState<ScanMode[]>('scan-settings-drafts', () => [])
const loadedFrom = useState<string>('scan-settings-loaded-from', () => '')

function loadDrafts(from: ScanMode[]): void {
  drafts.value = from.map((mode) => ({
    ...mode,
    actions: mode.actions.map((action) => ({ ...action })),
  }))
  loadedFrom.value = JSON.stringify(from)
}
loadDrafts(configState.value?.modes ?? [])

/** 保存済み(DB)とドラフトがズレているか(「保存」ボタンの有効と注記に使う)。 */
const dirty = computed(() => JSON.stringify(drafts.value) !== loadedFrom.value)

const busy = ref(false)
const errorMessage = ref<string | null>(null)
const note = ref<string | null>(null)

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function saveDrafts(): Promise<boolean> {
  busy.value = true
  errorMessage.value = null
  try {
    const res = await $fetch<ScanConfigResponse>('/api/scan-config', {
      method: 'POST',
      body: { modes: drafts.value },
    })
    configState.value = res
    loadDrafts(res.modes)
    note.value = '保存しました'
    return true
  } catch (e: unknown) {
    errorMessage.value = describeError(e)
    return false
  } finally {
    busy.value = false
  }
}

function discardDrafts() {
  loadDrafts(configState.value?.modes ?? [])
  note.value = 'DB の値に戻しました'
  errorMessage.value = null
}

function setAction(mode: ScanMode, index: number, patch: Partial<ScanMode['actions'][number]>) {
  const action = mode.actions[index]
  if (!action) return
  mode.actions[index] = { ...action, ...patch }
}

function addAction(mode: ScanMode) {
  if (mode.actions.length >= 3) return
  mode.actions.push({ column: '', columnAt: '', literal: SCAN_FLAG_VALUE, payloadKey: '', payloadAtKey: '' })
}

function removeAction(mode: ScanMode, index: number) {
  mode.actions.splice(index, 1)
}

function toggleEnabled(mode: ScanMode) {
  mode.enabled = !mode.enabled
}

/** モードをドラフトから消す(保存で DB の行も削除される。履歴があれば API が 400 で案内する)。 */
function removeMode(mode: ScanMode) {
  drafts.value = drafts.value.filter((m) => !(m.id !== null && m.id === mode.id))
}

/** そのモードの列をシートに追加し、取り込みカラムにも載せる(/api/scan-columns)。 */
async function createSheetColumns(mode: ScanMode) {
  const columns = modeColumns(mode)
  if (columns.length === 0) {
    errorMessage.value = '追加する列がありません(カラム名を入力してください)'
    return
  }
  busy.value = true
  errorMessage.value = null
  note.value = null
  try {
    const res = await $fetch<{ created: string[]; existing: string[]; includeColumnsUpdated: boolean; headers: string[] }>('/api/scan-columns', {
      method: 'POST',
      body: { columns, addToIncludeColumns: true },
    })
    // シートのヘッダーを引き直す(追加直後の「列がありません」判定を正しくする)
    configState.value = await $fetch<ScanConfigResponse>('/api/scan-config', { headers: useRequestHeaders(['cookie']) })
    note.value = `シート列: 追加 ${res.created.join(', ') || 'なし'} / 既存 ${res.existing.join(', ') || 'なし'}${res.includeColumnsUpdated ? ' / 取り込みカラムに追加しました' : ''}`
  } catch (e: unknown) {
    errorMessage.value = describeError(e)
  } finally {
    busy.value = false
  }
}

// 新しいモードの作成欄(スキャン画面と同じ項目。ここで作っても /scan ですぐ使える)
const newName = ref('')
const newFlagColumn = ref('')
const newAtColumn = ref('')
const newConfirm = ref(false)
const newDedupe = ref<ScanDedupe>('warn')
const newAddColumns = ref(true)

async function addMode() {
  const name = newName.value.trim()
  const flag = newFlagColumn.value.trim()
  if (!name || !flag) {
    errorMessage.value = '記録の名前と済/未カラム名が必要です'
    return
  }
  if (drafts.value.some((m) => m.name === name)) {
    errorMessage.value = `「${name}」は既にあります(名前は重複できません)`
    return
  }
  const at = newAtColumn.value.trim()
  const draft: ScanMode = {
    id: null,
    name,
    actions: [{ column: flag, columnAt: at, literal: SCAN_FLAG_VALUE, payloadKey: flag, payloadAtKey: at }],
    dedupe: newDedupe.value,
    confirmBeforeRecord: newConfirm.value,
    requireFound: true,
    enabled: true,
    updatedAt: null,
    updatedBy: null,
  }
  drafts.value = [...drafts.value, draft]
  // シート列の追加を選ぶと、列を作ってしてから保存する(列が無いモードを先に作るとスキャンが 400 になる)
  if (newAddColumns.value) await createSheetColumns(draft)
  const saved = await saveDrafts()
  if (saved) {
    newName.value = ''
    newFlagColumn.value = ''
    newAtColumn.value = ''
    note.value = `${name} を作りました`
  } else {
    // 保存に失敗したらドラフトから引き戻す(作っていない扱いに戻す)
    drafts.value = drafts.value.filter((m) => m.id === null && m.name === name)
  }
}

/** 各モードの「シートに無い列」「取り込みカラムに無い列」(設定画面の注記)。 */
function missingColumns(mode: ScanMode): string[] {
  return modeColumnsMissing(mode, configState.value?.sheetHeaders ?? null)
}
function outsideInclude(mode: ScanMode): string[] {
  return modeColumnsOutsideInclude(mode, configState.value?.syncIncludeColumns ?? [])
}

const sheetLabel = computed(() => configState.value?.sheetTitle ?? 'シート未設定')
const headersKnown = computed(() => configState.value?.sheetHeaders !== null)
const dedupeLabels: Record<ScanDedupe, string> = {
  warn: '重複: 警告(書き込まない)',
  skip: '重複: 記録しない',
  allow: '重複: 上書き',
}
</script>

<template>
  <div class="page">
    <h1>記録の設定</h1>
    <p class="muted">
      スキャンで「何を記録するか」を決めます。追加・変更・削除はこの画面から行えます(/scan のモードチップにも同じモードが並びます)。
    </p>

    <div class="card">
      <p class="muted">
        シート: {{ sheetLabel }} / 取り込みカラム {{ configState?.syncIncludeColumns.length ?? 0 }}個
        <span v-if="!headersKnown"> / シートのヘッダーは読み取れていません(設定か鍵を確認)</span>
      </p>
      <p v-if="configState?.rowMissing" class="muted">
        DB に記録モードがありません。下の列表は既定プリセットです — 「保存」で行が作られます。
      </p>
      <p v-if="!configState?.serviceAccountConfigured" class="error">
        サービスアカウント鍵がありません。列の作成と記録の書き込みはできません(Worker の secret <code>GOOGLE_SERVICE_ACCOUNT_JSON</code>)。
      </p>
      <div class="mode-row">
        <NuxtLink class="btn secondary" to="/scan">スキャンに戻る</NuxtLink>
        <NuxtLink class="btn secondary" to="/records">記録履歴</NuxtLink>
      </div>
    </div>

    <div v-for="mode in drafts" :key="mode.name" class="card mode-card">
      <div class="mode-head">
        <p class="mode-title">{{ mode.name }}</p>
        <span class="muted">{{ scanModeSummary(mode) }}</span>
        <span v-if="mode.id === null" class="tag warn">未保存</span>
        <span v-if="!mode.enabled" class="tag warn">無効</span>
      </div>

      <div class="edit-grid">
        <ClearableInput v-model="mode.name" label="記録の名前" placeholder="例: チェックイン" />
        <button class="btn secondary" :class="{ active: mode.confirmBeforeRecord }" @click="mode.confirmBeforeRecord = !mode.confirmBeforeRecord">
          {{ mode.confirmBeforeRecord ? '氏名を確認してから記録' : '連続で次々と記録' }}
        </button>
        <button class="btn secondary" :class="{ active: mode.enabled }" @click="toggleEnabled(mode)">
          {{ mode.enabled ? '有効' : '無効' }}
        </button>
        <button class="btn secondary" :class="{ active: mode.requireFound }" @click="mode.requireFound = !mode.requireFound">
          {{ mode.requireFound ? '見つからない code は記録しない' : '見つからない code も記録する' }}
        </button>
      </div>

      <div class="mode-row dedupe-row">
        <button
          v-for="d in ['warn', 'skip', 'allow'] as ScanDedupe[]"
          :key="d"
          class="btn secondary"
          :class="{ active: mode.dedupe === d }"
          @click="mode.dedupe = d"
        >{{ dedupeLabels[d] }}</button>
      </div>

      <!-- 書く列の組(1〜3)。シートヘッダー名と payload キーを別々に設定できる -->
      <div v-for="(action, i) in mode.actions" :key="i" class="action-block">
        <div class="edit-grid">
          <ClearableInput :modelValue="action.column" label="済/未を書くカラム" placeholder="例: 来場済" @update:modelValue="setAction(mode, i, { column: String($event) })" />
          <ClearableInput :modelValue="action.columnAt" label="日時を書くカラム(任意)" placeholder="例: 来場日時" @update:modelValue="setAction(mode, i, { columnAt: String($event) })" />
          <ClearableInput :modelValue="action.literal" label="フラグに書く値" :placeholder="SCAN_FLAG_VALUE" @update:modelValue="setAction(mode, i, { literal: String($event) })" />
          <ClearableInput :modelValue="action.payloadKey" label="payload のキー(空 = カラム名)" placeholder="空でよい" @update:modelValue="setAction(mode, i, { payloadKey: String($event) })" />
          <ClearableInput :modelValue="action.payloadAtKey" label="payload の日時キー(空 = 日時カラム)" placeholder="空でよい" @update:modelValue="setAction(mode, i, { payloadAtKey: String($event) })" />
        </div>
        <p v-if="action.column && missingColumns(mode).includes(action.column)" class="muted">
          この列はシートのヘッダーにありません: {{ missingColumns(mode).join(', ') }}
          <button class="btn secondary" :disabled="busy" @click="createSheetColumns(mode)">シートの列を追加</button>
        </p>
        <p v-if="action.column && outsideInclude(mode).length" class="muted">
          取り込みカラムに無い列: {{ outsideInclude(mode).join(', ') }}(載せないと次の同期で payload から消えます)
          <button class="btn secondary" :disabled="busy" @click="createSheetColumns(mode)">取り込みカラムに追加</button>
        </p>
        <button v-if="mode.actions.length > 1" class="btn secondary danger" type="button" @click="removeAction(mode, i)">この組を削除</button>
      </div>
      <button v-if="mode.actions.length < 3" class="btn secondary" type="button" @click="addAction(mode)">書く列の組を追加</button>

      <div class="mode-row">
        <button class="btn secondary danger" :disabled="busy" @click="removeMode(mode)">このモードを削除</button>
      </div>
    </div>

    <div class="card create-card">
      <h2>新しい記録</h2>
      <div class="edit-grid">
        <ClearableInput v-model="newName" label="記録の名前" placeholder="例: ボランティア確認" />
        <ClearableInput v-model="newFlagColumn" label="済/未を書くカラム" placeholder="例: 確認済" />
        <ClearableInput v-model="newAtColumn" label="日時を書くカラム(任意)" placeholder="例: 確認日時" />
      </div>
      <div class="mode-row">
        <button class="btn secondary" :class="{ active: newConfirm }" @click="newConfirm = !newConfirm">
          {{ newConfirm ? '氏名を確認してから記録' : '連続で次々と記録' }}
        </button>
        <button
          v-for="d in ['warn', 'skip', 'allow'] as ScanDedupe[]"
          :key="d"
          class="btn secondary"
          :class="{ active: newDedupe === d }"
          @click="newDedupe = d"
        >{{ dedupeLabels[d] }}</button>
        <button class="btn secondary" :class="{ active: newAddColumns }" @click="newAddColumns = !newAddColumns">
          {{ newAddColumns ? 'シートの列を追加する(取り込みカラムにも追加)' : '既存の列だけ使う' }}
        </button>
      </div>
      <button class="btn" :disabled="busy" @click="addMode">{{ busy ? '作成中…' : '作成して保存' }}</button>
    </div>

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    <p v-if="note" class="muted">{{ note }}</p>

    <div class="mode-row save-row">
      <button class="btn" :disabled="busy || !dirty" @click="saveDrafts">{{ busy ? '保存中…' : '変更を保存' }}</button>
      <button class="btn secondary" :disabled="busy || !dirty" @click="discardDrafts">変更を破棄</button>
      <span v-if="dirty" class="muted">保存していない変更があります</span>
    </div>
  </div>
</template>

<style scoped>
.mode-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mode-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}

.mode-title {
  margin: 0;
  font-weight: 600;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 8px;
  align-items: end;
}

.action-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid #1f2b3d;
  padding-top: 8px;
}

.dedupe-row,
.save-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tag.warn {
  color: var(--warning, #f0b429);
  font-size: 12px;
}

.btn.danger {
  color: var(--danger);
}
</style>
