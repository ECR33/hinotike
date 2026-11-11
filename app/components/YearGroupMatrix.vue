<script setup lang="ts">
/**
 * 年×組のマトリクス(セル = その年のその組)。選んだセルだけを対象にする(選んだセル同士は OR)。
 * chip(年・組の単独選択)では「1年3組 + 2年1組」のような**対応**を表現できないので、
 * 対応を指定したいときの選択UIとして FacetChipGroup とは別に用意する。
 *
 * セルの件数は GET /api/items-facets の pairs(items 全体)から取る。0件のセルは押せない
 * (押すと0件になる選択を、選択可能なふりをして出さない)。
 * 件数は現在の絞り込み結果には連動しない(chip と同じ方針: 連動すると理由が分からなくなる)。
 */
import type { FacetOption, FacetPairCount } from '#shared/utils/items'
import { pairKey } from '#shared/utils/items'

const props = defineProps<{
  years: FacetOption[]
  groups: FacetOption[]
  pairCounts: FacetPairCount[]
  selected: string[]
  loading?: boolean
}>()

const emit = defineEmits<{
  toggle: [key: string]
}>()

/** セルの件数(`年:組` → count)。欠ける組み合わせは 0(セルは押せない)。 */
const counts = computed(() => {
  const map = new Map<string, number>()
  for (const pair of props.pairCounts) map.set(pairKey(pair), pair.count)
  return map
})

function cellKey(year: string, group: string): string {
  return pairKey({ year, group })
}

function cellCount(year: string, group: string): number {
  return counts.value.get(cellKey(year, group)) ?? 0
}
</script>

<template>
  <div class="matrix-block">
    <p v-if="loading" class="muted">選択肢を読み込み中…</p>
    <p v-else-if="!props.years.length || !props.groups.length" class="muted">
      年・組の値が無いため組み合わせを指定できません。
    </p>
    <div v-else class="matrix-scroll">
      <table class="matrix">
        <thead>
          <tr>
            <th class="corner">年 / 組</th>
            <th v-for="group in props.groups" :key="group.value">{{ group.value }}組</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="year in props.years" :key="year.value">
            <th class="row-head">{{ year.value }}年</th>
            <td v-for="group in props.groups" :key="group.value">
              <button
                class="cell"
                :class="{ active: props.selected.includes(cellKey(year.value, group.value)) }"
                type="button"
                :aria-pressed="props.selected.includes(cellKey(year.value, group.value))"
                :aria-label="`${year.value}年${group.value}組 ${cellCount(year.value, group.value)}件`"
                :disabled="cellCount(year.value, group.value) === 0"
                @click="emit('toggle', cellKey(year.value, group.value))"
              >
                <span v-if="cellCount(year.value, group.value)" class="cell-count">
                  {{ cellCount(year.value, group.value) }}
                </span>
                <span v-else class="cell-empty">–</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.matrix-scroll {
  overflow-x: auto;
}

.matrix {
  border-collapse: collapse;
  width: 100%;
}

.matrix th {
  font-weight: 600;
  font-size: 12px;
  padding: 4px 6px;
  text-align: center;
  white-space: nowrap;
}

.corner,
.row-head {
  text-align: left;
}

.cell {
  min-width: 42px;
  min-height: 34px;
  border: 1px solid var(--muted);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  padding: 2px 6px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.cell.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #0b1220;
}

.cell:disabled {
  cursor: default;
  color: var(--muted);
  opacity: 0.4;
}

.cell-count,
.cell-empty {
  display: block;
}
</style>
