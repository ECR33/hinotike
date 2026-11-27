-- Hinotike: 登録時の身分スナップショット(0010)
--
-- 目的: 管理者があとでユーザをリボーク(削除)するときに「誰か」を素見分けできる情報を、
-- 登録の瞬間に auth.users の OAuth メタデータから吸って users 行に保管する。
-- 追加カラム(users):
-- - avatar_url: Google プロフィール画像の URL(承認画面とダッシュボードで視覚的に identifiable)
-- - provider: 認証プロバイダ(Google OAuth なら 'google'。password/email ログインなら 'email')
-- - provider_subject: プロバイダ側の account id(Google の sub は email 変更でも安定なので、
--   リボーク後に Google Admin / Workspace のユーザーと照合できる)
--
-- 紐付けの条件自体は変えない(検証済み email + ドメイン許可は 0001/0002 のまま)。
-- スナップショットは coalesce で埋めるため、管理者が事前登録で入れておいた name は上書きしない。
-- 既存行の email 変更・削除は行わない(スナップショットは「登録時に分かった事実」の記録)。
--
-- 実行順: alter table → create or replace function(grants は create or replace で保持される)。
-- preview_registration_request の ok 応答に picture を追加(register.vue の確認表示用)。

alter table public.users
  add column if not exists avatar_url text,
  add column if not exists provider text,
  add column if not exists provider_subject text;

-- 初回ログインの自動紐付け: 紐付けと同時に身分スナップショットも埋める。
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
     and lower(email) = my_email;
end;
$$;

-- 承認前確認(preview): 許可済みのユーザのみ。消費しない。
-- ok のとき依頼者の email / name / picture(プロフィール画像)を返す(承認前に「誰か」を視覚確認できる)。
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
  if exists (select 1 from public.users u where u.auth_user_id = r.requested_uid) then
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

-- 許可(consume + 紐付け): 許可済みのユーザのみ。preview と同じ条件を再検証してから登録する。
-- 紐付け/作成のどちらでも身分スナップショット(avatar / provider / sub)を coalesce で埋める。
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

  if exists (select 1 from public.users u where u.auth_user_id = r.requested_uid) then
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
  if exists (select 1 from public.users u where lower(u.email) = au.email and u.auth_user_id is not null) then
    return jsonb_build_object('status', 'email_taken', 'email', au.email);
  end if;

  -- 事前登録行があれば link_my_user() と同じ条件で紐付け、無ければ新規行を作成する。
  update public.users
     set auth_user_id = r.requested_uid,
         linked_at = now(),
         email_verified_at = now(),
         name = coalesce(name, au.name),
         avatar_url = coalesce(avatar_url, au.picture),
         provider = coalesce(provider, au.provider),
         provider_subject = coalesce(provider_subject, au.subject)
   where lower(email) = au.email
     and auth_user_id is null;
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
