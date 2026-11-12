<script setup lang="ts">
import type { MeState } from '#shared/utils/auth'
import type { SyncCommitResponse, SyncConfigResponse, SyncPreviewResponse } from '#shared/utils/sync'

/**
 *  Spreadsheet 同期の管理画面(登録済みユーザのみ。グローバルミドルウェアが保護する)。
 *
 * 二段階の運用(/api/sync-preview → /api/sync-commit):
 *  1) 「プレビュー」… シートを読み、選別結果・insert/update 件数・サンプルを出す(書き込みなし)
 *  2) 「確定して取り込む」… 同じ設定で再読み込みして upsert(confirm: true を要求)
 * 設定は DB(public.sync_settings)に保存する(/api/sync-config)。リポジトリのファイルは初期シードのみ。
 * ログアウトは BottomNav の項目で行う(ページ内ボタンは重複)。
 */

const authState = useState<MeState | null>('auth-state', () => null)
const me = authState.value ?? await $fetch<MeState>('/api/me', { headers: useRequestHeaders(['cookie']) })
if (authState.value === null) authState.value = me

const configState = useState<SyncConfigResponse | null>('sync-config', () => null)
if (configState.value === null) {
  configState.value = await $fetch<SyncConfigResponse>('/api/sync-config', {
    headers: useRequestHeaders(['cookie']),
  }).catch(() => null)
}

// 設定フォーム(DB 行の値から初期化)。
const spreadsheetId = ref(configState.value?.settings.spreadsheetId ?? '')
const worksheet = ref(configState.value?.settings.worksheet ?? '')
const codeColumn = ref(configState.value?.settings.codeColumn ?? 'ID')
const includeColumns = ref((configState.value?.settings.includeColumns ?? []).join('\n'))
const excludeColumns = ref((configState.value?.settings.excludeColumns ?? []).join('\n'))
const filterColumn = ref(configState.value?.settings.filterColumn ?? '')
const filterValues = ref((configState.value?.settings.filterValues ?? []).join('\n'))
const renameText = ref(
  Object.entries(configState.value?.settings.rename ?? {})
    .map(([from, to]) => `${from} -> ${to}`)
    .join('\n'),
)
const targetTable = ref(configState.value?.settings.targetTable ?? 'items')

/** 改行/カンマ区切りを項目リストへ。 */
function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/** 「元 -> 新」/「元 = 新」の行を rename map に(区切りが無い行は無視)。 */
function parseRename(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const hit = t.split(/\s*(?:->|→|=)\s*/)
    const [fromRaw, toRaw] = hit
    if (hit.length !== 2 || fromRaw === undefined || toRaw === undefined) continue
    const from = fromRaw.trim()
    const to = toRaw.trim()
    if (from && to) out[from] = to
  }
  return out
}

function formPayload() {
  return {
    spreadsheetId: spreadsheetId.value.trim(),
    worksheet: worksheet.value.trim(),
    codeColumn: codeColumn.value.trim(),
    includeColumns: parseList(includeColumns.value),
    excludeColumns: parseList(excludeColumns.value),
    filterColumn: filterColumn.value.trim(),
    filterValues: parseList(filterValues.value),
    rename: parseRename(renameText.value),
    targetTable: targetTable.value.trim(),
  }
}

const saving = ref(false)
const previewing = ref(false)
const committing = ref(false)
const errorMessage = ref<string | null>(null)
const savedAt = ref<string | null>(configState.value?.updatedAt ?? null)
const preview = ref<SyncPreviewResponse | null>(null)
const committed = ref<SyncCommitResponse | null>(null)

function describeError(e: unknown): string {
  const err = e as { statusCode?: number; statusMessage?: string; data?: { codeColumn?: string; headers?: string[] } }
  if (err?.statusMessage === 'code_column_missing' && err.data?.codeColumn) {
    return `code カラム "${err.data.codeColumn}" がヘッダーにありません。利用可能なヘッダー: ${(err.data.headers ?? []).join(', ')}`
  }
  if (err?.statusCode === 401) return 'ログインが必要です'
  if (err?.statusCode === 403) return 'この操作は users テーブルに紐付け済みのユーザのみ実行できます'
  if (err?.statusMessage) return err.statusMessage
  return '失敗しました。もう一度お試しください'
}

async function saveConfig() {
  saving.value = true
  errorMessage.value = null
  preview.value = null
  try {
    const res = await $fetch<SyncConfigResponse>('/api/sync-config', {
      method: 'POST',
      headers: useRequestHeaders(['cookie']),
      body: formPayload(),
    })
    configState.value = res
    savedAt.value = res.updatedAt
    // 正規化された値をフォームに反映(不正入力の補正が見えるようにする)
    spreadsheetId.value = res.settings.spreadsheetId
    worksheet.value = res.settings.worksheet ?? ''
    codeColumn.value = res.settings.codeColumn
    includeColumns.value = res.settings.includeColumns.join('\n')
    excludeColumns.value = res.settings.excludeColumns.join('\n')
    filterColumn.value = res.settings.filterColumn ?? ''
    filterValues.value = res.settings.filterValues.join('\n')
    renameText.value = Object.entries(res.settings.rename).map(([f, t]) => `${f} -> ${t}`).join('\n')
    targetTable.value = res.settings.targetTable
  } catch (e) {
    errorMessage.value = describeError(e)
  } finally {
    saving.value = false
  }
}

async function runPreview() {
  previewing.value = true
  errorMessage.value = null
  committed.value = null
  preview.value = null
  try {
    preview.value = await $fetch<SyncPreviewResponse>('/api/sync-preview', {
      method: 'POST',
      headers: useRequestHeaders(['cookie']),
    })
  } catch (e) {
    errorMessage.value = describeError(e)
  } finally {
    previewing.value = false
  }
}

async function runCommit() {
  committing.value = true
  errorMessage.value = null
  try {
    committed.value = await $fetch<SyncCommitResponse>('/api/sync-commit', {
      method: 'POST',
      headers: useRequestHeaders(['cookie']),
      body: { confirm: true },
    })
    preview.value = null
  } catch (e) {
    errorMessage.value = describeError(e)
  } finally {
    committing.value = false
  }
}

const serviceAccountConfigured = computed(() => configState.value?.serviceAccountConfigured ?? false)
const rowMissing = computed(() => configState.value?.rowMissing ?? false)
/** プレビュー成功かつ上限超過で無いときだけ確定を許す。 */
const canCommit = computed(() => preview.value !== null && !preview.value.truncated)

function sampleEntries(row: { payload: Record<string, string> }): string {
  return Object.entries(row.payload)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' / ')
}
</script>

<template>
  <div class="page">
    <h1>Spreadsheet 同期</h1>

    <div v-if="errorMessage" class="error card">{{ errorMessage }}</div>

    <div v-if="!serviceAccountConfigured" class="error card">
      サービスアカウント鍵がありません。Worker の secret <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> に
      鍵 JSON を設定してください(リポジトリには載せません)。
    </div>
    <div v-if="rowMissing" class="card">
      <p class="error">設定行がありません(migrations/0003 の適用、または下の「設定を保存」で作成されます)。</p>
    </div>

    <div class="card">
      <h2>読み込み先の設定</h2>
      <label class="label" for="spreadsheetId">スプレッドシート ID</label>
      <input id="spreadsheetId" class="field" v-model="spreadsheetId" placeholder="例: 1Abc-...-" />

      <label class="label" for="worksheet">ワークシート名(空 = 最初のシート)</label>
      <input id="worksheet" class="field" v-model="worksheet" placeholder="フォームの回答 1" />

      <label class="label" for="codeColumn">code カラム(QR 照会キー)</label>
      <input id="codeColumn" class="field" v-model="codeColumn" placeholder="ID" />

      <label class="label" for="includeColumns">取り込みカラム(空 = 全カラム。改行/カンマ区切り)</label>
      <textarea id="includeColumns" class="field" rows="8" v-model="includeColumns"></textarea>

      <label class="label" for="excludeColumns">除外カラム(取り込みカラムが空のとき有効)</label>
      <textarea id="excludeColumns" class="field" rows="3" v-model="excludeColumns"></textarea>

      <label class="label" for="filterColumn">行フィルタのカラム(有効レコードを表す列。空 = フィルタなし)</label>
      <input id="filterColumn" class="field" v-model="filterColumn" placeholder="例: 有効 / 入金状況" />

      <label class="label" for="filterValues">有効な値(複数可。改行/カンマ区切り。空 = 値が非空なら有効)</label>
      <textarea id="filterValues" class="field" rows="3" v-model="filterValues"></textarea>

      <label class="label" for="rename">キー名の変更(1行 1ペア: <span class="mono">元 -&gt; 新</span>)</label>
      <textarea id="rename" class="field" rows="3" v-model="renameText"></textarea>

      <label class="label" for="targetTable">書き込み先テーブル</label>
      <input id="targetTable" class="field" v-model="targetTable" placeholder="items" />

      <p v-if="savedAt" class="muted">最終保存: {{ savedAt }}<span v-if="configState?.updatedBy"> ({{ configState.updatedBy }})</span></p>

      <button class="btn secondary" type="button" :disabled="saving" @click="saveConfig">
        {{ saving ? '保存中…' : '設定を保存' }}
      </button>
    </div>

    <div class="card">
      <h2>取り込み</h2>
      <p class="muted">
        プレビュー(読み取りのみ・書き込みなし)→ 確認 → 確定(upsert)の順で実行します。
        code が空の行はスキップし、既存の code は payload を上書きします(imported_at を更新)。
        行フィルタを設定すると、そのカラムの値が「有効な値」のいずれかだった行だけ取り込みます。
      </p>
      <button class="btn secondary" type="button" :disabled="previewing || !spreadsheetId" @click="runPreview">
        {{ previewing ? '読み込み中…' : 'プレビュー' }}
      </button>
      <button class="btn" type="button" :disabled="!canCommit || committing" @click="runCommit">
        {{ committing ? '取り込み中…' : '確定して取り込む' }}
      </button>
      <p v-if="preview && preview.truncated" class="error">
        シートが上限を超えています({{ preview.dataRows }}行)。確定はできません。
      </p>
      <p v-if="preview && !preview.worksheetMatched" class="muted">
        設定のワークシート名が見つからないため「{{ preview.sheetTitle }}」を使用しました。
        (シート一覧: {{ preview.sheetTitles.join(', ') }})
      </p>
    </div>

    <div v-if="preview" class="card">
      <h2>プレビュー結果</h2>
      <p class="muted">シート: {{ preview.sheetTitle }} / データ {{ preview.dataRows }}行(code 空スキップ {{ preview.skipped }} / 行フィルタ除外 {{ preview.filtered }})</p>
      <p class="muted">新規 {{ preview.insertCount }}件 / 既存更新 {{ preview.updateCount }}件</p>
      <p class="muted">ヘッダー {{ preview.headerCount }} columns: {{ preview.headers.join(', ') }}</p>
      <p class="muted">取り込み対象: {{ preview.columns.join(', ') }}</p>
      <p class="muted">payload のキー: {{ preview.payloadKeys.join(', ') }}</p>
      <table v-if="preview.sample.length" class="sample">
        <tbody>
          <tr v-for="row in preview.sample" :key="row.code">
            <td class="mono">{{ row.code }}</td>
            <td>{{ sampleEntries(row) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">サンプルは先頭 {{ preview.sample.length }}行のみ表示しています。</p>
    </div>

    <div v-if="committed" class="card">
      <h2>取り込み完了</h2>
      <p class="muted">
        {{ committed.sheetTitle }} → {{ committed.targetTable }}: {{ committed.upserted }}件
        (新規 {{ committed.insertCount }} / 更新 {{ committed.updateCount }} / スキップ {{ committed.skipped }} / 行フィルタ除外 {{ committed.filtered }})
      </p>
    </div>
  </div>
</template>

<style scoped>
.label {
  display: block;
  color: var(--muted);
  font-size: 13px;
  margin: 12px 0 6px;
}

.mono {
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 13px;
}

.sample {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
  font-size: 13px;
}

.sample td {
  border-top: 1px solid #334155;
  padding: 6px 4px;
  vertical-align: top;
  color: var(--muted);
}

.sample td.mono {
  color: var(--text);
  white-space: nowrap;
}
</style>
