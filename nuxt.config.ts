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

  // PWA: @vite-pwa/nuxt(generateSW)。方針は「インストール可能+アプリシェルキャッシュのみ」。
  // - precache はビルドの静的資産のみ(ワークボックス既定)。
  // - navigateFallback:null — SSRページ(/, /scan, /items…)はネットワーク必須なので
  //   SWでオフラインフォールバックを返さない(オフライン時は素直に通信エラーになる)。
  // - API(/api/*, Supabase)はキャッシュしない(認証付き動的データ)。
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
