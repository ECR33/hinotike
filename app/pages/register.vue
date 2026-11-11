<script setup lang="ts">
// 利用者登録画面: 許可済みの利用者が「許可を求める」QRを読み、
// 依頼者のemailを確認(preview)してから許可(approve)する二段階。
// 保護は app/middleware/auth.global.ts(デフォルト拒否)で行う — 登録済みでないと入れない。
import { parseRegistrationCode, approvalStatusMessage } from '#shared/utils/registration'

interface PreviewResult {
  status: string
  email?: string
  name?: string
}
interface ApproveResult {
  status: string
  email?: string
}

// ログアウトは BottomNav(app/components/BottomNav.vue)の項目で行う(ページ内ボタンは重複のため撤去)。

// QrScanner は検出1回で停止するため、再スキャンは key の変更で再マウントする。
const scannerKey = ref(0)
const message = ref<string | null>(null)
const preview = ref<{ email: string; name: string | null } | null>(null)
const pendingCode = ref<string | null>(null)
const busy = ref(false)
const doneEmail = ref<string | null>(null)

function rescan() {
  preview.value = null
  pendingCode.value = null
  scannerKey.value++
}

async function onDetected(code: string) {
  message.value = null
  doneEmail.value = null
  if (!parseRegistrationCode(code)) {
    message.value = '利用者登録用のQRコードではありません。依頼者の「許可を求める」QRをスキャンしてください。'
    rescan()
    return
  }
  pendingCode.value = code
  busy.value = true
  try {
    const res = await $fetch<PreviewResult>('/api/approval-preview', { method: 'POST', body: { code } })
    if (res.status === 'ok') {
      preview.value = { email: res.email ?? '', name: res.name || null }
    } else {
      message.value = approvalStatusMessage(res.status)
      rescan()
    }
  } catch {
    message.value = '依頼の確認に失敗しました。もう一度スキャンしてください。'
    rescan()
  } finally {
    busy.value = false
  }
}

async function approve() {
  const code = pendingCode.value
  if (!code || !preview.value) return
  busy.value = true
  try {
    const res = await $fetch<ApproveResult>('/api/approval-approve', { method: 'POST', body: { code } })
    if (res.status === 'ok') {
      doneEmail.value = res.email ?? preview.value.email
      message.value = null
      rescan()
    } else {
      message.value = approvalStatusMessage(res.status)
      rescan()
    }
  } catch {
    message.value = '許可の登録に失敗しました。もう一度スキャンしてください。'
    rescan()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <h1>利用者登録(許可)</h1>
    <div v-if="!preview" class="card">
      <p v-if="!doneEmail" class="muted">許可を求めるQRを読み、依頼者のemailを確認してから許可します。</p>
      <QrScanner :key="scannerKey" :disabled="busy" @detected="onDetected" />
    </div>

    <div v-if="preview" class="card">
      <p>
        依頼者: <strong>{{ preview.email }}</strong>
        <span v-if="preview.name">（{{ preview.name }}）</span>
      </p>
      <p class="muted">この利用者を許可リスト(usersテーブル)に登録しますか?</p>
      <div class="action-row">
        <button class="btn" :disabled="busy" @click="approve">許可する</button>
        <button class="btn secondary" :disabled="busy" @click="rescan">キャンセル</button>
      </div>
    </div>

    <p v-if="doneEmail" class="muted">登録しました: {{ doneEmail }}</p>
    <p v-if="message" class="error">{{ message }}</p>
  </div>
</template>

<style scoped>
.action-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
