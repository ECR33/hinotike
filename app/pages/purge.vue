<script setup lang="ts">
// 端末データの消去指示(0011): can_purge の利用者(最初期ユーザ=スーパーユーザ的 position)が
// 「イベント終了」を中央(DB)に宣言する画面。指示はデータセット単位で、
// sync_sources.purge_epoch の +1 + 監査行(purge_events)として残る。
// 端末は次回通信(/scan mount・flush・/items mount)で epoch を比較し、自分のミラーを捨てる
// (app/composables/useDevicePurge.ts)。強制 remote delete はできない — 端末がオンラインになったときに apply。
// 保護は app/middleware/auth.global.ts(登録済み必須)。can_purge の出し分けは /api/me の canPurge、
// 発動の権限は RPC issue_dataset_purge の can_purge ガードが集約する(forbidden は 403)。
import { describeApiError } from '#shared/utils/apiError'
import type { MeState } from '#shared/utils/auth'
import type { SourceConfigResponse, SyncSource } from '#shared/utils/sync'

const authState = useState<MeState | null>('auth-state', () => null)
const canPurge = computed(() => authState.value?.canPurge === true)

interface PurgeState {
  epochs?: Record<number, number>
}
interface PurgeIssueResult {
  status: string
  source_id?: number
  purge_epoch?: number
}

const sources = ref<SyncSource[]>([])
const epochs = ref<Record<number, number>>({})
const busy = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
// 2段階確認(1回目で「本当に?」の案内、2回目で実行)。discardQueue と同じ運用方針。
const armedSourceId = ref<number | null>(null)

async function load() {
  busy.value = true
  error.value = null
  try {
    const [cfg, state] = await Promise.all([
      $fetch<SourceConfigResponse>('/api/sync-config'),
      $fetch<PurgeState>('/api/purge-state'),
    ])
    sources.value = cfg.sources.filter((s) => s.enabled)
    epochs.value = state.epochs ?? {}
  } catch (e: unknown) {
    error.value = describeApiError(e).friendly
  } finally {
    busy.value = false
  }
}
onMounted(() => { if (canPurge.value) void load() })

async function issue(source: SyncSource) {
  if (source.id == null) return
  if (armedSourceId.value !== source.id) {
    armedSourceId.value = source.id
    message.value = `"${source.name}" の端末コピー消去指示を出します(全端末のこのデータセットのミラーが次回通信で捨てられます)。もう一度ボタンで実行`
    return
  }
  busy.value = true
  error.value = null
  message.value = null
  try {
    const res = await $fetch<PurgeIssueResult>('/api/purge-issue', {
      method: 'POST',
      body: { sourceId: source.id },
    })
    if (res.status === 'ok') {
      message.value = `消去指示を出しました: "${source.name}" (epoch ${res.purge_epoch})。各端末は次回通信でこのデータセットのコピーを捨てます`
      epochs.value = { ...epochs.value, [source.id]: res.purge_epoch ?? epochs.value[source.id] ?? 0 }
      armedSourceId.value = null
    } else if (res.status === 'forbidden') {
      error.value = '消去指示を出せる利用者(users.can_purge)ではありません'
      armedSourceId.value = null
    } else if (res.status === 'not_found') {
      error.value = 'データセットが見つかりません(削除済みの可能性があります)'
      armedSourceId.value = null
    } else {
      error.value = '消去指示を出せませんでした'
      armedSourceId.value = null
    }
  } catch (e: unknown) {
    error.value = describeApiError(e).friendly
    armedSourceId.value = null
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <h1>端末データの消去指示</h1>

    <div v-if="!canPurge" class="card">
      <p class="muted">この画面を使えるのは消去指示を出せる利用者(users.can_purge)だけです。</p>
    </div>

    <template v-if="canPurge">
      <p class="muted">
        スキャンのイベントが終了したら、データセットごとに「端末コピーを消去」の指示を出します。
        指示は中央(DB)に記録され、各端末は次回通信(スキャン画面の開き・記録の確定・一覧の開き)で
        このデータセットの端末内のコピー(氏名・備考)を捨てます。ためた記録は code として残ります(氏名のみ除去)。
      </p>

      <div v-if="sources.length === 0" class="card">
        <p class="muted">有効なデータセットがありません。</p>
      </div>

      <div v-for="source in sources" :key="source.id ?? source.name" class="card">
        <p>
          <strong>{{ source.name }}</strong>
          <span class="muted"> / 消去指示 epoch {{ epochs[source.id ?? 0] ?? 0 }}</span>
        </p>
        <div class="action-row">
          <button
            class="btn danger"
            :disabled="busy"
            @click="issue(source)"
          >{{ armedSourceId === source.id ? `本当に消去指示を出す(${source.name})` : 'イベント終了 → 端末コピーを消去' }}</button>
        </div>
      </div>

      <p v-if="message" class="muted">{{ message }}</p>
      <p v-if="error" class="error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.action-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
