# 端末ミラーの中央消去指示(purge directive)設計案

**ステータス: 実装済み(0011)**。権限は A(`users.can_purge`)、対象単位はデータセット(source)で確定した。

目的: QRスキャンのイベントが終了したあと、端末にコピーした items データ(氏名・備考を含むミラー)を
**利用者の自発的な削除に任せず**、中央の指示で端末側が自動的に捨てる。漏洩リスク(端末を置き忘れる・
利用者が削除しない・端末を他人に渡す)を減らす。

前提(現行の仕組み):
- 端末ミラー = IndexedDB(`app/utils/offlineStore.ts`)。`OfflineMeta`(uid / sourceId / snapshotAt / config)が
  「今作業しているデータセット」を示す。削除は `purgeDeviceData()`(ログアウトと管理欄のボタンが呼ぶ)。
- 「中央」に相当する共有状態は Supabase DB しか無い(コントロールパネルなし、利用者に上下なし)。
- 証跡 `scan_events`(氏名 denormalize)はサーバー側に残り、端末ミラーの消去とは独立(監査は消えない)。

## 1. 「中央」= Supabase DB(+ RPC の権限)

コントロールパネルの代わりに、**DB が唯一の中央**という形にする。
- 指示の保管: データセット(sync_sources)に `purge_epoch integer default 0` を追加。
  「イベント終了」の指示 = そのデータセットの epoch を +1 する。
- 端末は「取り込み時の epoch」をメタに持つ。現在 epoch > メタの epoch なら **そのミラーを捨てる**。
  epoch は単調増加なので replay 安全・idempotent(同じ指示を二度読んでも同じ結果)。
- 監査: `purge_events`(scan_events と同じ「select/insert のみ = 不変」方針):
  誰が(source_id, actor_email, issued_by uid, at)指示を出したか残す。

## 2. 指示を出せる権限(提案の核心)

選択肢:

- **A. `users.can_purge boolean`(推奨)**
  最初期ユーザは必ず「管理者による email 事前登録」経路で作られるので、その insert で
  `can_purge=true` を入れられる(bootstrap が自然)。以後の付与/剥奪はダッシュボードの SQL で行う。
  明示的なフラグなので「スーパーユーザの継承・剥奪」が運用可能。RPC のガードは
  `exists (select 1 from users u where u.auth_user_id = auth.uid() and u.can_purge)`。
- B. 「最初期ユーザ = 暗黙のスーパーユーザ」(created_at 最早の行)
  カラム不要だが暗黙の魔法。pre-register だけの行(未紐付け)が最早になり得る、剥奪・継承ができない、
  判定が RPC に散る。単独では非推奨(A のデフォルト値として「最初期ユーザに true を入れる」運用は採用)。
- C. 登録済みユーザなら誰でも指示を出せる
  完全なフラット運用。ただし誤操作・悪意で全端末のミラーを一括消せる(DoS)。
  承認者二人以上requiredのような多者承認は今回の規模では過剰。

推奨: **A**。権限の付与自体は「管理者=Secret key/ダッシュボード」の現行運用と同じ場所でやる
(スーパーユーザが他人に can_purge を配れると権限のエスカレーション面が増える)。

## 3. 指示の発動(「イベント終了」のトリガー)

DB に「イベント」の概念は無い(scan_events は1読み取り=1行の証跡)。したがって:
- **手動トリガー(推奨・最小)**: can_purge ユーザが画面(管理 dropdown に「端末データの消去」ページ)で
  データセットを選んで「イベント終了 → 端末コピーを消去」を押す → RPC `issue_dataset_purge(source_id)`。
- 将来オプション: データセットに TTL(例: `expires_at`)を持ち、時刻超過で端末が自動消去
  (「イベント終了」が時刻で決まる運用なら自動になる。下の4の离线問題の緩和にもなる)。

## 4. 端末側はどうそれを読むか

端末は「通信したとき」に中央の状態を見る。強制 remote delete はブラウザの IndexedDB にはできないので、
**端末が次回オンラインになったときに必ずapplyされる**形にする。

- 読み取り点(既存の通信に相乗りするだけ、新しい polling を増やさない):
  1. `/api/import` の応答に `purgeEpoch` を載せ、取り込み時に `OfflineMeta.purgeEpoch` へ書く。
  2. `/api/me` の応答に `purgeEpochs: Record<number, number>`(全 data set の epoch)を追加。
     端末は `/scan` の mount / ローカル作業が有効な間の既存 polling / flush の応答で比較する。
     flush 応答にも purge フラグを載せれば、連続スキャン中の「イベント終了」も即反映される。
  3. 判定: `meta.purgeEpoch < epochs[meta.sourceId]` → **そのデータセットだけ**捨てる:
     items から `sourceId|code` の行を delete、snapshot meta を消す、その source の queue entry は
     氏名だけ除去(code/modeId/at は記録確定に残す)、active-source 選択を消す、SW ページキャッシュを消す。
     (`offlineStore.ts` に `offlinePurgeSource(sourceId)` を追加。既存の全体版 `purgeDeviceData()` は温存)
- ログアウトは従来どおり全体 purge(指示を待たない)。

**残るリスク(正直な注記)**: 永久にオフラインの端末・改変されたクライアントは消去できません。
緩和は (a) ミラーは uid 紐付けで別ユーザに読ませない(既存)、(b) ログアウト purge(既存)、
(c) TTL 自動消去(将来オプション)、(d) 強化案: ミラーをサーバー発行の鍵で暗号化し指示で鍵を失効
(複雑なので今回は対象外)。

## 5. 実装の形(マイグレーション 0011 の予想)

```sql
alter table public.users add column if not exists can_purge boolean not null default false;
alter table public.sync_sources add column if not exists purge_epoch integer not null default 0;

create table public.purge_events(
  seq bigserial unique,
  id uuid primary key default gen_random_uuid(),
  source_id integer references public.sync_sources(id) on delete set null,
  actor_email text,
  issued_by uuid references auth.users (id) on delete set null,
  at timestamptz not null default now()
);
-- RLS: select/insert のみ(scan_events と同じ不変方針)。epoch 読み取りは sync_sources の既存 select ポリシーを通る。

create function public.issue_dataset_purge(p_source_id integer)
returns jsonb language plpgsql security definer set search_path = public as $$
-- auth.uid() の users 行の can_purge を見る。sync_sources.purge_epoch += 1、purge_events に監査行。
$$;
```

アプリ側:
- `/api/me` に `canPurge`(画面の項目出し分け用)と `purgeEpochs`。
- `GET /api/purge-state`(任意)または flush/import 応答に epoch を相乗り。
- 管理画面ページ `/purge`(can_purge ユーザのみ、API は guard で拒否): データセット一覧 + 確認ダイアログ。
- `offlineStore.offlinePurgeSource(sourceId)` + 判定/適用の composable。
- 統合テスト: issue → epoch 比較 → per-source purge(氏名除去・meta 消去・他 source 温存)。

## 6. 決めておきたい運用仕様

1. 消去の対象単位: **データセット(source)**。(user 単位の消去は「リボーク時の users 行削除」で
   cascade で auth が消える既存経路と混同しやすい。source 単位を推奨)
2. 「ためた記録」の待機(queue)は code / modeId / at を残す(既存方針)。氏名だけ除去。
   イベント終了で記録ごと捨てたいなら「全部捨てる」の既存操作か、消去指示に `dropQueue=true` を足す。
3. 消去指示は取り込み以降の全端末に効く。指示後の再取り込みは epoch が揃うので問題ない
   (イベント終了後に同じシートを再取り込み = 新しいイベント)。
4. 指示を出せる人数は最初は1人(最初期ユーザ)。増やしたいときダッシュボードで can_purge=true。
