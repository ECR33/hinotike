<script setup lang="ts">
// 保護は app/middleware/auth.global.ts(グローバル+ホワイトリスト)で行う

import { ITEM_GROUP_KEY, ITEM_NAME_KEY, ITEM_YEAR_KEY, payloadValue } from '#shared/utils/items'

const route = useRoute()
const code = computed(() => String(route.query.code ?? ''))

type LookupResult = { found: boolean; code: string; row: Record<string, unknown> | null }

// SSR で解決した結果は useState 経由で hydration 時にクライアントへ引き継がれる(再fetch防止)。
// SSR の内部 fetch は cookie を自動では持たないため useRequestHeaders で明示転送する。
const result = useState<LookupResult | null>('lookup-result', () => null)
const errorMessage = useState<string | null>('lookup-error', () => null)

async function fetchLookup(c: string) {
  try {
    result.value = await $fetch<LookupResult>('/api/lookup', {
      method: 'POST',
      body: { code: c },
      headers: useRequestHeaders(['cookie']),
    })
    errorMessage.value = null
  } catch (e: unknown) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
  }
}

// code が無い画面(/result 単体)は照会しない(API は 400 を返すだけなので空の案内カードを出す)。
// SSR結果のhydration(code一致)は再fetchしない。client-side遷移で旧結果が別codeのものは
// staleなので再照会する(旧codeのまま表示されるバグ修正)。
const cachedForCurrentCode = result.value !== null && result.value.code === code.value
if (code.value && !cachedForCurrentCode && !(result.value === null && errorMessage.value !== null)) {
  await fetchLookup(code.value)
}

// クライアント遷移で code が変わった場合は再照会する
watch(code, (c) => {
  if (result.value?.code !== c) void fetchLookup(c)
})

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

/** 商品個数のキーsuffix(スプレッドシート側のカラム名。全角括弧も扱う)。 */
const QUANTITY_SUFFIXES = ['(個数)', '（個数）']

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

/** キー名から商品名を取り出す(「ひのドッグ(個数)」→「ひのドッグ」。括弧が無ければキー名そのまま)。 */
function quantityName(key: string): string {
  for (const suffix of QUANTITY_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length) || key
  }
  return key
}

function isQuantityKey(key: string): boolean {
  return QUANTITY_SUFFIXES.some((suffix) => key.endsWith(suffix))
}

/** 個数系キーを商品名・個数(数値なら count、想定外の値なら raw)にまとめる。 */
const quantities = computed<Array<{ key: string; name: string; count: number | null; raw: string }>>(() => {
  const p = payload.value
  return Object.keys(p)
    .filter((key) => isQuantityKey(key) && !isBlank(p[key]))
    // 環境差のない並び(localeCompare は ICU の挙動差で SSR/クライアントの文字列がずれ得る)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
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
  for (const [k, v] of Object.entries(p)) {
    if (!taken.has(k)) pushDetail(pairs, taken, k, v)
  }

  // payload 以外の列。code/imported_at は見出し・末尾で出すのでここでは省略する。
  for (const [k, v] of Object.entries(r)) {
    if (k === 'payload' || k === 'code' || k === 'imported_at') continue
    pushDetail(pairs, taken, k, v)
  }
  if (typeof r.imported_at === 'string') {
    pushDetail(pairs, taken, '取り込み日時', formatImportedAt(r.imported_at))
  }
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

/** ISOタイムスタンプを JST の固定表記へ(環境非依存の文字列にする)。 */
function formatImportedAt(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const jst = new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 16)
  return `${jst.replace('T', ' ')} (JST)`
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

    <div v-else-if="result && !result.found" class="card result-card result-empty">
      <p class="result-code">コード {{ code }}</p>
      <p class="result-empty-text">該当するデータが見つかりませんでした。</p>
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
            <dd>{{ value }}</dd>
          </div>
        </template>
      </dl>
    </div>

    <div v-else class="card">
      <p class="muted result-note">読み込み中…</p>
    </div>

    <div class="result-actions">
      <NuxtLink class="btn" to="/scan">スキャンに戻る</NuxtLink>
      <NuxtLink class="btn secondary" to="/items">一覧に戻る</NuxtLink>
    </div>
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
