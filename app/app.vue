<template>
  <div class="shell">
    <!-- @vite-pwa/nuxt: SSRのheadに<link rel="manifest">を注入する(描画自体は空) -->
    <VitePwaManifest />
    <NuxtPage />
    <BottomNav />
  </div>
</template>

<style>
:root {
  --bg: #0f172a;
  --panel: #1e293b;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --accent: #38bdf8;
  --danger: #f87171;
}

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
  -webkit-text-size-adjust: 100%;
}

.shell {
  min-height: 100vh;
  min-height: 100dvh;
}

.page {
  max-width: 640px;
  margin-inline: auto;
  /* bottom navigation(fixed)にコンテンツが隠れないように下端を確保する
     (バーの実高度 ≒ 62px + ノッチ/ホームバーの安全領域ぶん)。 */
  padding: 16px 16px calc(90px + env(safe-area-inset-bottom));
}

.card {
  background: var(--panel);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}

.btn {
  display: inline-block;
  background: var(--accent);
  color: #0b1220;
  border: none;
  border-radius: 10px;
  padding: 12px 18px;
  font-size: 16px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.btn.secondary {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--muted);
}

.btn:disabled { opacity: 0.6; }

.field {
  width: 100%;
  background: #0b1220;
  color: var(--text);
  border: 1px solid var(--muted);
  border-radius: 10px;
  padding: 12px;
  font-size: 16px;
  box-sizing: border-box;
}

h1 { font-size: 22px; margin: 12px 0; }
h2 { font-size: 18px; margin: 12px 0 8px; }
.muted { color: var(--muted); font-size: 14px; }
.error { color: var(--danger); font-size: 14px; }
</style>
