<script setup lang="ts">
/**
 * Vuetify の clearable に相当するテキスト入力(app/components/ClearableInput.vue)。
 * このプロジェクトには Vuetify を入れていないので、同じ挙動を自前部品で実装する:
 * 値が入っているときだけ右端に消去ボタンが出て、押すと空にする(Vuetify と同じく焦点を入力に残す)。
 */
const props = defineProps<{
  modelValue: string
  label: string
  placeholder?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const input = ref<HTMLInputElement | null>(null)

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

function clear() {
  emit('update:modelValue', '')
  input.value?.focus()
}
</script>

<template>
  <label class="clearable">
    <span class="muted">{{ props.label }}</span>
    <div class="input-wrap">
      <input
        ref="input"
        class="field"
        type="text"
        :value="props.modelValue"
        :placeholder="props.placeholder"
        autocomplete="off"
        @input="onInput"
      />
      <button
        v-if="props.modelValue"
        class="clear"
        type="button"
        aria-label="入力を消去"
        title="入力を消去"
        @click="clear"
      >
        ×
      </button>
    </div>
  </label>
</template>

<style scoped>
.clearable {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.input-wrap {
  position: relative;
}

/* 消去ボタンがテキストと重ならないように右側に余白を空ける */
.input-wrap .field {
  padding-right: 44px;
}

.clear {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  width: 32px;
  height: 32px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.clear:hover,
.clear:focus-visible {
  color: var(--accent);
  background: #0b1220;
}
</style>
