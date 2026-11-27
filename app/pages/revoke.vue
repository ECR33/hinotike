<script setup lang="ts">
// ログイン権限のリボーク(0012): can_purge の利用者(スーパーユーザ的 position)が
// 他の利用者のログイン権を無効化/解除する画面。users 行の soft revoke(revoked_at を立てる)で、
// RLS・guard の共通根 is_registered_user() が即座に全アクセスを拒否する(users 行と
// 身分スナップショット(0010)は監査として残る)。解除(restore)も同じ画面から。
// 保護は app/middleware/auth.global.ts(登録済み必須)。can_purge の出し分けは /api/me の canPurge、
// 発動の権限は RPC list_users/revoke_user/restore_user の can_purge ガードが集約する(forbidden は 403)。
import { describeApiError } from '#shared/utils/apiError'
import type { MeState } from '#shared/utils/auth'

const authState = useState<MeState | null>('auth-state', () => null)
const canPurge = computed(() => authState.value?.canPurge === true)

interface UserRow {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  provider: string | null
  provider_subject: string | null
  can_purge: boolean
  created_at: string
  linked_at: string | null
  revoked_at: string | null
  revoked_by_email: string | null
}
interface RevokeResult {
  status: string
  email?: string
}

const users = ref<UserRow[]>([])
const myEmail = computed(() => (authState.value?.email ?? '').toLowerCase())
const busy = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
// 2段階確認(1回目で「本当に?」の案内、2回目で実行)。purge/discardQueue と同じ運用方針。
const armedEmail = ref<string | null>(null)

async function load() {
  busy.value = true
  error.value = null
  try {
    const res = await $fetch<{ users: UserRow[] }>('/api/revoke-list')
    users.value = res.users
  } catch (e: unknown) {
    error.value = describeApiError(e).friendly
  } finally {
    busy.value = false
  }
}
onMounted(() => { if (canPurge.value) void load() })

async function revoke(user: UserRow) {
  if (armedEmail.value !== user.email) {
    armedEmail.value = user.email
    message.value = `${user.email} のログイン権を無効化します(その利用者は全画面・APIがすぐ拒否され、/unauthorized の案内になる)。もう一度ボタンで実行`
    return
  }
  busy.value = true
  error.value = null
  message.value = null
  try {
    const res = await $fetch<RevokeResult>('/api/revoke-user', {
      method: 'POST',
      body: { email: user.email },
    })
    if (res.status === 'ok') {
      message.value = `${user.email} のログイン権を無効化しました(解除もこの画面からできます)`
      await load()
      armedEmail.value = null
    } else if (res.status === 'forbidden') {
      error.value = 'リボークできる利用者(users.can_purge)ではありません'
      armedEmail.value = null
    } else if (res.status === 'forbidden_self') {
      error.value = '自分のログイン権はリボークできません(ロックアウト事故防止)'
      armedEmail.value = null
    } else if (res.status === 'already_revoked') {
      error.value = 'すでにリボーク済みです'
      await load()
      armedEmail.value = null
    } else if (res.status === 'not_found') {
      error.value = 'その email の利用者が見つかりません'
      armedEmail.value = null
    } else {
      error.value = 'リボークできませんでした'
      armedEmail.value = null
    }
  } catch (e: unknown) {
    error.value = describeApiError(e).friendly
    armedEmail.value = null
  } finally {
    busy.value = false
  }
}

async function restore(user: UserRow) {
  busy.value = true
  error.value = null
  message.value = null
  try {
    const res = await $fetch<RevokeResult>('/api/revoke-restore', {
      method: 'POST',
      body: { email: user.email },
    })
    if (res.status === 'ok') {
      message.value = `${user.email} のログイン権を復活させました`
      await load()
    } else if (res.status === 'not_revoked') {
      error.value = 'リボークされていない利用者です'
      await load()
    } else if (res.status === 'forbidden') {
      error.value = 'リボーク解除できる利用者(users.can_purge)ではありません'
    } else {
      error.value = '解除できませんでした'
    }
  } catch (e: unknown) {
    error.value = describeApiError(e).friendly
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <h1>ログイン権限のリボーク</h1>

    <div v-if="!canPurge" class="card">
      <p class="muted">この画面を使えるのはリボークできる利用者(users.can_purge)だけです。</p>
    </div>

    <template v-if="canPurge">
      <p class="muted">
        利用者のログイン権を無効化します。権限はすぐ切れます(全画面・APIが拒否され、その利用者は
        「許可依頼」の案内になる)。users の行と登録時のスナップショット(email・氏名・画像・Google の sub)は
        監査として残ります。解除もこの画面から。リボーク済みの利用者の再許可は QR 承認(人間の承認)でも可能です。
      </p>

      <div v-if="users.length === 0" class="card">
        <p class="muted">利用者がいません。</p>
      </div>

      <div v-for="user in users" :key="user.id" class="card">
        <div class="requester-row">
          <img
            v-if="user.avatar_url"
            class="requester-avatar"
            :src="user.avatar_url"
            :alt="user.name ?? user.email"
            referrerpolicy="no-referrer"
            @error="user.avatar_url = null"
          >
          <div class="requester-main">
            <div class="requester-name">
              <strong>{{ user.name ?? user.email }}</strong>
              <span v-if="user.email === myEmail" class="badge">自分</span>
              <span v-if="user.can_purge" class="badge">管理者</span>
            </div>
            <div class="requester-email">{{ user.email }}</div>
          </div>
        </div>
        <p v-if="user.revoked_at" class="muted">
          リボーク済み: {{ user.revoked_at }}(by {{ user.revoked_by_email ?? 'can_purge利用者' }})
        </p>
        <div class="action-row">
          <button v-if="user.revoked_at" class="btn" :disabled="busy" @click="restore(user)">ログイン権を復活</button>
          <button v-else class="btn danger" :disabled="busy" @click="revoke(user)">
            {{ armedEmail === user.email ? `本当にリボーク(${user.email})` : 'ログイン権を無効化' }}
          </button>
        </div>
      </div>

      <p v-if="message" class="muted">{{ message }}</p>
      <p v-if="error" class="error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
/* 行は折り返さない: 画像 + (氏名とバッジの1行 / emailの1行)。長い名前は ellipsis で切る */
.requester-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.requester-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--bg, #eee);
  flex: none;
}
.requester-main {
  flex: 1;
  min-width: 0;
}
.requester-name {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.requester-name strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  flex: none;
  font-size: 12px;
  color: var(--muted);
  border: 1px solid var(--border, #334155);
  border-radius: 999px;
  padding: 2px 8px;
}
.requester-email {
  margin-top: 2px;
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.action-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
