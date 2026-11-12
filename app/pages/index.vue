<script setup lang="ts">
import { authErrorMessage, isSafeLocalPath, type MeState } from '#shared/utils/auth'

const route = useRoute()
const config = useRuntimeConfig()
// ログアウトは BottomNav(app/components/BottomNav.vue)の項目で行う(ページ内ボタンは重複のため撤去)。

// OAuth 再開はサーバー側エンドポイント(/api/auth/login)へ。ブラウザ client は使わない。
const returnTo = isSafeLocalPath(route.query.returnTo) ? route.query.returnTo : '/scan'
const loginHref = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`

// SSR ではブラウザ cookie が内部 $fetch に自動で伝わらないため useRequestHeaders で明示転送する。
// BottomNav(とグローバルミドルウェア)が解決済みの auth-state 缓存があれば再利用し、
// /api/me の重複照会(SSR + hydration client)を避ける。
const authState = useState<MeState | null>('auth-state', () => null)
const me = authState.value ?? await $fetch<MeState>('/api/me', { headers: useRequestHeaders(['cookie']) })
if (authState.value === null) authState.value = me

// URL に載るのは固定エラーコードのみ。表示文言は authErrorMessage で出し分ける。
const authError = typeof route.query.error === 'string' ? authErrorMessage(route.query.error) : null

const supabaseConfigured = Boolean(config.public?.supabase?.url && config.public?.supabase?.key)
</script>

<template>
  <div class="page">
    <h1>Hinotike</h1>

    <div v-if="authError" class="error card">{{ authError }}</div>

    <div class="card">
      <p class="muted">
        QRコードを読み取り、Supabase（Google Spreadsheet からインポートしたデータ）を
        照会して結果を表示します。トップページは認証不要です。
      </p>
    </div>

    <div class="card">
      <template v-if="me.authenticated && me.authorized">
        <p class="muted">{{ me.email }} でログイン済み</p>
        <NuxtLink class="btn" :to="returnTo">QRコードを読む</NuxtLink>
      </template>

      <template v-else-if="me.authenticated">
        <p class="muted">Googleログイン済みですが、usersテーブルへの紐付けがありません。</p>
        <NuxtLink class="btn secondary" to="/unauthorized">詳細</NuxtLink>
      </template>

      <template v-else>
        <p class="muted">
          QR読み取り・結果表示には Google認証 + usersテーブルへの事前登録が必要です。
        </p>
        <!-- 素の a href の意味は保つ(GoogleLoginButton が preventDefault+location.href でサーバーリダイレクトへ):
             SPAルーティングを通さず OAuth に進む。クリック後スピナーで進行中を示す -->
        <GoogleLoginButton :href="loginHref" />
        <p v-if="!supabaseConfigured" class="error">
          .env に Supabase の URL / key を設定してください。
        </p>
      </template>
    </div>
  </div>
</template>
