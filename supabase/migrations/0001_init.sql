-- Hinotike: 初期マイグレーション(slack2mail の認証設計を単一テナント版に落とし込んだもの)
-- 実行順: テーブル → 関数 → RLS ポリシー(ポリシーが public.is_registered_user() を参照するため、関数の先行作成が必須) → grant
-- ホスト版の SQL Editor で実行する場合も同じ順(supabase/migrations/0001_init.sql と同一)で実行すること。
--
-- ★ 移行メモ: 旧スキーマ(users.id = auth.users.id を PK とする方式)とは互換性がありません。
--   既存の users/items がある場合は drop して再作成してください。
--   items の中身は同期スクリプト(npm run sync:sheets)で再取得できます。
drop table if exists public.users;
drop table if exists public.items;

-- 事前登録: 管理者が「初回ログインの前」に email を登録する行。
-- 初回ログインの OAuth callback で link_my_user() が auth_user_id を自動紐付けする。
-- 登録運用で auth.users の UUID を事前照会する必要はなくなる(旧運用の改善点)。
create table public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete cascade, -- 未紐付けの間は NULL
  email text not null unique,
  name text,
  created_at timestamptz not null default now(),
  linked_at timestamptz,
  email_verified_at timestamptz
);

-- Google Spreadsheet からインポートする照会データ。
-- code = QRコードの値。選別したカラムは payload (jsonb) に格納する。
create table public.items (
  code text primary key,
  payload jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now()
);

-- 任意の email ドメイン許可リスト。0 行 = ドメイン制限なし(全ドメイン許可)。
create table public.user_email_domains (
  domain text primary key
);

-- ── 関数(RLS ポリシーより前に作成すること) ──

-- email ドメイン許可判定: user_email_domains が空なら全て許可。
create function public.user_email_allowed(email_addr text)
returns boolean
language sql stable security invoker set search_path = public as $$
  select email_addr is not null
    and position('@' in email_addr) > 0
    and (
      not exists (select 1 from public.user_email_domains)
      or exists (
        select 1 from public.user_email_domains d
        where d.domain = lower(split_part(email_addr, '@', 2))
      )
    );
$$;

-- 「ログイン済み + users に紐付け済み」の判定。RLS と API で共通に使う。
create function public.is_registered_user()
returns boolean
language sql stable security invoker set search_path = public as $$
  select auth.role() = 'authenticated'
    and exists (select 1 from public.users u where u.auth_user_id = auth.uid());
$$;

-- 初回ログイン時の自動紐付け。OAuth callback(/api/auth-callback)で一度だけ呼ぶ。
-- SECURITY DEFINER で RLS をバイパスするが、auth.role() でガードし search_path を固定。
-- 安全性の条件: 検証済み email のみ / ドメイン許可のみ / 未紐付けの行のみ / email 完全一致。
-- 紐付け失敗は session を確立済みでも致命的にしない(未紐付けは RLS が拒否する)。
create function public.link_my_user()
returns void
language plpgsql security definer set search_path = public as $$
declare
  my_email text;
  my_verified boolean;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'link_my_user: authenticated role required';
  end if;

  select lower(email), email_confirmed_at is not null
    into my_email, my_verified
  from auth.users
  where id = auth.uid();

  if my_email is null or not my_verified then
    return; -- 未検証 email は紐付けしない
  end if;

  if not public.user_email_allowed(my_email) then
    return; -- ドメインが許可されていない場合は紐付けしない
  end if;

  update public.users
     set auth_user_id = auth.uid(),
         linked_at = now(),
         email_verified_at = now()
   where auth_user_id is null
     and lower(email) = my_email;
end;
$$;

-- ── RLS ポリシー(関数が存在してから作成) ──

alter table public.users enable row level security;
alter table public.items enable row level security;
alter table public.user_email_domains enable row level security;

-- 自分の(紐付け済みの)登録行のみ閲覧可。/api/me の照会はこれを通る。
create policy "users_self_select"
  on public.users for select
  using (auth_user_id = auth.uid());

-- ドメイン許可リストは認証ユーザのみ閲覧可(link_my_user のドメイン判定用に参照される)。
create policy "domains_select_authenticated"
  on public.user_email_domains for select
  using (auth.role() = 'authenticated');

-- 紐付け済みユーザのみ items 閲覧可。判定は SQL 関数に集約(API の guard と同じ根)。
create policy "items_select_registered_users"
  on public.items for select
  using (public.is_registered_user());

-- 関数の実行権限を明示的に整理(definer 関数は authenticated からだけ呼べる)。
revoke execute on function public.link_my_user() from anon, public;
grant execute on function public.link_my_user() to authenticated;
grant execute on function public.is_registered_user() to authenticated;
-- 引数付き関数の grant はシグネチャ指定が必要(空括弧は 0引数 signature を指す)。
grant execute on function public.user_email_allowed(text) to authenticated;

-- users / ドメインの追加削除は管理のみ(Secret key で RLS bypass、またはダッシュボード手動)。
-- items の書き込みは同期スクリプトが Secret key で行う(アプリサーバーには secret key を置かない)。
