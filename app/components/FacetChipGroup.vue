<script setup lang="ts">
/**
 * 年・組の絞り込み chip 群(app/components/FacetChipGroup.vue)。
 *
 * 多选択は「同一 facet 内で OR」(server/api/items-list.get.ts の in.())。
 * 押した chip は selected に値を追加 / 再押で除去(toggle)。選択順序は OR に影響しない。
 * options は items 全体の値と件数(GET /api/items-facets)で、現在の絞り込み結果には連動しない
 * (絞り込みで選択肢が消えると「選べなくなった理由」が分からなくなるため)。
 */
import type { FacetOption } from '#shared/utils/items'

const props = defineProps<{
  label: string
  /** 表示ラベルに添える接尾語(例: '年' / '組'。値は payload の文字列そのまま)。 */
  suffix?: string
  options: FacetOption[]
  selected: string[]
  loading?: boolean
}>()

const emit = defineEmits<{ toggle: [value: string] }>()

function labelFor(option: FacetOption): string {
  return props.suffix ? `${option.value}${props.suffix}` : option.value
}

function isActive(value: string): boolean {
  return props.selected.includes(value)
}
</script>

<template>
  <div class="facet">
    <span class="muted">{{ props.label }}</span>
    <div class="chips">
      <span v-if="props.loading" class="muted">読み込み中…</span>
      <span v-else-if="props.options.length === 0" class="muted">選択肢がありません</span>
      <button
        v-for="option in props.options"
        :key="option.value"
        class="chip"
        :class="{ active: isActive(option.value) }"
        type="button"
        :aria-pressed="isActive(option.value)"
        @click="emit('toggle', option.value)"
      >
        {{ labelFor(option) }}<span class="chip-count">{{ option.count }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.facet {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid var(--muted);
  border-radius: 999px;
  padding: 6px 12px;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #0b1220;
}

.chip-count {
  font-size: 12px;
  color: var(--muted);
}

.chip.active .chip-count {
  color: #0b1220;
  opacity: 0.75;
}
</style>
