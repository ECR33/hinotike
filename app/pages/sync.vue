<script setup lang="ts">
import { describeApiError } from '#shared/utils/apiError'
import type { MeState } from '#shared/utils/auth'
import { spreadsheetIdFrom, spreadsheetIdWasParsedFromLink } from '#shared/utils/sync'
import type { ImportPageResponse, SourceConfigResponse, SourcePreviewResponse, SyncSource } from '#shared/utils/sync'
import { formatJst, type ScanConfigResponse } from '#shared/utils/scan'
import { OFFLINE_ITEM_MAX, OFFLINE_PAGE_BATCH, type OfflineMeta } from '#shared/utils/offline'
import { purgeDeviceData, type OfflineItemRow } from '~/utils/offlineStore'

/**
 * Spreadsheet **データセットの管理画面**(登録済みユーザのみ。グローバルミドルウェアが保護する)。
 *
 * 設計(doc/docs/datasets.md):
 * - 取り込み**定義**は DB(public.sync_sources)の複数行。ここで追加・編集・削除する(1行 = 1データセット)。
 * - データ本体は Supabase に置かない。この画面の「スマホに取り込み」が `GET /api/import` を
 *   最後まで読んで IndexedDB のミラーに保存し、以後の照会・一覧・記録は端末内のデータで走る。
 * - シートが唯一の正。記録・備考の書き戻しは /api/scan-flush / /api/remark-update がシートへ直接書く。
 * ログアウトは BottomNav の項目で行う(ページ内ボタンは重複)。
 */

const authState = useState<MeState | null>('auth-state', () => null)
const me = authState.value ?? await $fetch<MeState>('/api/me', { headers: useRequestHeaders(['cookie']) })
if (authState.value === null) authState.value = me

const configState = useState<SourceConfigResponse | null>('sync-config', () => null)
if (configState.value === null) {
  configState.value = await $fetch<SourceConfigResponse>('/api/sync-config', {
    headers: useRequestHeaders(['cookie']),
  }).catch(() => null)
}

const sources = computed<SyncSource[]>(() => configState.value?.sources ?? [])
const selectedIndex = ref(0)
const selected = computed<SyncSource | null>(() => sources.value[selectedIndex.value] ?? null)

// 編集フォーム(選択中のソースの値から初期化する。選択が変われば引き直す)。
const name = ref('')
const spreadsheetId = ref('')
const worksheet = ref('')
const codeColumn = ref('ID')
const includeColumns = ref('')
const excludeColumns = ref('')
const filterColumn = ref('')
const filterValues = ref('')
const renameText = ref('')
const enabledFlag = ref(true)

/**
 * 入力からスプレッドシート ID を解決する(shared/utils/sync の `spreadsheetIdFrom`)。
 * 人間が読むのはシートへのリンクなので、`…/spreadsheets/d/<id>/…` のリンクをそのまま貼れば
 * ID 部分を選択して転記しなくても済む。ID そのものもそのまま通る。
 * server の `normalizeSource` も同じ関数を使うので、保存後の表示は ID になる。
 * `#gid=` はワークシート(sheetId の数値)なのでワークシート名には使わない(別の欄で指定)。
 */
const resolvedSpreadsheetId = computed(() => spreadsheetIdFrom(spreadsheetId.value))
/** リンクから拾ったときの案内(ID そのもののときは出さない)。 */
const parsedFromLink = computed(() => spreadsheetIdWasParsedFromLink(spreadsheetId.value))

function loadForm(source: SyncSource | null): void {
  if (!source) return
  name.value = source.name
  spreadsheetId.value = source.spreadsheetId
  worksheet.value = source.worksheet ?? ''
  codeColumn.value = source.codeColumn
  includeColumns.value = source.includeColumns.join('\n')
  excludeColumns.value = source.excludeColumns.join('\n')
  filterColumn.value = source.filterColumn ?? ''
  filterValues.value = source.filterValues.join('\n')
  renameText.value = Object.entries(source.rename).map(([from, to]) => `${from} -> ${to}`).join('\n')
  enabledFlag.value = source.enabled
}
loadForm(sources.value[0] ?? null)
watch(selected, (s) => loadForm(s))

/** 改行/カンマ区切りを項目リストへ。 */
function parseList(text: string): string[] {
  return text.split(/[\n,]/).map((v) => v.trim()).filter(Boolean)
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

/** 選択中のソースのフォーム値(未保存の編集を list に写して送る)。 */
function formPayload(source: SyncSource): SyncSource {
  return {
    ...source,
    name: name.value.trim() || source.name,
    // リンク文字列からも ID を解決して送る(server でも同じ正規化走るが、ドラフトのプレビュー
    // 案内と送信値を一致させるためここで解決する)
    spreadsheetId: resolvedSpreadsheetId.value,
    worksheet: worksheet.value.trim() || null,
    codeColumn: codeColumn.value.trim() || 'ID',
    includeColumns: parseList(includeColumns.value),
    excludeColumns: parseList(excludeColumns.value),
    filterColumn: filterColumn.value.trim() || null,
    filterValues: parseList(filterValues.value),
    rename: parseRename(renameText.value),
    enabled: enabledFlag.value,
  }
}

/** 送るリスト = 全ソース(選択中のものはフォーム値で上書き)。id 無しは新規 insert。 */
function payloadSources(): SyncSource[] {
  return sources.value.map((s) => (s.id === selected.value?.id ? formPayload(s) : s))
}

const saving = ref(false)
const previewing = ref(false)
const importing = ref(false)
const importProgress = ref('')
const errorMessage = ref<string | null>(null)
const savedAt = ref<string | null>(configState.value?.updatedAt ?? null)
const preview = ref<SourcePreviewResponse | null>(null)
const importNote = ref<string | null>(null)

/** API の失敗を画面向けの案内にする(shared/utils/apiError の理由コード → 文言。401/403 もここで決める)。 */
function describeError(e: unknown): string {
  return describeApiError(e).friendly
}

async function saveSources() {
  saving.value = true
  errorMessage.value = null
  preview.value = null
  try {
    const res = await $fetch<SourceConfigResponse>('/api/sync-config', {
      method: 'POST',
      headers: useRequestHeaders(['cookie']),
      body: { sources: payloadSources() },
    })
    configState.value = res
    savedAt.value = res.updatedAt
    // 正規化された値をフォームに反映(不正入力の補正が見えるようにする)。
    // 新規作成は server が id を振る = プレビューと取り込みが使えるようになる。
    const hit = res.sources.find((s) => s.name === (name.value.trim() || selected.value?.name)) ?? res.sources[selectedIndex.value] ?? null
    loadForm(hit)
  } catch (e) {
    errorMessage.value = describeError(e)
  } finally {
    saving.value = false
  }
}

/** 新しいデータセットのドラフトを追加(保存すると id が振られ、取り込みできる)。 */
function addDataset() {
  sources.value.push({
    id: null,
    name: `新しいデータセット ${sources.value.length + 1}`,
    spreadsheetId: '',
    worksheet: null,
    codeColumn: 'ID',
    includeColumns: [],
    excludeColumns: [],
    filterColumn: null,
    filterValues: [],
    rename: {},
    enabled: true,
    updatedAt: null,
    updatedBy: null,
  })
  selectedIndex.value = sources.value.length - 1
  loadForm(sources.value[selectedIndex.value] ?? null)
  importNote.value = '新しいデータセットを作成しました(「定義を保存」で取り込みできるようになります)'
}

/** 選択中のデータセットを定義から削除(記録モードが紐づいていると server が 400 にする = 無効化を使ってください)。 */
async function removeSelected() {
  const target = selected.value
  if (!target) return
  if (target.id === null) {
    sources.value.splice(selectedIndex.value, 1)
    selectedIndex.value = 0
    loadForm(sources.value[0] ?? null)
    importNote.value = '未保存のデータセットを画面から除去しました'
    return
  }
  errorMessage.value = null
  try {
    const next = sources.value.filter((s) => s.id !== target.id)
    const res = await $fetch<SourceConfigResponse>('/api/sync-config', {
      method: 'POST',
      headers: useRequestHeaders(['cookie']),
      body: { sources: next },
    })
    configState.value = res
    selectedIndex.value = 0
    loadForm(res.sources[0] ?? null)
    importNote.value = `データセット "${target.name}" を削除しました`
  } catch (e) {
    errorMessage.value = describeError(e)
  }
}

/** 選択中のデータセットのシートを**読み取りのみ**でプレビュー(書き込まない)。 */
async function runPreview() {
  const target = selected.value
  if (target?.id == null) {
    importNote.value = 'プレビューは保存済みのデータセットで実行できます(先に「定義を保存」)'
    return
  }
  previewing.value = true
  errorMessage.value = null
  try {
    preview.value = await $fetch<SourcePreviewResponse>('/api/source-preview', {
      method: 'POST',
      headers: useRequestHeaders(['cookie']),
      body: { sourceId: target.id },
    })
  } catch (e) {
    errorMessage.value = describeError(e)
  } finally {
    previewing.value = false
  }
}


// ── スマホへの取り込み(端末内のミラー)──────────────────
const { meta: offlineMeta, localWork, uidMismatch, queueCount: offlineQueueCount, refreshQueueCount } = useOfflineState()

/**
 * ミラーのメタに写す **uid**(取り込んだ利用者)。auth-state が未解決なら `/api/me` で引く
 * (解決できないときは null = 取り込みしない。uid の無いメタは別ユーザが読めるので置かない)。
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
 * 選択中のデータセットを**この端末に取り込む**(GET /api/import の分页を最後まで読む)。
 * 取り込みはミラーをそのデータセットで置き換える(= 「今どちらのデータで作業するか」の切替)。
 * SW の precache 用に作業ページの HTML もためる(dev では SW が無いので素通し)。
 */
async function importToPhone() {
  const target = selected.value
  if (target?.id == null) {
    importNote.value = '取り込みは保存済みのデータセットで実行できます(先に「定義を保存」)'
    return
  }
  if (importing.value) return
  const uid = await currentUid()
  if (!uid) {
    errorMessage.value = 'ログイン情報が解決できないため取り込みできません(再ログインしてから実行してください)'
    return
  }
  importing.value = true
  errorMessage.value = null
  importNote.value = null
  const sourceId = target.id
  const rows: OfflineItemRow[] = []
  let cursor = ''
  let capped = false
  let total = 0
  try {
    for (;;) {
      const page = await $fetch<ImportPageResponse>('/api/import', {
        query: { sourceId, limit: OFFLINE_PAGE_BATCH, ...(cursor ? { cursor } : {}) },
        headers: useRequestHeaders(['cookie']),
      })
      rows.push(...page.rows.map((r) => ({ code: r.code, payload: r.payload, sourceId })))
      total = page.total
      importProgress.value = `${rows.length}/${total}件 を取り込み中…`
      if (!page.nextCursor) break
      if (rows.length >= OFFLINE_ITEM_MAX) {
        capped = true
        break
      }
      cursor = page.nextCursor
    }
    const cfg = await $fetch<ScanConfigResponse>('/api/scan-config', { query: { sourceId } })
    const meta: OfflineMeta = {
      enabled: true,
      sourceId,
      uid,
      sourceName: target.name,
      source: target,
      snapshotAt: new Date().toISOString(),
      itemCount: rows.length,
      config: cfg,
      capped,
    }
    await offlineSaveSnapshot(meta, rows)
    writeOfflineMetaToStorage(meta)
    offlineMeta.value = meta
    await refreshQueueCount()
    // オフライン起動用のページキャッシュをためる(SW が NetworkFirst で缓存)
    await fetch('/scan').catch(() => {})
    await fetch('/items').catch(() => {})
    await fetch('/').catch(() => {})
    importNote.value = `取り込み完了: "${target.name}" ${rows.length}件${capped ? `(端末の上限 ${OFFLINE_ITEM_MAX}件で打ち切り)` : ''}。以後の照会・一覧・記録はこの端末内のデータに対して走ります(任意のタイミングでシートへ書き戻します)。`
  } catch (e) {
    errorMessage.value = describeError(e)
  } finally {
    importing.value = false
    importProgress.value = ''
  }
}

/** ミラー(この端末の取り込みデータ)を完全削除。ためた記録は捨てずに氏名だけ除去する(確定できる)。 */
async function deleteMirror() {
  try {
    const { strippedNames, queueKept } = await purgeDeviceData()
    offlineMeta.value = null
    offlineQueueCount.value = queueKept
    importNote.value =
      `端末の取り込みデータとページキャッシュを削除しました${
        strippedNames > 0 ? ` / 記録の待機 ${strippedNames}件の氏名を除去しました` : ''
      }${queueKept > 0 ? ` / 待機 ${queueKept}件は code として残ります(「スキャン」で確定できます)` : ''}`
  } catch (e) {
    errorMessage.value = describeError(e)
  }
}

function sampleEntries(row: { payload: Record<string, string> }): string {
  return Object.entries(row.payload).map(([k, v]) => `${k}: ${v}`).join(' / ')
}

const serviceAccountConfigured = computed(() => configState.value?.serviceAccountConfigured ?? false)
const rowMissing = computed(() => configState.value?.rowMissing ?? false)
const mirrorLabel = computed(() => {
  const m = offlineMeta.value
  if (!m) return '端末に取り込みデータはありません'
  if (uidMismatch.value) return `"${m.sourceName}" ${m.itemCount}件・別利用者が取り込んだデータ(この画面では使いません)`
  return `"${m.sourceName}" ${m.itemCount}件・取り込み ${formatJst(m.snapshotAt)}${m.capped ? '(上限で打ち切り)' : ''}${localWork.value ? '・ローカル作業 ON' : '・ローカル作業 OFF'}`
})
</script>


<template>
  <div class="page">
    <h1>Spreadsheet データセット</h1>

    <div v-if="errorMessage" class="error card">{{ errorMessage }}</div>
    <div v-if="importNote" class="card">{{ importNote }}</div>

    <div v-if="!serviceAccountConfigured" class="error card">
      サービスアカウント鍵がありません。Worker の secret <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> に
      鍵 JSON を設定してください(リポジトリには載せません)。取り込みと書き戻しはできません。
    </div>
    <div v-if="rowMissing" class="card">
      <p class="error">データセットの定義がありません(migrations/0007 の適用、または上の「定義を保存」で作成されます)。</p>
    </div>

    <div class="card">
      <h2>データセットの選択</h2>
      <div class="chips">
        <button
          v-for="(s, i) in sources"
          :key="s.id ?? s.name"
          class="chip"
          :class="{ active: i === selectedIndex }"
          type="button"
          @click="selectedIndex = i"
        >
          {{ s.name }}<span v-if="s.id === null" class="muted">(未保存)</span><span v-if="!s.enabled" class="muted">(無効)</span>
        </button>
        <button class="chip secondary" type="button" @click="addDataset">+ データセットを追加</button>
      </div>
      <p class="muted">
        定義は DB(public.sync_sources)に複数保持します。データ本体は Supabase に置かず、
        作業する端末に取り込みます(シートが唯一の正)。
      </p>
    </div>

    <div v-if="selected" class="card">
      <h2>定義の編集: {{ selected.name }}</h2>
      <label class="label" for="dsName">表示名(選択に出る名前)</label>
      <input id="dsName" class="field" v-model="name" placeholder="例: 2026 本番のチケット" />

      <label class="label" for="spreadsheetId">スプレッドシート ID または シートのリンク</label>
      <input
        id="spreadsheetId"
        class="field"
        v-model="spreadsheetId"
        placeholder="例: https://docs.google.com/spreadsheets/d/1Abc-…/edit#gid=0(ID だけでも可)"
      />
      <p v-if="parsedFromLink" class="muted">
        リンクから ID を取り出しました: <span class="mono">{{ resolvedSpreadsheetId }}</span>
      </p>
      <p v-else-if="spreadsheetId.trim() && !resolvedSpreadsheetId" class="muted">
        ID を読み出せません。シートのリンク(共有ダイアログでコピーできる URL)を貼るか、ID 部分を入力してください
      </p>
      <p class="muted">
        リンクの <span class="mono">#gid=…</span> はタブの内部 ID で、ワークシート名にはなりません
        (特定のタブを読む場合は下の「ワークシート名」で指定してください)
      </p>

      <label class="label" for="worksheet">ワークシート名(空 = 最初のシート)</label>
      <input id="worksheet" class="field" v-model="worksheet" placeholder="フォームの回答 1" />

      <label class="label" for="codeColumn">code カラム(QR 照会キー)</label>
      <input id="codeColumn" class="field" v-model="codeColumn" placeholder="ID" />

      <label class="label" for="includeColumns">取り込みカラム(空 = 全カラム。改行/カンマ区切り。個数カラムの並び順が照会結果の商品表示順になります)</label>
      <textarea id="includeColumns" class="field" rows="8" v-model="includeColumns"></textarea>

      <label class="label" for="excludeColumns">除外カラム(取り込みカラムが空のとき有効)</label>
      <textarea id="excludeColumns" class="field" rows="3" v-model="excludeColumns"></textarea>

      <label class="label" for="filterColumn">行フィルタのカラム(有効レコードを表す列。空 = フィルタなし)</label>
      <input id="filterColumn" class="field" v-model="filterColumn" placeholder="例: 有効 / 入金状況" />

      <label class="label" for="filterValues">有効な値(複数可。改行/カンマ区切り。空 = 値が非空なら有効)</label>
      <textarea id="filterValues" class="field" rows="3" v-model="filterValues"></textarea>

      <label class="label" for="rename">キー名の変更(1行 1ペア: <span class="mono">元 -&gt; 新</span>)</label>
      <textarea id="rename" class="field" rows="3" v-model="renameText"></textarea>

      <label class="label checkbox">
        <input id="dsEnabled" type="checkbox" v-model="enabledFlag" />
        このデータセットを運用に載せる(オフにすると選択に出ません。削除はしません)
      </label>

      <p v-if="savedAt" class="muted">最終保存: {{ savedAt }}<span v-if="configState?.updatedBy"> ({{ configState.updatedBy }})</span></p>

      <div class="actions">
        <button class="btn secondary" type="button" :disabled="saving" @click="saveSources">
          {{ saving ? '保存中…' : '定義を保存' }}
        </button>
        <button class="btn secondary" type="button" :disabled="previewing || !resolvedSpreadsheetId" @click="runPreview">
          {{ previewing ? '読み込み中…' : 'シートをプレビュー' }}
        </button>
        <button class="btn" type="button" :disabled="importing || !resolvedSpreadsheetId" @click="importToPhone">
          {{ importing ? '取り込み中…' : 'このスマホに取り込む' }}
        </button>
        <button class="btn secondary" type="button" @click="removeSelected">このデータセットを削除</button>
      </div>
      <p v-if="importProgress" class="muted">{{ importProgress }}</p>
    </div>

    <div class="card">
      <h2>この端末のデータ</h2>
      <p class="muted">{{ mirrorLabel }}</p>
      <p class="muted">
        取り込み済みのデータセットに対して、照会・一覧・スキャン記録が走ります(通信があるときもローカル優先)。
        記録の待機 {{ offlineQueueCount }}件は「スキャン」画面で任意のタイミングにシートへ書き戻します。
      </p>
      <p v-if="uidMismatch" class="error">
        この端末のデータは別の利用者が取り込んだものです(氏名・備考を含むためこの画面では使いません)。
        下の「端末のデータを完全に削除」で捨てられます。
      </p>
      <div class="actions">
        <NuxtLink class="btn secondary" to="/scan">スキャン(作業)</NuxtLink>
        <NuxtLink class="btn secondary" to="/items">一覧</NuxtLink>
        <!-- ミラー + localStorage + ページキャッシュをまとめて捨てる(記録の待機は氏名だけ除去して残す) -->
        <button class="btn secondary danger" type="button" @click="deleteMirror">端末のデータを完全に削除</button>
      </div>
    </div>


    <div v-if="preview" class="card">
      <h2>プレビュー結果</h2>
      <p v-if="!preview.ok" class="error">シートを読み取れません: {{ preview.error }}</p>
      <template v-else>
        <p class="muted">シート: {{ preview.sheetTitle }} / データ {{ preview.dataRows }}行(code 空スキップ {{ preview.skipped }} / 行フィルタ除外 {{ preview.filtered }})</p>
        <p class="muted">取り込み対象 {{ preview.rowCount }}件 / payload のキー: {{ preview.payloadKeys.join(', ') }}</p>
        <p v-if="preview.truncated" class="error">シートがサーバー側の上限を超えています。取り込みは打ち切られます。</p>
        <p v-if="!preview.worksheetMatched" class="muted">
          設定のワークシート名が見つからないため「{{ preview.sheetTitle }}」を使用しました。(シート一覧: {{ preview.sheetTitles.join(', ') }})
        </p>
        <p v-if="preview.codeColumnMissing" class="error">code カラムがヘッダーにありません。</p>
        <p v-if="preview.filterColumnMissing" class="error">行フィルタのカラムがヘッダーにありません。</p>
        <p class="muted">ヘッダー {{ preview.headers?.length ?? 0 }} columns: {{ preview.headers?.join(', ') }}</p>
        <p class="muted">取り込み対象カラム: {{ preview.columns.join(', ') }}</p>
        <table v-if="preview.sample.length" class="sample">
          <tbody>
            <tr v-for="row in preview.sample" :key="row.code">
              <td class="mono">{{ row.code }}</td>
              <td>{{ sampleEntries(row) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="muted">サンプルは先頭 {{ preview.sample.length }}行のみ表示しています。</p>
      </template>
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

.label.checkbox {
  display: flex;
  gap: 8px;
  align-items: center;
}

.mono {
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 13px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 6px 10px;
  background: #0f172a;
  color: var(--text);
  font-size: 13px;
}

.chip.active {
  border-color: var(--accent, #38bdf8);
  background: #1e293b;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
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

