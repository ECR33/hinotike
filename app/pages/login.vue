<script setup lang="ts">
import { authErrorMessage, isSafeLocalPath, type MeState } from '#shared/utils/auth'

/**
 * ログインページ。グローバルミドルウェアが未認証時にここへ飛ばす。
 * ログイン開始は /api/auth/login(サーバー側リダイレクト)だけを使う。
 */
const route = useRoute()
const config = useRuntimeConfig()
// ログアウトは BottomNav(app/components/BottomNav.vue)の項目で行う(ページ内ボタンは重複のため撤去)。

const returnTo = isSafeLocalPath(route.query.returnTo) ? route.query.returnTo : '/scan'
const loginHref = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`

// BottomNav(とミドルウェア)が解決済みの auth-state 缓存があれば再利用する(/api/me の重複照会防止)。
const authState = useState<MeState | null>('auth-state', () => null)
const me = authState.value ?? await $fetch<MeState>('/api/me', { headers: useRequestHeaders(['cookie']) })
if (authState.value === null) authState.value = me

const authError = typeof route.query.error === 'string' ? authErrorMessage(route.query.error) : null

const supabaseConfigured = Boolean(config.public?.supabase?.url && config.public?.supabase?.key)

// dev 限定のパスワードログイン(ローカル Supabase の UI 検証用)。
// SSR でも判定できるように NODE_ENV 判定も併用する(本番ビルドでは false)。
// hosted Supabase を指す dev(隧道テスト)では dev フォームを出さない(endpoint も 404)。
const supabaseUrl = String(config.public?.supabase?.url ?? '')
const isDevLogin = (import.meta.env.DEV === true || process.env.NODE_ENV !== 'production')
  && /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?$/i.test(supabaseUrl)
const devEmail = ref('dev@example.com')
const devPassword = ref('dev-password-2026')
const devBusy = ref(false)
const devError = ref<string | null>(null)

async function devLogin() {
  devBusy.value = true
  devError.value = null
  try {
    await $fetch('/api/auth/dev-login', { method: 'POST', body: { email: devEmail.value, password: devPassword.value } })
    // 念のための防御: 未認証時に client 側で保護ページへ遷移するとミドルウェアが
    // auth-state を「未認証」で缓存する。ログイン後その缓存で /login に戻されないよう破棄する。
    authState.value = null
    await navigateTo(returnTo)
  } catch (e: unknown) {
    const data = (e as { data?: { statusMessage?: string } })?.data
    devError.value = data?.statusMessage ?? 'dev ログインに失敗しました'
  } finally {
    devBusy.value = false
  }
}
</script>

<template>
  <div class="page">
    <h1>ログイン</h1>

    <div v-if="authError" class="error card">{{ authError }}</div>

    <div class="card">
      <template v-if="me.authenticated && me.authorized">
        <p class="muted">{{ me.email }} でログイン済み</p>
        <NuxtLink class="btn" :to="returnTo">はじめる</NuxtLink>
      </template>

      <template v-else-if="me.authenticated">
        <p class="muted">Googleログイン済みですが、usersテーブルへの紐付けがありません。</p>
        <NuxtLink class="btn secondary" to="/unauthorized">詳細</NuxtLink>
      </template>

      <template v-else>
        <p class="muted">Google アカウントでログインします。利用には事前登録(email)が必要です。</p>
        <GoogleLoginButton :href="loginHref" />
        <p v-if="!supabaseConfigured" class="error">
          .env に Supabase の URL / key を設定してください。
        </p>
      </template>
    </div>

    <div v-if="isDevLogin" class="card">
      <p class="muted">dev 検証用: ローカル Supabase のパスワードログイン(本番では表示・エンドポイントとも無効)</p>
      <div class="row">
        <input v-model="devEmail" placeholder="email" />
        <input v-model="devPassword" type="password" placeholder="password" />
        <button class="btn" :disabled="devBusy" :aria-busy="devBusy" @click="devLogin">
          <span v-if="devBusy" class="spinner" aria-hidden="true"></span>
          {{ devBusy ? 'ログイン中…' : 'dev ログイン' }}
        </button>
      </div>
      <p v-if="devError" class="error">{{ devError }}</p>
      <p class="muted">
        テストユーザの作成(許可側): <code>npm run supabase:dev-user</code> ／
        新利用者側(未登録): <code>node scripts/create-dev-user.mjs newcomer@example.com dev-password-2026 --no-registration</code>
      </p>
    </div>

    <NuxtLink class="btn secondary" to="/">トップに戻る</NuxtLink>
  </div>
</template>
