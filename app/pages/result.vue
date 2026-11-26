<script setup lang="ts">
// 保護は app/middleware/auth.global.ts(グローバル+ホワイトリスト)で行う

import { describeApiError } from '#shared/utils/apiError'
import { isQuantityKey, ITEM_GROUP_KEY, ITEM_NAME_KEY, ITEM_REMARK_KEY, ITEM_YEAR_KEY, payloadValue, quantityName, REMARK_MAX_LENGTH } from '#shared/utils/items'
import { formatJst, scanStatusMessage, type ScanHistoryResponse } from '#shared/utils/scan'
import type { OfflineMeta } from '#shared/utils/offline'
import { mirrorBelongsToUser } from '#shared/utils/offline'
import type { MeState } from '#shared/utils/auth'

const route = useRoute()
const code = computed(() => String(route.query.code ?? ''))
/** 認証状態(SSR が埋め込む)。端末ミラーの uid と比較して別利用者の氏名を照会結果に出さない。 */
const authState = useState<MeState | null>('auth-state', () => null)

/** 端末ミラーが「今ログインしている利用者」のデータか(有効フラグ + uid 一致)。 */
function localMirror(meta: OfflineMeta | null): boolean {
  return meta?.enabled === true && mirrorBelongsToUser(meta, authState.value?.uid)
}

type LookupResult = {
  found: boolean
  code: string
  row: { code: string; payload: Record<string, string> } | null
  productOrder?: string[]
  sourceId?: number
  sheetTitle?: string
}
type RemarkUpdateResponse = {
  ok: true
  code: string
  remark: string
  sheetTitle: string
  range: string
  sourceId: number
}

/**
 * 照会の解決状態。**照会は端末内のミラー(取り込みデータ)だけ**で行う(server の照会 API は無い)。
 * storage は client からのみ読めるので SSR と初期 hydration は `noMirror`(案内だけ描画し、マウント後に
 * この端末のミラーを照会する)。`foreign` = 別利用者が取り込んだミラー(氏名を見せない)、
 * `uidPending` = 取り込み済みだがログイン状態が未解決(氏名を出さない)。
 */
type LookupStatus = 'noMirror' | 'ready' | 'foreign' | 'uidPending'

/** 照会結果(client のマウントで解決し、useState でページ遷移間に保持する)。 */
const result = useState<LookupResult | null>('lookup-result', () => null)
const lookupStatus = useState<LookupStatus>('lookup-status', () => 'noMirror')
const errorMessage = useState<string | null>('lookup-error', () => null)
/** 照会がどの取り込み(ミラーメタ)に対して走ったか(注記の取り込み日時・件数用)。 */
const offlineMeta = useState<OfflineMeta | null>('lookup-offline-meta', () => null)

/**
 * 端末ミラーから照会する(この画面の唯一の照会経路)。
 * 未取り込み・別利用者の取り込み・uid 未解決は照会せず案内を出す(端末の氏名を別ユーザに見せない)。
 * 商品表示順は取り込み時の定義スナップショット(includeColumns の行順を rename 後のキーに写す)から作る。
 */
async function lookupFromMirror(c: string): Promise<void> {
  if (!import.meta.client || !c) return
  const meta = readOfflineMetaFromStorage()
  offlineMeta.value = meta
  errorMessage.value = null
  if (!meta || !meta.enabled) {
    result.value = null
    lookupStatus.value = 'noMirror'
    return
  }
  if (!authState.value?.uid) {
    result.value = null
    lookupStatus.value = 'uidPending'
    return
  }
  if (!mirrorBelongsToUser(meta, authState.value?.uid)) {
    result.value = null
    lookupStatus.value = 'foreign'
    return
  }
  lookupStatus.value = 'ready'
  try {
    const row = await offlineGetItem(meta.sourceId, c)
    result.value = {
      found: row !== undefined,
      code: c,
      row: row ? { code: row.code, payload: row.payload } : null,
      productOrder: productOrderKeys(meta.source.includeColumns, meta.source.rename),
      sourceId: meta.sourceId,
      sheetTitle: meta.config.sheetTitle ?? '',
    }
  } catch (e: unknown) {
    errorMessage.value = '端末内のデータの読み出しに失敗しました(IndexedDB が使えない・開けない環境です)'
    console.error('[result] mirror lookup failed:', e instanceof Error ? e.message : e)
  }
}

// code が無い画面(/result 単体)は照会しない(空の案内カードを出す)。
// storage は client からのみ読めるので、マウントでこの端末のミラーを照会する(SSR は案内だけ描画する)。
onMounted(() => {
  void lookupFromMirror(code.value)
})

// クライアント遷移で code が変わった場合は再照会する
watch(code, (c) => {
  if (result.value?.code !== c) void lookupFromMirror(c)
  // code が変わったら編集状態は古い code の内容なので閉じる
  if (result.value?.code !== c) closeRemarkEditor()
  if (historyFor.value !== c) void fetchHistory(c)
})

// uid が後から解決される(缓存 HTML を開いた等で auth-state が未解決)場合、ミラーの照会を打ち直す
watch(() => authState.value?.uid, () => void lookupFromMirror(code.value))

/**
 * スキャンの記録履歴(scan_events)。この code が「いつ・どのモードで・誰が」読み取ったかの監査履歴。
 * シートセルは1値しか残らないので、来場・配布の読み取り時刻の履歴はここが正(/records でも閲覧できる)。
 * SSR で解決して useState で引き継ぐ(照会は client のマウントで走る。code が違う缓存は stale なので client で再fetch)。
 */
const history = useState<ScanHistoryResponse | null>('scan-history', () => null)
const historyFor = useState<string>('scan-history-code', () => '')

async function fetchHistory(c: string) {
  if (!c) {
    history.value = null
    historyFor.value = ''
    return
  }
  // この端末のデータで照会している間は履歴(/api/scan-history)を通信しない(照会は端末内のミラーから出す)。
  // 未取り込み・別利用者のミラー(uid 不一致)では照会しないので、履歴は通信して読む。
  if (localMirror(readOfflineMetaFromStorage())) {
    history.value = null
    historyFor.value = c
    return
  }
  try {
    history.value = await $fetch<ScanHistoryResponse>('/api/scan-history', {
      query: { code: c, limit: 20 },
      headers: useRequestHeaders(['cookie']),
    })
  } catch {
    // 履歴の取得失敗は照会結果を止めない(照会本体は別 fetch なので注記だけ出す)
    history.value = null
  }
  historyFor.value = c
}

const historyCachedForCurrentCode = history.value !== null && historyFor.value === code.value
if (code.value && !historyCachedForCurrentCode) {
  await fetchHistory(code.value)
}

/** 備考欄のインライン編集(保存は /api/remark-update → シートへ。端末ミラーにも同じ値を写す)。 */
const editingRemark = ref(false)
const remarkDraft = ref('')
const remarkBusy = ref(false)
const remarkError = useState<string | null>('remark-error', () => null)

function closeRemarkEditor() {
  editingRemark.value = false
  remarkError.value = null
}

function startRemarkEdit() {
  remarkDraft.value = payloadValue(payload.value, ITEM_REMARK_KEY)
  remarkError.value = null
  editingRemark.value = true
}

async function saveRemark() {
  if (remarkBusy.value || !result.value?.row) return
  remarkBusy.value = true
  remarkError.value = null
  try {
    // 照会したデータセットと同じシートへ書く(取り込み済みのミラーと同じ dataset。未指定は server が既定を選ぶ)
    const res = await $fetch<RemarkUpdateResponse>('/api/remark-update', {
      method: 'POST',
      body: { code: result.value.code, remark: remarkDraft.value, sourceId: offlineMeta.value?.sourceId },
    })
    // 保存結果を再fetchなしで画面に反映(trim 後の値。空はキー削除 = 取り込み側の empty skip と同じ)
    const p = { ...(result.value.row.payload ?? {}) } as Record<string, string>
    if (res.remark) p[ITEM_REMARK_KEY] = res.remark
    else delete p[ITEM_REMARK_KEY]
    result.value = { ...result.value, row: { ...result.value.row, payload: p } }
    editingRemark.value = false
    // 端末ミラーにも同じ値を書く(取り込み済みのデータセットなら一覧・照会が即時に追随する)。
    // ミラー更新の失敗はシート保存を止めない(注記だけ出す = 次の取り込みで一致する)。
    // uid 不一致(別利用者のミラー)には書かない(別ユーザの端末データを自分の備考で汚さない)。
    const meta = readOfflineMetaFromStorage()
    if (meta?.enabled && localMirror(meta) && meta.sourceId === res.sourceId) {
      try {
        await offlineSetPayloadKey(meta.sourceId, res.code, ITEM_REMARK_KEY, res.remark)
      } catch {
        remarkError.value = 'シートには保存済みです(端末内のデータの更新に失敗したため、次の取り込みで一致します)'
      }
    }
  } catch (e: unknown) {
    remarkError.value = describeApiError(e).friendly
  } finally {
    remarkBusy.value = false
  }
}

const row = computed(() => result.value?.row ?? null)
const payload = computed(() => {
  const p = row.value?.payload
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
})

/** 見出しに出すキー(氏名 + 年組)。まとめ枠に出すキーと合わせ、残りは下の詳細リストに回す。 */
const HEAD_KEYS = [ITEM_NAME_KEY, ITEM_YEAR_KEY, ITEM_GROUP_KEY]

/** 入金状況は見出しのタグに出すので、詳細の行として重複表示しない。 */
const STATUS_KEY = '入金状況'

/** 金額・支払いのまとまり(枠で囲んで横に並べる)。表示順はこの並び。 */
const MONEY_KEYS = ['購入金額', '入金額', '支払い方法']

/** レビューの星のような個数表示のスロット数(商品の最大個数)。 */
const PRODUCT_MAX = 6

const headName = computed(() => payloadValue(payload.value, ITEM_NAME_KEY))
const yearGroup = computed(() => {
  const year = payloadValue(payload.value, ITEM_YEAR_KEY)
  const group = payloadValue(payload.value, ITEM_GROUP_KEY)
  const y = year ? `${year}年` : ''
  const g = group ? `${group}組` : ''
  return y && g ? `${y} ${g}` : y || g
})

/** 入金状況は色で状態を出す(未系は警告色、それ以外は通常色)。キー名は columns.config.json と合わせる。 */
const status = computed(() => payloadValue(payload.value, STATUS_KEY))
const statusTone = computed(() => (status.value.includes('未') ? 'tag warn' : 'tag ok'))

/** 金額・支払いのまとまり。空のキーはセルを出さない(枠がスカスカにならない)。 */
const money = computed<Array<{ key: string; label: string; value: string; wide: boolean }>>(() => {
  const p = payload.value
  return MONEY_KEYS.filter((key) => !isBlank(p[key])).map((key, i) => ({
    key,
    label: key,
    value: formatMoney(key, p[key]),
    // 狭い画面では支払い方法だけ1行を占有させる(2列で余るセルの余白を埋める)
    wide: i === MONEY_KEYS.length - 1,
  }))
})

/**
 * 個数系キーを商品名・個数(数値なら count、想定外の値なら raw)にまとめる。
 * 並びは lookup が返す商品表示順(同期設定の include_columns の並び。/sync で調整できる)。
 * 順に載っていないキーは末尾に回し、その中では比較順(環境差のない並び。
 * localeCompare は ICU の挙動差で SSR/クライアントの文字列がずれ得る)。
 */
const quantities = computed<Array<{ key: string; name: string; count: number | null; raw: string }>>(() => {
  const p = payload.value
  const order = result.value?.productOrder ?? []
  const rank = (key: string): number => {
    const i = order.indexOf(key)
    return i === -1 ? order.length : i
  }
  return Object.keys(p)
    .filter((key) => isQuantityKey(key) && !isBlank(p[key]))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => {
      const raw = String(p[key])
      return { key, name: quantityName(key), count: /^\d+$/.test(raw) ? Number(raw) : null, raw }
    })
})

/** 星の表示(個数 = 埋まったスロット、最大 PRODUCT_MAX 個)。想定外の大きい値は星を6個まで埋めて数値はそのまま出す。 */
const products = computed<
  Array<{ key: string; name: string; on: number; off: number; countLabel: string; zero: boolean }>
>(() =>
  quantities.value.map((q) => {
    const count = q.count
    const on = count === null ? 0 : Math.min(Math.max(count, 0), PRODUCT_MAX)
    return {
      key: q.key,
      name: q.name,
      on,
      off: PRODUCT_MAX - on,
      countLabel: count === null ? q.raw : `${count}個`,
      zero: count === 0,
    }
  }),
)

/** 合計個数(数値化できない個数があるときは null = 合計を出さない)。 */
const productTotal = computed<number | null>(() => {
  const raw = quantities.value.map((q) => q.count)
  const counts = raw.filter((c): c is number => c !== null)
  // 数値化できない個数があるときは合計を出さない(null)
  if (counts.length !== raw.length) return null
  return counts.reduce((sum, c) => sum + c, 0)
})

// 詳細リストは まとめ枠・見出し・個数系を出さない残りのキーだけ。並び: 領収書 → 備考 → その他(元の順)。
// columns.config.json の includeColumns とずれても「その他」に落ちるので取りこぼさない。
const DETAIL_LEAD = ['領収書']
const DETAIL_TAIL = ['備考']

/** 1件を pairs に追加し、taken に登録する(他枠で既に出したキーはリスト側で出さない) */
function pushDetail(
  pairs: Array<[string, string]>,
  taken: Set<string>,
  key: string,
  v: unknown
): void {
  if (isBlank(v)) {
    return
  }
  pairs.push([key, formatDetail(key, v)])
  taken.add(key)
}

/** items.row(payload jsonb)を表示用のラベル/値のリストに flatten する */
const entries = computed<Array<[string, string]>>(() => {
  const r = row.value
  if (!r) return []
  const p = payload.value
  const pairs: Array<[string, string]> = []
  // 見出し・金額枠・入金状況タグ・商品枠に出したキーはリスト側で重複表示しない
  const taken = new Set<string>([...HEAD_KEYS, ...MONEY_KEYS, STATUS_KEY])
  for (const q of quantities.value) {
    taken.add(q.key)
  }

  for (const key of DETAIL_LEAD) {
    if (key in p) pushDetail(pairs, taken, key, p[key])
  }
  for (const key of DETAIL_TAIL) {
    if (key in p) pushDetail(pairs, taken, key, p[key])
  }
  // 備考が空/欠落の行でも編集できるように、空の備考行を必ず出す(編集ボタンが「追加」の入口になる)
  if (!taken.has(ITEM_REMARK_KEY)) pairs.push([ITEM_REMARK_KEY, ''])
  for (const [k, v] of Object.entries(p)) {
    if (!taken.has(k)) pushDetail(pairs, taken, k, v)
  }

  // シート由来の行は { code, payload } の2列だけ(payload 以外に表示列は無い)。
  return pairs
})

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === ''
}

/**
 * 表示用整形。金額系は 3桁区切り + 円。
 * SSR とクライアントで同じ文字列になる整形だけ使う(toLocaleString は ICU の locale 依存で
 * hydration mismatch の原因になる)。
 */
function formatDetail(key: string, v: unknown): string {
  if (typeof v === 'object') return v === null ? '' : JSON.stringify(v)
  const raw = String(v)
  if (/金額|額$/.test(key) && /^\d+$/.test(raw)) return `${groupThousands(raw)} 円`
  return raw
}

function formatMoney(key: string, v: unknown): string {
  return formatDetail(key, v)
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
</script>

<template>
  <div class="page">
    <h1>照会結果</h1>

    <div v-if="errorMessage" class="error card">{{ errorMessage }}</div>

    <div v-else-if="!code" class="card">
      <p class="muted result-note">
        コードが指定されていません。QRスキャンか、一覧の行から開いてください。
      </p>
    </div>

    <!-- 照会できる端末ミラーが無い端末の案内(storage は client からのみ読めるので SSR もこの案内を出す) -->
    <div v-else-if="lookupStatus === 'noMirror'" class="card">
      <p class="muted result-note">
        この端末には取り込み済みのデータがありません。取り込み済みの端末でこの画面を開くか、「データの設定」(/sync)でこのデータセットを「このスマホに取り込む」してください(照会は端末内のデータから行います)。
      </p>
    </div>
    <div v-else-if="lookupStatus === 'foreign'" class="error card">
      <p>
        この端末のデータは別の利用者が取り込んだものです(氏名を含むため照会しません)。この利用者として取り込みし直すか、「データの設定」(/sync)で端末のデータを削除してください。
      </p>
    </div>
    <div v-else-if="lookupStatus === 'uidPending'" class="card">
      <p class="muted result-note">
        取り込み済みのデータがありますがログイン状態が解決できていないため照会しません(ログインしてから開いてください)。
      </p>
    </div>

    <div v-else-if="result && !result.found" class="card result-card result-empty">
      <p class="result-code">コード {{ code }}</p>
      <p class="result-empty-text">該当するデータが見つかりませんでした。</p>
      <p v-if="lookupStatus === 'ready'" class="muted offline-note">
        この端末に取り込んだデータの中にありません(取り込みは通信の良い場所で)。
      </p>
    </div>

    <div v-else-if="result?.row" class="card result-card">
      <div class="result-head">
        <p class="result-name">{{ headName || '氏名なし' }}</p>
        <div class="result-tags">
          <span v-if="yearGroup">{{ yearGroup }}</span>
          <span v-if="status" :class="statusTone">{{ status }}</span>
        </div>
        <p class="result-code">コード {{ result.code }}</p>
      </div>

      <!-- 金額・支払いのまとまり(1つの枠に3セル) -->
      <div v-if="money.length" class="panel money-panel" :class="money.length === 3 ? 'three' : 'two'">
        <div v-for="cell in money" :key="cell.key" class="panel-cell" :class="{ wide: cell.wide }">
          <span class="panel-label">{{ cell.label }}</span>
          <span class="panel-value">{{ cell.value }}</span>
        </div>
      </div>

      <!-- 商品と個数のまとまり(星のスロットで個数を視覚化し、数値も出す) -->
      <div v-if="products.length" class="panel product-panel">
        <p class="panel-title">
          商品{{ productTotal === null ? '' : ` 合計 ${productTotal}個` }}
          <span class="panel-hint">1商品あたり最大{{ PRODUCT_MAX }}個</span>
        </p>
        <div class="product-grid">
          <div v-for="p in products" :key="p.key" class="product-cell" :class="{ zero: p.zero }">
            <span class="product-name">{{ p.name }}</span>
            <!-- 星は飾り(個数は数字で読む)。スクリーンリーダーには数字だけを渡す -->
            <span class="product-stars" aria-hidden="true">
              <span class="star-on">{{ '★'.repeat(p.on) }}</span><span class="star-off">{{ '☆'.repeat(p.off) }}</span>
            </span>
            <span class="product-count">{{ p.countLabel }}</span>
          </div>
        </div>
      </div>

      <dl v-if="entries.length" class="result-list">
        <template v-for="[key, value] in entries" :key="key">
          <div class="result-row">
            <dt>{{ key }}</dt>
            <!-- 備考だけインライン編集(保存はシートへ書き、この端末のデータにも反映) -->
            <dd v-if="key === ITEM_REMARK_KEY && editingRemark" class="remark-edit">
              <textarea
                v-model="remarkDraft"
                class="field remark-input"
                rows="3"
                :maxlength="REMARK_MAX_LENGTH"
                placeholder="備考を入力(空にすると消去)"
              ></textarea>
              <div class="remark-actions">
                <button class="btn secondary" type="button" :disabled="remarkBusy" @click="closeRemarkEditor">
                  キャンセル
                </button>
                <button class="btn" type="button" :disabled="remarkBusy" @click="saveRemark">
                  {{ remarkBusy ? '保存中…' : '保存' }}
                </button>
              </div>
              <p v-if="remarkError" class="remark-error">{{ remarkError }}</p>
            </dd>
            <dd v-else-if="key === ITEM_REMARK_KEY">
              <span>{{ value }}</span>
              <!-- 備考だけインライン編集(保存は /api/remark-update でシートへ書き、この端末のデータにも写す) -->
              <button class="btn secondary remark-edit-btn" type="button" @click="startRemarkEdit">編集</button>
            </dd>
            <dd v-else>{{ value }}</dd>
          </div>
        </template>
      </dl>

      <!-- スキャンの記録履歴(監査)。このコードがいつ読み取られたかの日時付き履歴を新しい順に出す -->
      <div v-if="history && history.rows.length" class="history-block">
        <p class="history-title">スキャンの記録履歴({{ history.total }}件)</p>
        <ul class="history-list">
          <li v-for="rowEvent in history.rows" :key="rowEvent.seq">
            <span class="history-status">{{ scanStatusMessage(rowEvent.status) }}</span>
            <span class="history-at">{{ formatJst(rowEvent.at) }}</span>
            <span class="history-mode">{{ rowEvent.modeName }}</span>
            <span v-if="rowEvent.actorEmail" class="history-actor">{{ rowEvent.actorEmail }}</span>
            <span v-if="rowEvent.sheetRange" class="history-range">{{ rowEvent.sheetRange }}</span>
            <span v-if="Object.keys(rowEvent.written).length" class="history-written">
              {{ Object.entries(rowEvent.written).map(([k, v]) => `${k}: ${v}`).join(' / ') }}
            </span>
          </li>
        </ul>
        <NuxtLink class="btn secondary history-more" to="/records">記録履歴すべて</NuxtLink>
      </div>
    </div>

    <div v-else class="card">
      <p class="muted result-note">読み込み中…</p>
    </div>

    <div class="result-actions">
      <NuxtLink class="btn" to="/scan">スキャンに戻る</NuxtLink>
      <NuxtLink class="btn secondary" to="/items">一覧に戻る</NuxtLink>
    </div>

    <!-- 補足は画面末尾の小さな注記(主内容は照会結果)。照会が取り込み時点のミラーであることと、
         取り込み後のシート側の変更が次の取り込みまで現れないことを伝える(上限打ち切りもここ)。 -->
    <p v-if="lookupStatus === 'ready'" class="muted lookup-foot">
      端末内の取り込みデータ({{ offlineMeta?.itemCount ?? 0 }}件・{{ formatJst(offlineMeta?.snapshotAt ?? '') }}{{ offlineMeta?.capped ? '・上限で打ち切り' : '' }})から照会しました。取り込み後のシート側の変更は次の取り込みまで現れません。
    </p>
  </div>
</template>

<style scoped>
/* 1枚のカードにまとめる(見出し + 金額枠 + 商品枠 + 残り項目のリスト)。縦詰めなので padding は狭く */
.result-card {
  border: 1px solid #2c3a4f;
  padding: 14px;
}

.result-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}

.result-name {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.25;
  word-break: break-word;
}

.result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  /* 年組・入金状況は氏名の行の右端に回す(縦に積まない) */
  margin-left: auto;
}

.result-tags span {
  border: 1px solid var(--muted);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--text);
}

.result-tags .tag.ok {
  border-color: var(--accent);
  color: var(--accent);
}

.result-tags .tag.warn {
  border-color: var(--danger);
  color: var(--danger);
}

.result-code {
  margin: 0;
  width: 100%;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.result-empty-text {
  margin: 6px 0 0;
  font-size: 15px;
}

.result-note {
  margin: 0;
}

.offline-note {
  margin: 6px 0 0;
  font-size: 12px;
}

/* 画面末尾の補足(照会結果が主内容なので目立たせない) */
.lookup-foot {
  margin: 10px 2px 0;
  font-size: 11px;
  line-height: 1.45;
}

/* まとめ枠(金額・商品)。パネルより一段暗い面で枠線を出す */
.panel {
  border: 1px solid #2c3a4f;
  border-radius: 10px;
  background: #16223a;
  padding: 10px;
  margin-top: 10px;
}

.money-panel {
  display: grid;
  gap: 6px 12px;
}

.money-panel.three {
  grid-template-columns: repeat(3, 1fr);
}

.money-panel.two {
  grid-template-columns: repeat(2, 1fr);
}

.panel-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.panel-label {
  color: var(--muted);
  font-size: 12px;
}

.panel-value {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  word-break: break-word;
}

.panel-title {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

.panel-hint {
  color: #5b6b83;
  font-size: 11px;
  margin-left: 6px;
}

.product-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 4px 14px;
  margin-top: 8px;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.product-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-stars {
  font-size: 13px;
  letter-spacing: 1px;
}

.star-on {
  color: #fbbf24;
}

.star-off {
  color: #475569;
}

.product-count {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

/* 0個は星すべて未埋。存在感を落として「頼んでいない」を先に読む */
.product-cell.zero {
  opacity: 0.65;
}

.product-cell.zero .product-count {
  color: var(--muted);
}

.result-list {
  margin: 10px 0 0;
}

.result-row {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) 2.2fr;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid #2c3a4f;
}

.result-row dt {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.result-row dd {
  margin: 0;
  font-size: 14px;
  word-break: break-word;
}

/* 備考のインライン編集: 編集ボタンは値の末尾に添える(行を押し広げない) */
.remark-edit-btn {
  margin-left: 8px;
  padding: 4px 10px;
  font-size: 12px;
}

.remark-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.remark-input {
  width: 100%;
  resize: vertical;
}

.remark-actions {
  display: flex;
  gap: 8px;
}

.remark-error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}

/* スキャンの記録履歴(監査)。詳細リストの下にまとめて出す。 */
.history-block {
  margin-top: 14px;
  border-top: 1px solid #1f2b3d;
  padding-top: 10px;
}

.history-title {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--muted);
}

.history-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.history-list li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 13px;
}

.history-status {
  color: var(--accent);
}

.history-at,
.history-mode,
.history-actor,
.history-range,
.history-written {
  color: var(--muted);
  font-size: 12px;
}

/* 狭い画面: 金額枠は2列で支払い方法だけ1行占有 / リストはラベルを値の上に回す */
@media (max-width: 460px) {
  .money-panel.three {
    grid-template-columns: repeat(2, 1fr);
  }

  .money-panel .panel-cell.wide {
    grid-column: 1 / -1;
  }

  .result-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}

.result-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
}
</style>
