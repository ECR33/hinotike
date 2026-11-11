-- Hinotike: QRによる利用者許可(許可リスト登録依頼フロー)
-- 提案フロー:
--   1. 最初の利用者: 管理者が users に email 事前登録(0001 の運用のまま。ダッシュボードで可)
--   2. 次の利用者: アプリで Google ログイン → 未紐付けなら /unauthorized の許可依頼QRを表示
--   3. 許可済みの利用者が /register(利用者登録画面)でそのQRを読む → preview(依頼者のemail表示)→ 確認 → 許可
--   4. 新しい利用者は polling 後 /scan へ自動遷移
--
-- 設計の安全面(生の uid / email をQRに載せない):
-- - QRの中身は DB に作成された一回用のランダム nonce のみ(`hinotike-registration:<uuid>`)。
--   nonce は依頼者のセッションでしか作れない(create_registration_request は auth.uid() の行を作る)ため、
--   他人のQRを撮影して持ち歩いても有効期限切れ・消費済みで使えない(replay防止)。
-- - 許可は「preview → 確認 → approve」の二段階。スキャンした人は承認前に依頼者の email を確認する
--   (人間が誰を許可したか分かる = 承認の責任が残る)。
-- - approve は link_my_user() と同じ条件(検証済み email + ドメイン許可)を適用する。
--   QR経由がドメイン制限のバイパスにならない。
-- - 監査: consumed_at / approved_by を記録。依頼者は1人1行のみ(再生成で旧QRは無効化)。

-- ── 依頼テーブル ──
create table public.registration_requests (
  nonce uuid primary key default gen_random_uuid(),
  requested_uid uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  consumed_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null
);

alter table public.registration_requests enable row level security;

-- 依頼者自分は自分の依頼行を閲覧可(状態確認用)。作成・消費・失効処理は definer 関数のみが行う。
create policy "registration_requests_owner_select"
  on public.registration_requests for select
  using (requested_uid = auth.uid());

-- ── 関数 ──

-- 依頼作成: 未登録の認証ユーザのみ。同じユーザの依頼は1本だけ(再生成で古いQRは失効する)。
create function public.create_registration_request()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  my_uid uuid;
  req_nonce uuid;
  exp timestamptz;
begin
  if auth.role() <> 'authenticated' then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if public.is_registered_user() then
    return jsonb_build_object('status', 'already_registered');
  end if;

  my_uid := auth.uid();
  delete from public.registration_requests where requested_uid = my_uid;
  insert into public.registration_requests (requested_uid)
    values (my_uid)
    returning nonce, expires_at into req_nonce, exp;

  return jsonb_build_object('status', 'ok', 'nonce', req_nonce, 'expires_at', exp);
end;
$$;

-- 承認前確認(preview): 許可済みのユーザのみ。消費しない。依頼者の email を返す。
create function public.preview_registration_request(req_nonce uuid)
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
         coalesce(raw_user_meta_data ->> 'name', '') as name
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

  return jsonb_build_object('status', 'ok', 'email', au.email, 'name', au.name);
end;
$$;

-- 許可(consume + 紐付け): 許可済みのユーザのみ。preview と同じ条件を再検証してから登録する。
-- users の email unique 制約に衝突する(email が別のauthユーザに既に紐済み)場合は email_taken。
create function public.approve_registration_request(req_nonce uuid)
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
         coalesce(raw_user_meta_data ->> 'name', null) as name
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
         email_verified_at = now()
   where lower(email) = au.email
     and auth_user_id is null;
  GET DIAGNOSTICS linked_rows = ROW_COUNT;

  if linked_rows = 0 then
    insert into public.users (email, name, auth_user_id, linked_at, email_verified_at)
    values (au.email, au.name, r.requested_uid, now(), now());
  end if;

  update public.registration_requests
     set consumed_at = now(), approved_by = auth.uid()
   where nonce = req_nonce;

  return jsonb_build_object('status', 'ok', 'email', au.email);
end;
$$;

-- ── grant(0001 と同じ方針: definer は authenticated からだけ呼べる) ──
revoke execute on function public.create_registration_request() from anon, public;
grant execute on function public.create_registration_request() to authenticated;
revoke execute on function public.preview_registration_request(uuid) from anon, public;
grant execute on function public.preview_registration_request(uuid) to authenticated;
revoke execute on function public.approve_registration_request(uuid) from anon, public;
grant execute on function public.approve_registration_request(uuid) to authenticated;
