<script setup lang="ts">
import type { MeState } from '#shared/utils/auth'

// グローバルミドルウェアが「認証済み・未紐付け」でここへ飛ばす。
// このページ自体はホワイトリストで公開扱い(useRequestHeaders で cookie を明示転送)。
// ログアウトは BottomNav(app/components/BottomNav.vue)の項目で行う(ページ内ボタンは重複のため撤去)。

// ミドルウェア(BottomNav も同じ)は 'auth-state' に認証状態を缓存する。
// 缓存があれば再利用して /api/me の重複照会を防ぐ。許可された直後に /scan へ遷移するには、
// 缓存を新しい状態へ更新してから navigateTo する必要がある(更新しないと
// middleware が缓存の authorized:false で /unauthorized に戻してしまう)。
const authState = useState<MeState | null>('auth-state', () => null)
const me = authState.value ?? await $fetch<MeState>('/api/me', { headers: useRequestHeaders(['cookie']) })
if (authState.value === null) authState.value = me

const token = ref<string | null>(null)
const expiresAt = ref<number | null>(null)
const minutesLeft = ref<number | null>(null)
const requesting = ref(false)
const requestError = ref<string | null>(null)
const expired = ref(false)
const waiting = ref(false)

async function requestPermission() {
  requesting.value = true
  requestError.value = null
  expired.value = false
  token.value = null
  try {
    const res = await $fetch<{ token: string; expiresAt: string | null }>(
      '/api/registration-request',
      { method: 'POST' },
    )
    token.value = res.token
    await renderQr(res.token)
    expiresAt.value = res.expiresAt ? Date.parse(res.expiresAt) : null
    minutesLeft.value = expiresAt.value ? Math.max(0, Math.ceil((expiresAt.value - Date.now()) / 60000)) : null
    startPolling()
  } catch (e: unknown) {
    const status = (e as { statusCode?: number }).statusCode
    requestError.value =
      status === 409
        ? 'すでに登録済みです。ページを reloading してください'
        : '依頼の作成に失敗しました。もう一度お試しください'
  } finally {
    requesting.value = false
  }
}

const qrDataUrl = ref('')

// qrcode は client 側でのみ使う(SSR で QR を描かないため dynamic import)。
async function renderQr(value: string) {
  try {
    const { default: QRCode } = await import('qrcode')
    qrDataUrl.value = await QRCode.toDataURL(value, { margin: 2, errorCorrectionLevel: 'M' })
  } catch {
    requestError.value = 'QRの生成に失敗しました'
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null
function startPolling() {
  waiting.value = true
  if (pollTimer) clearInterval(pollTimer)
  // 許可されたら /api/me が authorized:true を返す(client の $fetch は cookie を自動送信)。
  pollTimer = setInterval(async () => {
    if (expiresAt.value && Date.now() >= expiresAt.value) {
      expired.value = true
      minutesLeft.value = 0
    } else if (expiresAt.value) {
      minutesLeft.value = Math.max(0, Math.ceil((expiresAt.value - Date.now()) / 60000))
    }
    try {
      const m = await $fetch<MeState>('/api/me')
      authState.value = m
      if (m.authorized) {
        stopPolling()
        await navigateTo('/scan')
      }
    } catch {
      // 一時の通信失敗は次の回で再試行(状態は変わらない)
    }
  }, 2500)
}

function stopPolling() {
  waiting.value = false
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onMounted(() => {
  // 缓存のズレで登録済みのユーザがここに着いた場合はすぐ /scan へ
  if (me.authorized) {
    void navigateTo('/scan')
  }
})

onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="page">
    <h1>未登録ユーザ</h1>
    <div class="card">
      <p>
        {{ me.email ?? '（不明）' }} は Google認証済みですが、
        許可リスト(usersテーブル)にないため、このアプリは利用できません。
      </p>
      <p class="muted">
        下の「許可を求める」でQRを作り、許可済みの利用者に見せて読んでもらうと
        許可リストに登録されます(登録されると自動で QRスキャン画面へ移動します)。
      </p>
    </div>

    <div class="card">
      <button class="btn" :disabled="requesting" @click="requestPermission">
        {{ token ? 'QR再生成' : '許可を求める' }}
      </button>
      <p v-if="requesting" class="muted">依頼を作成しています…</p>
      <p v-if="requestError" class="error">{{ requestError }}</p>
      <div v-if="token" class="qr-box">
        <img v-if="qrDataUrl" class="qr-img" :src="qrDataUrl" alt="許可依頼QRコード">
        <p class="muted">
          有効期限: 約 {{ minutesLeft ?? '?' }} 分<span v-if="expired">(期限切れ。再生成してください)</span>
        </p>
        <p class="muted">許可済みの利用者の「利用者登録」画面(/register)でこのQRを読んでください。</p>
      </div>
      <p v-if="waiting" class="muted">登録されるのを待っています…</p>
    </div>

    <div class="card">
      <p class="muted">
        代替運用: 管理者が users に email を事前登録すると、次回ログインで自動紐付けされます。
      </p>
    </div>
  </div>
</template>

<style scoped>
.qr-box {
  margin-top: 12px;
}

.qr-img {
  width: min(280px, 60vw);
  height: auto;
  background: #fff;
  border-radius: 6px;
}
</style>
