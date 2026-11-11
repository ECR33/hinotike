<script setup lang="ts">
/**
 * items レコードの一覧(app/components/ItemRow.vue が行部品)。
 *
 * 保護は app/middleware/auth.global.ts(デフォルト拒否+ホワイトリスト)で行うので
 * ページ単位の middleware は不要(グローバルミドルウェアが登録済み利用者だけ通す)。
 *
 * 表示は全件を一括で出さない: code 昇順のキーセットカーソルで1バッチ(ITEM_PAGE_SIZE)ずつ追記する。
 * 最下部の sentinel が画面に出た時点で IntersectionObserver が次のページを読み、sentinel が
 * まだ見えている限り追記し続ける(1バッチで viewport が埋まらない場合もここで自己継続する)。
 * IntersectionObserver が無い環境では手動ボタンにフォールバックする。
 *
 * 検索は code と氏名の部分一致(incremental search): 入力を SEARCH_DEBOUNCE_MS でまとめ、
 * 条件が変わるたびリストを reset + 1ページ目から取り直す。応答は generation で比較して
 * 後発の検索に負けた古い応答を捨て、乱順応答でリストが古い条件の結果に戻るのを防ぐ。
 * URL と検索条件は同期しない(タイプごとに router.replace しない。初期値だけ ?code=&name=&years=&groups= を読む)。
 *
 * 年・組の絞り込み(折りたたみできる1つの欄)は2モード:
 *  - 単独選択: chip の多选択(app/components/FacetChipGroup.vue)。同一 facet 内は OR、年と組の間は AND。
 *  - 組み合わせ選択: 年×組のマトリクス(app/components/YearGroupMatrix.vue)。選んだセル(その年+その組)だけを対象、
 *    セル同士は OR。「1年3組 + 2年1組」のような**対応**を指定できる。
 * モード切替時はもう一方の選択を消す(見えない選択が条件に残らない)。
 * 選択肢は GET /api/items-facets(items 全体の値・ペアの件数)から読み、現在の絞り込み結果には連動しない。
 * chip・セル・リセットはデバウンスを待たずに即適用する。
 * 入力の消去は app/components/ClearableInput.vue(Vuetify の clearable 相当: 値があるとき右端に消去ボタン)。
 */
import {
  ITEM_PAGE_SIZE,
  normalizeFilter,
  normalizePairs,
  normalizeSelection,
  pairKey,
  type FacetOption,
  type FacetPairCount,
  type ItemRowData,
} from '#shared/utils/items'

interface ItemsPage {
  rows: ItemRowData[]
  nextCursor: string | null
  total: number
}

interface ItemsFacets {
  years: FacetOption[]
  groups: FacetOption[]
  pairs: FacetPairCount[]
  missingPairs: number
  scanned: number
  truncated: boolean
}

/** 年・組の選択モード(単独選択は OR/AND、組み合わせ選択は年と組の対応)。 */
type FacetMode = 'single' | 'pair'

const route = useRoute()

/** 初期条件(共有リンク用のクエリだけ読む)。入力・chip・マトリクスから URL は更新しない。 */
const initialCode = normalizeFilter(route.query.code) ?? ''
const initialName = normalizeFilter(route.query.name) ?? ''
const initialYears = normalizeSelection(route.query.years)
const initialGroups = normalizeSelection(route.query.groups)
const initialPairs = normalizePairs(route.query.pairs).map(pairKey)
/** ペア選択が URL にあれば組み合わせモードで始める(単独選択と同時に送られたら両方 AND になる)。 */
const initialMode: FacetMode = initialPairs.length ? 'pair' : 'single'

const codeInput = ref(initialCode)
const nameInput = ref(initialName)
/** 選択済みの facet 値。chip / セルの toggle で即変わる(デバウンスなし)。 */
const years = ref<string[]>(initialYears)
const groups = ref<string[]>(initialGroups)
/** 選択済みのペア(`年:組` の key)。組み合わせモードだけ条件に反映する。 */
const pairs = ref<string[]>(initialPairs)
const facetMode = ref<FacetMode>(initialMode)
/** 年・組の欄は縦に場所を取る(年9×組5 のマトリクス)ので、折りたたんで一覧を先に大きく見せる。
 *  初期選択があれば開いておく(消した条件を隠さない)。 */
const facetSectionOpen = ref(initialYears.length + initialGroups.length + initialPairs.length > 0)
const active = ref<{
  code: string
  name: string
  years: string[]
  groups: string[]
  pairs: string[]
}>({
  code: initialCode,
  name: initialName,
  years: initialYears,
  groups: initialGroups,
  pairs: initialPairs,
})

const rows = ref<ItemRowData[]>([])
const total = ref(0)
const cursor = ref<string | null>(null)
const done = ref(false)
const loading = ref(false)
/** 入力の確定待ち(デバウンス中)。行の追記中と区別して「検索中…」を出す。 */
const pending = ref(false)
const errorMessage = useState<string | null>('items-error', () => null)

/** 年・組の選択肢。SSR で解決して hydration に引き継ぐ(items 全体のスキャンなので条件に依存しない)。 */
const facets = useState<ItemsFacets | null>('items-facets', () => null)
const facetError = useState<string | null>('items-facets-error', () => null)

/** SSR で解決した1ページ目は useState で hydration 時に引き継ぐ(再fetch防止)。初期条件が一致するものだけ再利用する。 */
const cachedFirst = useState<{
  code: string
  name: string
  years: string[]
  groups: string[]
  pairs: string[]
  page: ItemsPage
} | null>('items-first-page', () => null)

/** facet 選択の一致判定(順序は無視して集合として同じか。OR の選択順は結果に影響しない)。 */
function sameSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const other = new Set(b)
  return a.every((value) => other.has(value))
}

/** 適用中の絞り込み条件(入力欄の値ではなく active を読む)。 */
interface FilterCondition {
  code: string
  name: string
  years: string[]
  groups: string[]
  pairs: string[]
}

// IntersectionObserver の有無はクライアントでのしか分からない(SSR では undefined)。
// SSR とクライアントの初回描画を一致させるため初期値は false(フォールバックボタンを出す)とし、
// マウント後に実際の判定へ切り替える。
const ioSupported = ref(false)

// 検索条件の変更で増やす番号。応答が自分の世代より古ければ捨てて上書きしない。
let generation = 0

async function load(opts: { reset: boolean; initial?: boolean }) {
  if (opts.reset) {
    rows.value = []
    cursor.value = null
    done.value = false
  }
  if (done.value) return

  const gen = generation
  const code = active.value.code
  const name = active.value.name
  // facet は applyFilters で active に写してから load を呼ぶので、ここで読んだ値は適用済み条件
  const selectedYears = years.value
  const selectedGroups = groups.value
  const selectedPairs = pairs.value
  const cur = opts.reset ? null : cursor.value

  loading.value = true
  errorMessage.value = null
  try {
    // SSR の内部 fetch はブラウザ cookie を自動では持たないため useRequestHeaders で明示転送する。
    const page = await $fetch<ItemsPage>('/api/items-list', {
      query: {
        code: code || undefined,
        name: name || undefined,
        years: selectedYears.length ? selectedYears : undefined,
        groups: selectedGroups.length ? selectedGroups : undefined,
        pairs: selectedPairs.length ? selectedPairs : undefined,
        cursor: cur ?? undefined,
        limit: ITEM_PAGE_SIZE,
      },
      headers: useRequestHeaders(['cookie']),
    })
    if (gen !== generation) return // 後発検索の応答が先に適用済みの場合はこの応答を捨てて上書きしない
    rows.value = opts.reset ? page.rows : [...rows.value, ...page.rows]
    cursor.value = page.nextCursor
    total.value = page.total
    done.value = page.nextCursor === null
    if (opts.initial) {
      cachedFirst.value = {
        code,
        name,
        years: selectedYears,
        groups: selectedGroups,
        pairs: selectedPairs,
        page,
      }
    }
  } catch (e: unknown) {
    if (gen !== generation) return
    errorMessage.value = e instanceof Error ? e.message : String(e)
    done.value = true // 失敗した以上これ以上の追記はできない
  } finally {
    if (gen === generation) loading.value = false
  }
}

/** 年・組の選択肢を取得する(失敗しても一覧は出せるので facetError だけ立てる)。 */
async function loadFacets(): Promise<void> {
  facetError.value = null
  try {
    facets.value = await $fetch<ItemsFacets>('/api/items-facets', {
      headers: useRequestHeaders(['cookie']),
    })
  } catch (e: unknown) {
    facetError.value = e instanceof Error ? e.message : String(e)
  }
}

const SEARCH_DEBOUNCE_MS = 250
let debounceTimer: ReturnType<typeof setTimeout> | undefined

function currentCondition(): FilterCondition {
  return {
    code: normalizeFilter(codeInput.value) ?? '',
    name: normalizeFilter(nameInput.value) ?? '',
    years: [...years.value],
    groups: [...groups.value],
    pairs: [...pairs.value],
  }
}

function sameCondition(a: FilterCondition, b: FilterCondition): boolean {
  return (
    a.code === b.code &&
    a.name === b.name &&
    sameSelection(a.years, b.years) &&
    sameSelection(a.groups, b.groups) &&
    sameSelection(a.pairs, b.pairs)
  )
}

function applyFilters() {
  pending.value = false
  const next = currentCondition()
  if (sameCondition(next, active.value)) return
  active.value = next
  generation += 1
  void load({ reset: true })
}

/** デバウンスの確定待ちを打ち切って即適用する(chip の変更・リセット用)。 */
function applyNow() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
  applyFilters()
}

function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function toggleYear(value: string) {
  years.value = toggled(years.value, value)
  applyNow()
}

function toggleGroup(value: string) {
  groups.value = toggled(groups.value, value)
  applyNow()
}

/** マトリクスのセル(年と組の対応)を選ぶ。再押で解除(toggled と同じ)。 */
function togglePair(key: string) {
  pairs.value = toggled(pairs.value, key)
  applyNow()
}

/**
 * 選択モードを切り替える。もう一方のモードの選択は消す(表示されない選択が
 * 条件として残ると「何で絞られているか」が分からなくなるため)。
 */
function setMode(next: FacetMode) {
  if (next === facetMode.value) return
  facetMode.value = next
  if (next === 'pair') {
    years.value = []
    groups.value = []
  } else {
    pairs.value = []
  }
  applyNow()
}

/** UI に表示されている条件のどれかが入っているか(リセットボタンの有効判定)。 */
const hasFilters = computed(
  () =>
    !!codeInput.value ||
    !!nameInput.value ||
    years.value.length > 0 ||
    groups.value.length > 0 ||
    pairs.value.length > 0,
)

/** 絞り込み条件を一度に消す(code・氏名・年・組・ペアのすべて)。選択モードは維持する。条件がなければ無効。 */
function resetFilters() {
  codeInput.value = ''
  nameInput.value = ''
  years.value = []
  groups.value = []
  pairs.value = []
  applyNow()
}

/** 折りたたみ欄のラベル(閉じていても選択状態が分かるように件数を出す)。 */
const facetSelectionSummary = computed(() => {
  if (facetMode.value === 'pair') return pairs.value.length ? `${pairs.value.length} セル選択中` : '選択なし'
  const parts = []
  if (years.value.length) parts.push(`${years.value.length} 年`)
  if (groups.value.length) parts.push(`${groups.value.length} 組`)
  return parts.length ? parts.join(' + ') : '選択なし'
})

watch([codeInput, nameInput], () => {
  pending.value = true
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined
    applyFilters()
  }, SEARCH_DEBOUNCE_MS)
})

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

/** sentinel(一覧の末尾)がまだ画面内か(下端から200px 手前を含む)。 */
function sentinelVisible(): boolean {
  if (!import.meta.client) return false
  const el = sentinel.value
  if (!el) return false
  return el.getBoundingClientRect().top < window.innerHeight + 200
}

/** sentinel が見えている限り次のページを追記する(IO の回调がない場合の自己継続もここで処理する)。 */
async function loadMore(): Promise<void> {
  if (loading.value || done.value) return
  if (!sentinelVisible()) return
  await load({ reset: false })
  await nextTick()
  if (sentinelVisible()) await loadMore()
}

onMounted(() => {
  ioSupported.value = typeof IntersectionObserver === 'function'
  if (!ioSupported.value || !sentinel.value) return
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore()
    },
    { rootMargin: '0px 0px 200px 0px' },
  )
  observer.observe(sentinel.value)
  // 1ページ目がまだ画面に収まっている場合はスクロールを待たずに追記する
  void loadMore()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (debounceTimer) clearTimeout(debounceTimer)
})

// 1ページ目と年・組の選択肢を SSR で解決して hydration に引き継ぐ(再fetch 防止)。
// 1ページ目は初期条件が一致する缓存だけ再利用する(別条件の缓存を今の条件で使うと別の結果になる)。
const reuseFirstPage =
  !!cachedFirst.value &&
  sameCondition(cachedFirst.value, {
    code: initialCode,
    name: initialName,
    years: initialYears,
    groups: initialGroups,
    pairs: initialPairs,
  })

if (reuseFirstPage && cachedFirst.value) {
  const page = cachedFirst.value.page
  rows.value = page.rows
  total.value = page.total
  cursor.value = page.nextCursor
  done.value = page.nextCursor === null
}

const initialLoads: Promise<void>[] = []
if (!facets.value) initialLoads.push(loadFacets())
if (!reuseFirstPage) initialLoads.push(load({ reset: true, initial: true }))
await Promise.all(initialLoads)
</script>

<template>
  <div class="page">
    <h1>レコード一覧</h1>

    <div class="card">
      <div class="search-row">
        <ClearableInput v-model="codeInput" label="code(部分一致)" placeholder="コードの一部を入力" />
        <ClearableInput v-model="nameInput" label="氏名(部分一致)" placeholder="氏名の一部を入力" />

        <!-- 年・組の欄は縦に場所を取る(年9×組5)ので折りたたみできる。閉じても選択状態はラベルに出す -->
        <div class="facet-section">
          <button
            class="btn secondary facet-toggle"
            type="button"
            :aria-expanded="facetSectionOpen"
            aria-controls="facet-panel"
            @click="facetSectionOpen = !facetSectionOpen"
          >
            年・組の絞り込み <span class="muted">({{ facetSelectionSummary }})</span>
          </button>

          <div id="facet-panel" v-show="facetSectionOpen" class="facet-panel">
            <div class="mode-row" role="group" aria-label="年・組の絞り込み方法">
              <button
                class="btn secondary"
                type="button"
                :class="{ active: facetMode === 'single' }"
                :aria-pressed="facetMode === 'single'"
                @click="setMode('single')"
              >
                年・組を単独で
              </button>
              <button
                class="btn secondary"
                type="button"
                :class="{ active: facetMode === 'pair' }"
                :aria-pressed="facetMode === 'pair'"
                @click="setMode('pair')"
              >
                年と組の組み合わせ
              </button>
            </div>

            <template v-if="facetMode === 'single'">
              <FacetChipGroup
                label="年(複数選択でOR)"
                suffix="年"
                :options="facets?.years ?? []"
                :selected="years"
                :loading="!facets"
                @toggle="toggleYear"
              />
              <FacetChipGroup
                label="組(複数選択でOR)"
                suffix="組"
                :options="facets?.groups ?? []"
                :selected="groups"
                :loading="!facets"
                @toggle="toggleGroup"
              />
              <p class="muted hint">
                年と組はそれぞれ複数選択で OR、年と組の間は AND で絞り込みます(1年・2年 + 3組 は「1年3組 と 2年3組」)。
                年と組の対応(1年3組 + 2年1組)は単独選択では指定できません。
              </p>
            </template>

            <template v-else>
              <YearGroupMatrix
                :years="facets?.years ?? []"
                :groups="facets?.groups ?? []"
                :pair-counts="facets?.pairs ?? []"
                :selected="pairs"
                :loading="!facets"
                @toggle="togglePair"
              />
              <p class="muted hint">
                選んだマス(その年 + その組)だけを対象にします。マス同士は OR なので、1年3組 + 2年1組 のような対応を指定できます。
                <span v-if="facets && facets.missingPairs">
                  年または組が空のレコードは {{ facets.missingPairs }} 件あり、組み合わせでは選べません(条件なしなら表示されます)。
                </span>
              </p>
            </template>

            <p class="muted hint">
              <span v-if="facetError">選択肢を取得できませんでした({{ facetError }})</span>
              <span v-else-if="facets?.truncated">選択肢は先頭 {{ facets.scanned }} 件の範囲から生成しています</span>
            </p>
          </div>
        </div>

        <button class="btn secondary" type="button" :disabled="!hasFilters" @click="resetFilters">
          条件をリセット
        </button>
      </div>
      <p class="muted status" aria-live="polite">
        <span v-if="pending">検索中…</span>
        <span v-else-if="loading">読み込み中…</span>
        <span v-else>{{ total }} 件中 {{ rows.length }} 件表示</span>
      </p>
    </div>

    <div v-if="errorMessage" class="error card">{{ errorMessage }}</div>

    <div class="card">
      <ul v-if="rows.length" class="item-list">
        <ItemRow v-for="item in rows" :key="item.code" :item="item" />
      </ul>
      <p v-else-if="loading || pending" class="muted">読み込み中…</p>
      <p v-else-if="!errorMessage" class="muted">該当するレコードがありません。</p>

      <!-- 追記のトリガー(常に描画して observer の対象を固定する)。0件のとき「最後まで」は出さない -->
      <div ref="sentinel" class="sentinel">
        <span v-if="loading" class="muted">次のレコードを読み込み中…</span>
        <span v-else-if="done && rows.length" class="muted">最後まで表示しました</span>
        <button
          v-else-if="!ioSupported"
          class="btn secondary"
          type="button"
          @click="load({ reset: false })"
        >
          次の {{ ITEM_PAGE_SIZE }} 件を表示
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-row {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.facet-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mode-row .btn {
  font-size: 14px;
  padding: 8px 12px;
}

.mode-row .btn.active {
  box-shadow: inset 0 0 0 2px rgba(120, 190, 255, 0.8);
}

.facet-toggle {
  font-size: 14px;
  padding: 8px 12px;
}

.hint {
  margin: 0;
}

.status {
  margin: 10px 0 0;
}

.item-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.sentinel {
  padding-top: 12px;
  min-height: 24px;
}
</style>
