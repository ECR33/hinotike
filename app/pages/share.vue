<script setup lang="ts">
/**
 * アプリ共有画面(登録済みユーザのみ。保護は app/middleware/auth.global.ts のデフォルト拒否)。
 *
 * 運用: この画面でアプリのトップURLのQRを表示し、別のスマホ(新しいユーザ)の
 * カメラ/QRリーダーで読み取ってアプリを開いてもらう。開いた人はトップから
 * Googleログインし、未登録ならグローバルミドルウェアが /unauthorized へ誘導する。
 * そこで「許可を求める」QRを作る → 登録済みユーザが /register で読んで許可、という
 * 既存の許可依頼フローに automatic に接続する(リンクに専用パラメータは載せない)。
 *
 * QRの中身: 設定の appUrl(本番の公開URL)。未設定(dev)では現在の origin を使う。
 * 描画は QrDots ドットスタイル(app/components/QrDots.vue。既存の qrcode ライブラリの
 * QRCode.create から SVG に描き直すだけ。読み取りは相手のスマホのカメラ/リーダー)。
 * ログアウトは BottomNav の dropdown に移動したのでページ内ボタンは無い。
 */

const config = useRuntimeConfig()

// SSR では appUrl 設定のみが確定値。dev(appUrl 空)の origin はブラウザ側でのみ分かるため、
// onMounted で埋める(SSR と client の初回描画を一致させるため、リンク文字は mount 後にだけ出す)。
const appLink = ref('')
const copied = ref(false)
const errorMessage = ref<string | null>(null)
// QrDots の expose(render)。同じURLでも「QR再生成」で作り直せるようにする。
const qrEl = ref<{ render: (value: string) => Promise<void> } | null>(null)

async function copyLink() {
  errorMessage.value = null
  try {
    await navigator.clipboard.writeText(appLink.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    errorMessage.value = 'コピーに失敗しました(ブラウザが clipboard API を許可していません)'
  }
}

onMounted(() => {
  appLink.value = String(config.public.appUrl ?? '') || window.location.origin
})
</script>

<template>
  <div class="page">
    <h1>アプリ共有</h1>

    <div class="card">
      <p class="muted">
        このQRを別のスマホのカメラ(またはQRリーダーアプリ)で読み取るとアプリのトップが開けます。
        読み取った人はそこで Googleログインし、まだ未登録なら許可依頼画面へ誘導されます。
        その人が作った「許可を求める」QRを、登録済みのユーザが「利用者登録」で読むと登録完了します。
      </p>
      <p v-if="appLink" class="mono">リンク: {{ appLink }}</p>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
      <div v-if="appLink" class="qr-box">
        <QrDots ref="qrEl" :value="appLink" />
      </div>
      <div class="actions">
        <button class="btn secondary" type="button" :disabled="!appLink" @click="qrEl?.render(appLink)">
          QR再生成
        </button>
        <button class="btn secondary" type="button" :disabled="!appLink" @click="copyLink">
          {{ copied ? 'コピーしました' : 'リンクをコピー' }}
        </button>
      </div>
    </div>

    <div class="card">
      <h2>新しいユーザ側の流れ</h2>
      <ol class="steps">
        <li>QRを読む → アプリのトップが開く</li>
        <li>「Googleでログイン」からログイン</li>
        <li>未登録なら「許可を求める」QRが表示される(有効期限付き)</li>
        <li>登録済みユーザが「利用者登録」(/register)でそのQRを読み、email確認して許可</li>
        <li>許可されると自動で QRスキャン画面へ移動する</li>
      </ol>
      <p class="muted">
        代替運用: 管理者が users に email を事前登録すると、読み取り後のログインで自動紐付けされます。
      </p>
    </div>
  </div>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 13px;
  color: var(--muted);
  word-break: break-all;
}

.qr-box {
  margin-top: 12px;
}

.qr-box {
  display: flex;
  justify-content: center;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.steps {
  margin: 0;
  padding-left: 20px;
  color: var(--muted);
  font-size: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
