// ページキャッシュ名は端末データの削除(`app/utils/offlineStore.ts` の `offlineClearPageCache`)が消す名前なので
// 共有モジュールから1つの値を imported する(Workbox の cacheName と削除側のズレ防止)。
import { OFFLINE_PAGE_CACHE_NAME } from './shared/utils/offline'

export default defineNuxtConfig({
  compatibilityDate: '2025-09-14',
  devtools: { enabled: false },

  // 本番は Cloudflare Workers(cloudflare-module preset)。node サーバープリセットは使わない。
  // nitro が .output/server/wrangler.json を生成し、ルートの wrangler.jsonc(name/vars/compat)を合成する。
  // デプロイは `npm run deploy:cf`(GitHub Actions も同じ経路)。dev は nuxt dev のまま(node)。
  nitro: {
    preset: 'cloudflare-module',
  },

  // 認証は @nuxtjs/supabase モジュールに委譲。
  // クライアント/サーバーの cookie 運用を1系統に統一し、自前 browser client は使わない。
  modules: ['@nuxtjs/supabase', '@vite-pwa/nuxt'],

  // PWA: @vite-pwa/nuxt(generateSW)。方針は「インストール可能+アプリシェルキャッシュ+オフラインページ」。
  // - precache はビルドの静的資産(ワークボックス既定)。SPA 遷移(/scan→/result の JS チャンク)は
  //   precache でオフラインでも開く(/result の照会オフラインはローカルスナップショットにフォールバック)。
  // - navigateFallback:null — SSRページ(/, /scan, /items)は NetworkFirst の runtimeCaching で端末ごとに缓存し、
  //   通信失敗(地下)のときだけ缓存をフォールバックで返す。オンラインでは素直に SSR が返る
  //   (認証付き HTML は混ざらない端末ローカル cache に置くだけ)。
  // - API(/api/*, Supabase)はキャッシュしない(認証付き動的データ。オフラインのデータは
  //   /scan の「オフラインモード準備」が IndexedDB にダウンロードする)。
  // - dev ではSW無効(モジュール既定)。本番 build のみ登録。
  pwa: {
    // SW 登録はモジュールの autoRegister(vite-plugin-pwa の virtual:registerSW が client に注入される)。
    // `registerPlugin` はこの版の型/実装には無い(ビルド済み client に registerSW が入っていることを確認済み)。
    registerType: 'autoUpdate',
    manifest: {
      id: '/',
      name: 'Hinotike',
      short_name: 'Hinotike',
      description: 'ひのまつりチケットのQR照会アプリ',
      lang: 'ja',
      dir: 'ltr',
      theme_color: '#0f172a',
      background_color: '#0f172a',
      display: 'standalone',
      start_url: '/',
      scope: '/',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      navigateFallback: null,
      // オフラインモード用ページキャッシュ: / と /scan は NetworkFirst(SSR の認証付き HTML を端末ローカルに缓存し、
      // 地下などの通信失敗/タイムアウト時だけ缓存を返す)。/result・/items は SPA 遷移で開くので
      // precache された JS チャンクで動き、HTML の缓存は不要(/result はローカル照会にフォールバックする)。
      // pattern は URL の末尾が / か /scan のものだけ(API path には当たらない)。
      // cacheName は shared/utils/offline の OFFLINE_PAGE_CACHE_NAME と同じ値(端末データの削除で caches.delete する)。
      // 缓存 HTML には氏名(/items の1ページ目は SSR で描画)と email(/ のログイン状態)が載ることに注意。
      runtimeCaching: [
        {
          urlPattern: /\/(?:|items|scan)$/,
          handler: 'NetworkFirst',
          options: {
            cacheName: OFFLINE_PAGE_CACHE_NAME,
            networkTimeoutSeconds: 3,
            cacheableResponse: { statuses: [200] },
          },
        },
      ],
    },
  },

  // セッション cookie の Secure。モジュール既定は常に secure:true だが、
  // http://localhost(dev ローカル Supabase)ではブラウザが Secure cookie を破棄し
  // ログイン session が張られない。local の http URL のときだけ Secure を切る
  // (hosted Supabase https / 本番は true のまま)。
  // nuxt.config 評価前に CLI の --dotenv/.env が適用されているため env を読める。
  supabase: {
    cookieOptions: {
      secure: !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(
        process.env.NUXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '',
      ),
    },
    // ルート保護は自前の app/middleware/auth.global.ts(デフォルト拒否+公開ルートホワイトリスト)で行う。
    redirect: false,
    redirectOptions: {
      login: '/login',
      callback: '/api/auth-callback',
      exclude: ['/', '/login', '/unauthorized'],
    },
  },

  vite: {
    optimizeDeps: {
      // 照合(qr-scanner の連続スキャン)を事前にバンドルしておき、初回アクセス時の
      // ページリロードを防ぐ。onMounted の動的importなので、dev で依存発見リロードが
      // 起きるとスキャンが中断される。zxing はアプリランタイムでは使わない(テスト/検証のみ)。
      include: ['qr-scanner'],
    },
    server: {
      // 開発サーバーの Host ヘッダー検証。許可ホストはすべて環境変数から。
      // DEV_ALLOWED_HOSTS(カンマ区切り) / NUXT_VITE_ALLOWED_HOST(単一ホスト)。
      // 特定のホスト名を nuxt.config にハードコードしない。
      allowedHosts: [
        ...(process.env.DEV_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? []),
        ...(process.env.NUXT_VITE_ALLOWED_HOST ? [process.env.NUXT_VITE_ALLOWED_HOST] : []),
      ],
    },
  },

  runtimeConfig: {
    public: {
      // 本番の公開 baseUrl(tunnel等の外部ホスト)。未設定ならリクエストの Host から導出。
      appUrl: '',
    },
  },

  app: {
    head: {
      title: 'Hinotike',
      link: [
        // favicon: 文字なしのQRマーク(public/favicon.svg)。Nuxt4に app.favicon は無いので head.link で出す。
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        // iOS(home screen)用。角丸・透過の192pxアイコン。
        { rel: 'apple-touch-icon', href: '/icons/icon-192.png' },
      ],
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#0f172a' },
      ],
    },
  },
})
