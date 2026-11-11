<script setup lang="ts">
// 保護は app/middleware/auth.global.ts(グローバル+ホワイトリスト)で行う。
// ページ単位の definePageMeta({ middleware: 'auth' }) は不要になった。
// ログアウトは BottomNav(app/components/BottomNav.vue)の項目で行う(ページ内ボタンは重複のため撤去)。
// 手入力欄(テスト用)は撤去: 本番でも常に表示されていた(dev 限定の gating はなかった)。
// code を直接照会する用途は /items の一覧+code 検索が同じ役割を果たすのでそちらに寄せる。
function onDetected(code: string) {
  navigateTo(`/result?code=${encodeURIComponent(code)}`)
}
</script>

<template>
  <div class="page">
    <h1>QRコードを読む</h1>

    <div class="card">
      <QrScanner @detected="onDetected" />
    </div>
  </div>
</template>
