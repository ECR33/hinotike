<script setup lang="ts">
/**
 * 「Googleでログイン」ボタン。/api/auth/login はサーバーリダイレクトで
 * OAuth へ進むため、クリックから次の描画まで画面が止まったように見える。
 * クリック直後にボタンへスピナーを出し、裏でリダイレクトが進んでいることを示す。
 * 素の a href の意味(SPAルーティングを通さない)は保つため、
 * preventDefault 後に nextTick で描画をflushしてから location.href へ飛ぶ。
 */
const props = defineProps<{ href: string }>()

const busy = ref(false)

async function startLogin(e: MouseEvent) {
  e.preventDefault() // 描画を先にflushしてスピナーを見せてから遷移する
  if (busy.value) return // 二重クリック防止
  busy.value = true
  await nextTick()
  window.location.href = props.href
}

// bfcache(戻る操作)で復活したときは busy が true のまま復元されるため解除する。
function onPageShow(e: PageTransitionEvent) {
  if (e.persisted) busy.value = false
}

onMounted(() => window.addEventListener('pageshow', onPageShow))
onUnmounted(() => window.removeEventListener('pageshow', onPageShow))
</script>

<template>
  <a class="btn" :href="props.href" :class="{ busy }" :aria-busy="busy" @click="startLogin">
    <span v-if="busy" class="spinner" aria-hidden="true"></span>
    {{ busy ? 'ログイン中…' : 'Googleでログイン' }}
  </a>
</template>
