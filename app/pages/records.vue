<script setup lang="ts">
// 記録履歴(scan_events)の閲覧画面。監査目的: 「いつ・誰が・どのモードで・何を書いたか」を日時付きで出す。
// 保護は app/middleware/auth.global.ts(グローバル+ホワイトリスト)が自動で守る(新規ページはデフォルト拒否)。
// 分页は seq(挿入順の連番)降順のキーセットカーソル。uuid は time-order ではないのでカーソルに使えない。
import { describeApiError } from '#shared/utils/apiError'
import type { ScanConfigResponse, ScanHistoryResponse, ScanHistoryRow, ScanStatus } from '#shared/utils/scan'
import { formatJst, scanStatusMessage } from '#shared/utils/scan'

definePageMeta({ keepalive: true, scrollToTop: false })

const route = useRoute()

const configState = useState<ScanConfigResponse | null>('scan-config', () => null)
if (configState.value === null) {
  configState.value = await $fetch<ScanConfigResponse>('/api/scan-config', {
    headers: useRequestHeaders(['cookie']),
  }).catch(() => null)
}

// 絞り込み(URL は初期値としてだけ読む。items.vue と同じ方針)。
const mode = ref<string>(typeof route.query.mode === 'string' ? route.query.mode : '')
const code = ref<string>(typeof route.query.code === 'string' ? route.query.code : '')
const status = ref<string>(typeof route.query.status === 'string' ? route.query.status : '')
const from = ref<string>(typeof route.query.from === 'string' ? route.query.from : '')
const to = ref<string>(typeof route.query.to === 'string' ? route.query.to : '')

const firstPage = useState<ScanHistoryResponse | null>('scan-history-first', () => null)
if (firstPage.value === null) {
  firstPage.value = await $fetch<ScanHistoryResponse>('/api/scan-history', {
    headers: useRequestHeaders(['cookie']),
    query: { mode: mode.value, code: code.value, status: status.value, from: from.value, to: to.value },
  }).catch(() => null)
}

const rows = useState<ScanHistoryRow[]>('scan-history-rows', () => firstPage.value?.rows ?? [])
const total = useState<number>('scan-history-total', () => firstPage.value?.total ?? 0)
const nextCursor = useState<string | null>('scan-history-cursor', () => firstPage.value?.nextCursor ?? null)
const loading = ref(false)
const errorMessage = ref<string | null>(null)

/** 条件を直したら 1ページ目から読み直す(カーソルは消える)。 */
async function reload() {
  loading.value = true
  errorMessage.value = null
  try {
    const res = await $fetch<ScanHistoryResponse>('/api/scan-history', {
      headers: useRequestHeaders(['cookie']),
      query: { mode: mode.value, code: code.value, status: status.value, from: from.value, to: to.value },
    })
    rows.value = res.rows
    total.value = res.total
    nextCursor.value = res.nextCursor
  } catch (e: unknown) {
    errorMessage.value = describeApiError(e).friendly
  } finally {
    loading.value = false
  }
}

/** 次のページを読み込む(seq 降順のキーセットカーソル。新しい行が増えても既存ページはズレない)。 */
async function loadMore() {
  if (!nextCursor.value || loading.value) return
  loading.value = true
  errorMessage.value = null
  try {
    const res = await $fetch<ScanHistoryResponse>('/api/scan-history', {
      headers: useRequestHeaders(['cookie']),
      query: { mode: mode.value, code: code.value, status: status.value, from: from.value, to: to.value, cursor: nextCursor.value },
    })
    rows.value = [...rows.value, ...res.rows]
    total.value = res.total
    nextCursor.value = res.nextCursor
  } catch (e: unknown) {
    errorMessage.value = describeApiError(e).friendly
  } finally {
    loading.value = false
  }
}

function resetFilters() {
  mode.value = ''
  code.value = ''
  status.value = ''
  from.value = ''
  to.value = ''
  void reload()
}

// 期間入力(datetime-local)は JST の壁時計として送る(API 側が +09:00 を補って ISO にする)。
const statusOptions: ScanStatus[] = ['ok', 'duplicate', 'not_found', 'sheet_missing', 'write_failed', 'skipped']
const modeOptions = computed(() => (configState.value?.modes ?? []).map((m) => m.name))
</script>

<template>
  <div class="page">
    <h1>記録履歴</h1>
    <p class="muted">スキャンで記録した読み取りの履歴(監査用)。新しい順に並んでいます。</p>

    <div class="card filters">
      <div class="filter-grid">
        <label>
          記録
          <select v-model="mode" class="field" @change="reload">
            <option value="">すべて</option>
            <option v-for="name in modeOptions" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label>
          状態
          <select v-model="status" class="field" @change="reload">
            <option value="">すべて</option>
            <option v-for="s in statusOptions" :key="s" :value="s">{{ scanStatusMessage(s) }}</option>
          </select>
        </label>
        <ClearableInput v-model="code" label="コード(完全一致)" placeholder="チケットのコード" />
        <label>
          期間(開始)
          <input v-model="from" class="field" type="datetime-local" @change="reload" />
        </label>
        <label>
          期間(終了)
          <input v-model="to" class="field" type="datetime-local" @change="reload" />
        </label>
      </div>
      <div class="filter-actions">
        <button class="btn secondary" :disabled="loading" @click="resetFilters">条件をリセット</button>
        <!-- 記録モードの増減・変更は設定画面(/scan のモードチップにも同じモードが並ぶ) -->
        <NuxtLink class="btn secondary" to="/scan-settings">記録の設定</NuxtLink>
        <span class="muted">{{ total }}件</span>
      </div>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </div>

    <ul class="history-list">
      <li v-for="row in rows" :key="row.seq">
        <NuxtLink class="history-code" :to="`/result?code=${encodeURIComponent(row.code)}`">{{ row.code }}</NuxtLink>
        <span class="history-name">{{ row.name || '(氏名不明)' }}</span>
        <span class="history-mode">{{ row.modeName }}</span>
        <span class="history-status">{{ scanStatusMessage(row.status) }}</span>
        <span class="history-at">{{ formatJst(row.at) }}</span>
        <span v-if="row.actorEmail" class="history-actor">{{ row.actorEmail }}</span>
        <span v-if="row.sheetRange" class="history-range">{{ row.sheetRange }}</span>
        <span v-if="Object.keys(row.written).length" class="history-written">
          {{ Object.entries(row.written).map(([k, v]) => `${k}: ${v}`).join(' / ') }}
        </span>
      </li>
    </ul>
    <p v-if="rows.length === 0" class="muted">この条件の記録はありません。</p>

    <button v-if="nextCursor" class="btn secondary" :disabled="loading" @click="loadMore">さらに表示</button>
  </div>
</template>

<style scoped>
.filters {
  margin-bottom: 12px;
}
.filter-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
.filter-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--muted);
}
.filter-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}
.history-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.history-list li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 14px;
  border-bottom: 1px solid #1f2b3d;
  padding-bottom: 5px;
}
.history-code {
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
}
.history-name {
  font-weight: 600;
}
.history-status {
  color: var(--accent);
}
.history-at,
.history-actor,
.history-range,
.history-written,
.history-mode {
  color: var(--muted);
  font-size: 12px;
}
</style>
