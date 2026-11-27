-- Hinotike: ログイン権限のリボーク(0012)
--
-- 目的: can_purge の利用者(スーパーユーザ的 position)が画面(/revoke)から他の利用者の
-- ログイン権限を無効化できる。「消す」ではなく users 行に revoked_at を立てる soft revoke にする:
-- - RLS と guard の共通根 public.is_registered_user() が revoked_at を除外 → 全 API・RLS が即座に拒否
-- - users 行は残るので 0010 の身分スナップショット(email/name/avatar/provider_subject)が監査として残る
--   (auth.users 削除の cascade で消える運用と違い、リボーク後も「誰だったか」が読める)
-- - 解除(revoke の undo)も同じ画面からできる RPC を用意する
-- - QR許可(approve)は revoked 行を「新しい承認で再許可」する(un-revoke)。email_taken は revoked 行を除外。
-- - 自分のリボークは forbidden_self で拒否する(唯一のスーパーユーザが自分を消して永久ロックアウトする事故防止)。
--
-- 実行順: alter table → create or replace(is_registered_user → link_my_user → approve_registration_request)
-- → 新 RPC(list_users/revoke_user/restore_user)→ grant。

alter table public.users
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references auth.users (id) on delete set null;

-- 登録判定の共通根: revoked 行は「登録済み」から外す(全 RLS ポリシー・guard が追随する)。
create or replace function public.is_registered_user()
returns boolean
language sql stable security invoker set search_path = public as $$
  select auth.role() = 'authenticated'
    and exists (
      select 1 from public.users u
      where u.auth_user_id = auth.uid() and u.revoked_at is null
    );
$$;

-- 初回ログインの自動紐付け: revoked 行には紐付けしない(リボーク後に再ログインしても復活させない)。
-- 再許可は人間の承認(QR approve)またはスーパーユーザの restore のみ。
create or replace function public.link_my_user()
returns void
language plpgsql security definer set search_path = public as $$
declare
  my_email text;
  my_verified boolean;
  my_name text;
  my_picture text;
  my_provider text;
  my_subject text;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'link_my_user: authenticated role required';
  end if;

  select lower(email),
         email_confirmed_at is not null,
         nullif(coalesce(raw_user_meta_data ->> 'name', ''), ''),
         raw_user_meta_data ->> 'picture',
         nullif(coalesce(raw_app_meta_data ->> 'provider', ''), ''),
         raw_user_meta_data ->> 'sub'
    into my_email, my_verified, my_name, my_picture, my_provider, my_subject
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
         email_verified_at = now(),
         name = coalesce(name, my_name),
         avatar_url = coalesce(avatar_url, my_picture),
         provider = coalesce(provider, my_provider),
         provider_subject = coalesce(provider_subject, my_subject)
   where auth_user_id is null
     and revoked_at is null -- リボーク済みの行は自動復活させない
     and lower(email) = my_email;
end;
$$;

-- 承認前確認(preview): revoked 行は「登録済み」扱いしない(リボーク後の再許可依頼をQRで出せる)。
create or replace function public.preview_registration_request(req_nonce uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.registration_requests;
  au record;
begin
  if auth.role() <> 'authenticated' or not public.is_registered_user() then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select * into r from public.registration_requests where nonce = req_nonce;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select lower(email) as email,
         email_confirmed_at is not null as verified,
         coalesce(raw_user_meta_data ->> 'name', '') as name,
         raw_user_meta_data ->> 'picture' as picture
    into au
    from auth.users
    where id = r.requested_uid;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if r.consumed_at is not null then
    return jsonb_build_object('status', 'consumed', 'email', au.email);
  end if;
  if r.expires_at < now() then
    return jsonb_build_object('status', 'expired', 'email', au.email);
  end if;
  if exists (select 1 from public.users u where u.auth_user_id = r.requested_uid and u.revoked_at is null) then
    return jsonb_build_object('status', 'already_registered', 'email', au.email);
  end if;
  if not au.verified then
    return jsonb_build_object('status', 'email_unverified', 'email', au.email);
  end if;
  if not public.user_email_allowed(au.email) then
    return jsonb_build_object('status', 'domain_not_allowed', 'email', au.email);
  end if;

  return jsonb_build_object('status', 'ok', 'email', au.email, 'name', au.name, 'picture', au.picture);
end;
$$;

-- 許可(consume + 紐付け): revoked 行は「今回の承認による再許可」として un-revoke する。
-- email_taken(他人が紐付け済みの行)の判定は revoked 行を除外する(リボーク済み行は再許可対象)。
create or replace function public.approve_registration_request(req_nonce uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.registration_requests;
  au record;
  linked_rows integer;
begin
  if auth.role() <> 'authenticated' or not public.is_registered_user() then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select * into r from public.registration_requests where nonce = req_nonce;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select lower(email) as email,
         email_confirmed_at is not null as verified,
         nullif(coalesce(raw_user_meta_data ->> 'name', ''), '') as name,
         raw_user_meta_data ->> 'picture' as picture,
         nullif(coalesce(raw_app_meta_data ->> 'provider', ''), '') as provider,
         raw_user_meta_data ->> 'sub' as subject
    into au
    from auth.users
    where id = r.requested_uid;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if r.consumed_at is not null then
    return jsonb_build_object('status', 'consumed', 'email', au.email);
  end if;
  if r.expires_at < now() then
    return jsonb_build_object('status', 'expired', 'email', au.email);
  end if;

  if exists (select 1 from public.users u where u.auth_user_id = r.requested_uid and u.revoked_at is null) then
    -- すでに登録済み(別のQRで許可された等)。QRの再利用も防ぐため消費扱いにする。
    update public.registration_requests
       set consumed_at = now(), approved_by = auth.uid()
     where nonce = req_nonce;
    return jsonb_build_object('status', 'already_registered', 'email', au.email);
  end if;

  if not au.verified then
    return jsonb_build_object('status', 'email_unverified', 'email', au.email);
  end if;
  if not public.user_email_allowed(au.email) then
    return jsonb_build_object('status', 'domain_not_allowed', 'email', au.email);
  end if;
  if exists (
    select 1 from public.users u
    where lower(u.email) = au.email and u.auth_user_id is not null and u.revoked_at is null
  ) then
    return jsonb_build_object('status', 'email_taken', 'email', au.email);
  end if;

  -- 事前登録行(未紐付け)または revoked 行(再許可)を紐付け、無ければ新規行を作成する。
  update public.users
     set auth_user_id = r.requested_uid,
         linked_at = now(),
         email_verified_at = now(),
         revoked_at = null,
         revoked_by = null,
         name = coalesce(name, au.name),
         avatar_url = coalesce(avatar_url, au.picture),
         provider = coalesce(provider, au.provider),
         provider_subject = coalesce(provider_subject, au.subject)
   where lower(email) = au.email
     and (auth_user_id is null or revoked_at is not null);
  GET DIAGNOSTICS linked_rows = ROW_COUNT;

  if linked_rows = 0 then
    insert into public.users (email, name, auth_user_id, linked_at, email_verified_at,
                              avatar_url, provider, provider_subject)
    values (au.email, au.name, r.requested_uid, now(), now(),
            au.picture, au.provider, au.subject);
  end if;

  update public.registration_requests
     set consumed_at = now(), approved_by = auth.uid()
   where nonce = req_nonce;

  return jsonb_build_object('status', 'ok', 'email', au.email);
end;
$$;

-- ── 管理 RPC(can_purge の利用者だけ。definer で RLS を超えた一覧/更新) ──

-- 利用者一覧(リボーク画面用)。身分スナップショットとリボーク状態を載せる。
create function public.list_users()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  out jsonb;
begin
  if auth.role() <> 'authenticated' then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if not exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid() and u.can_purge and u.revoked_at is null
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select jsonb_agg(jsonb_build_object(
    'id', u.id,
    'email', u.email,
    'name', u.name,
    'avatar_url', u.avatar_url,
    'provider', u.provider,
    'provider_subject', u.provider_subject,
    'can_purge', u.can_purge,
    'created_at', u.created_at,
    'linked_at', u.linked_at,
    'revoked_at', u.revoked_at,
    'revoked_by_email', (select lower(au.email) from auth.users au where au.id = u.revoked_by)
  ) order by u.created_at) into out
  from public.users u;

  return jsonb_build_object('status', 'ok', 'users', coalesce(out, '[]'::jsonb));
end;
$$;

-- リボーク: can_purge の利用者のみ。自分の email は forbidden_self(ロックアウト事故防止)。
create function public.revoke_user(p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rid uuid;
  my_email text;
begin
  if auth.role() <> 'authenticated' then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if not exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid() and u.can_purge and u.revoked_at is null
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select lower(email) into my_email from auth.users where id = auth.uid();
  if my_email is not null and my_email = lower(p_email) then
    return jsonb_build_object('status', 'forbidden_self', 'email', lower(p_email));
  end if;

  update public.users
     set revoked_at = now(), revoked_by = auth.uid()
   where lower(email) = lower(p_email) and revoked_at is null
   returning id into rid;
  if rid is null then
    if exists (select 1 from public.users u where lower(u.email) = lower(p_email)) then
      return jsonb_build_object('status', 'already_revoked', 'email', lower(p_email));
    end if;
    return jsonb_build_object('status', 'not_found', 'email', lower(p_email));
  end if;

  return jsonb_build_object('status', 'ok', 'email', lower(p_email));
end;
$$;

-- リボークの解除: can_purge の利用者のみ。revoked_at を戻す(スナップショットはそのまま)。
create function public.restore_user(p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rid uuid;
begin
  if auth.role() <> 'authenticated' then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if not exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid() and u.can_purge and u.revoked_at is null
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  update public.users
     set revoked_at = null, revoked_by = null
   where lower(email) = lower(p_email) and revoked_at is not null
   returning id into rid;
  if rid is null then
    return jsonb_build_object('status', 'not_revoked', 'email', lower(p_email));
  end if;

  return jsonb_build_object('status', 'ok', 'email', lower(p_email));
end;
$$;

revoke execute on function public.list_users() from anon, public;
grant execute on function public.list_users() to authenticated;
revoke execute on function public.revoke_user(text) from anon, public;
grant execute on function public.revoke_user(text) to authenticated;
revoke execute on function public.restore_user(text) from anon, public;
grant execute on function public.restore_user(text) to authenticated;
