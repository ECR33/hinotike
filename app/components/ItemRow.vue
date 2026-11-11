<script setup lang="ts">
/**
 * items 一覧の行部品(app/pages/items.vue から item をそのまま受け取る)。
 *
 * 行の中身はここだけで決める: 現在は 年 / 組 / 氏名 / code の4要素だけ。
 * 支払い状況・領収書などの列を増やしたいときは payloadValue でキーを足すだけで
 * ページ側は変更不要(API は payload をそのまま返している)。
 *
 * 行全体が /result?code=… のリンク(スキャンしたときと同じ照会結果画面へ遷移する)。
 * 行の中は span だけにして入れ子のリンクを作らないので、行まるごとタップで遷移できる。
 * アクセシブル名は行テキストそのもの(氏名 + 年組 + code)になる。
 */
import {
  ITEM_GROUP_KEY,
  ITEM_NAME_KEY,
  ITEM_YEAR_KEY,
  payloadValue,
  type ItemRowData,
} from '#shared/utils/items'

const props = defineProps<{ item: ItemRowData }>()

const name = computed(() => payloadValue(props.item.payload, ITEM_NAME_KEY))
const year = computed(() => payloadValue(props.item.payload, ITEM_YEAR_KEY))
const group = computed(() => payloadValue(props.item.payload, ITEM_GROUP_KEY))
const detailHref = computed(() => `/result?code=${encodeURIComponent(props.item.code)}`)
</script>

<template>
  <li class="item-row">
    <NuxtLink class="item-link" :to="detailHref">
      <span class="item-fields">
        <span class="item-name">{{ name || '氏名なし' }}</span>
        <span class="item-meta">
          <span v-if="year">{{ year }}年</span>
          <span v-if="group">{{ group }}組</span>
        </span>
      </span>
      <span class="item-code">{{ item.code }}</span>
    </NuxtLink>
  </li>
</template>

<style scoped>
.item-row {
  display: flex;
  border-bottom: 1px solid #2c3a4f;
}

/* 行まるごとタップ可能にする(リンク側に余白と当たり面积を持たせる) */
.item-link {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 8px;
  min-height: 44px;
  box-sizing: border-box;
  border-radius: 10px;
  color: inherit;
  text-decoration: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.item-link:hover,
.item-link:focus-visible {
  background: rgba(56, 189, 248, 0.12);
}

.item-fields {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.item-name {
  font-size: 15px;
  font-weight: 600;
  word-break: break-word;
}

.item-meta {
  display: flex;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
}

.item-code {
  color: var(--accent);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
