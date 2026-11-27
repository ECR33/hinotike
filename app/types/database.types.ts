/**
 * 最小の手書き Database 型(supabase gen types が不要な環境でもモジュールが型解決できるように)。
 * supabase/migrations の users / user_email_domains / sync_sources(0007) /
 * scan_modes・scan_events(0006 + 0008 の source_id)と一致させること。
 * users の avatar_url / provider / provider_subject は 0010(登録時の身分スナップショット)。
 * 旧 `items` と `sync_settings`(0001 / 0003〜0005)は 0009 で drop したため載せない。
 * 本番で正確な型が必要なら `supabase gen types typescript --local --schema public` で置き換える。
 */
export type Database = {
  Public: {
    Tables: {
      users: {
        Row: {
          id: string
          auth_user_id: string | null
          email: string
          name: string | null
          created_at: string
          linked_at: string | null
          email_verified_at: string | null
          avatar_url: string | null
          provider: string | null
          provider_subject: string | null
          /** 端末データの消去指示を出せるか(0011)。最初期ユーザの事前登録 insert で true を入れる */
          can_purge: boolean
        }
        Insert: {
          id?: string
          auth_user_id?: string | null
          email: string
          name?: string | null
          created_at?: string
          linked_at?: string | null
          email_verified_at?: string | null
          avatar_url?: string | null
          provider?: string | null
          provider_subject?: string | null
          can_purge?: boolean
        }
        Update: {
          id?: string
          auth_user_id?: string | null
          email?: string
          name?: string | null
          created_at?: string
          linked_at?: string | null
          email_verified_at?: string | null
          avatar_url?: string | null
          provider?: string | null
          provider_subject?: string | null
          can_purge?: boolean
        }
        Relationships: []
      }
      user_email_domains: {
        Row: { domain: string }
        Insert: { domain: string }
        Update: { domain?: string }
        Relationships: []
      }
      /**
       * データセット(取り込み定義)。1行 = 1スプレッドシート(migrations/0007)。
       * データ本体は Supabase に置かない(GET /api/import がシートを読み、画面が IndexedDB に保存する)。
       */
      sync_sources: {
        Row: {
          id: number
          name: string
          spreadsheet_id: string
          worksheet: string | null
          code_column: string
          include_columns: string[]
          exclude_columns: string[]
          filter_column: string | null
          filter_values: string[]
          rename: Record<string, string>
          enabled: boolean
          created_at: string
          updated_at: string
          updated_by: string | null
          /** 消去指示の単調カウンタ(0011)。取り込みメタの epoch より大きければ端末はミラーを捨てる */
          purge_epoch: number
        }
        Insert: {
          id?: number
          name: string
          spreadsheet_id?: string
          worksheet?: string | null
          code_column?: string
          include_columns?: string[]
          exclude_columns?: string[]
          filter_column?: string | null
          filter_values?: string[]
          rename?: Record<string, string>
          enabled?: boolean
          created_at?: string
          updated_at?: string
          updated_by?: string | null
          purge_epoch?: number
        }
        Update: {
          id?: number
          name?: string
          spreadsheet_id?: string
          worksheet?: string | null
          code_column?: string
          include_columns?: string[]
          exclude_columns?: string[]
          filter_column?: string | null
          filter_values?: string[]
          rename?: Record<string, string>
          enabled?: boolean
          created_at?: string
          updated_at?: string
          updated_by?: string | null
          purge_epoch?: number
        }
        Relationships: []
      }
      /** スキャンの記録モード(migrations/0006 + 0008)。actions は [{ column, column_at, literal, payload_key, payload_at_key }] の jsonb */
      scan_modes: {
        Row: {
          id: number
          /** 記録先データセット(sync_sources.id)。on delete restrict。null = 未紐づけ(API は 400) */
          source_id: number | null
          name: string
          actions: unknown
          dedupe: string
          confirm_before_record: boolean
          require_found: boolean
          enabled: boolean
          created_at: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: number
          source_id?: number | null
          name: string
          actions?: unknown
          dedupe?: string
          confirm_before_record?: boolean
          require_found?: boolean
          enabled?: boolean
          created_at?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: number
          source_id?: number | null
          name?: string
          actions?: unknown
          dedupe?: string
          confirm_before_record?: boolean
          require_found?: boolean
          enabled?: boolean
          created_at?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      /** スキャンの証跡(不変の履歴。seq は挿入順の連番 = 新しい順の分页カーソル。update/delete ポリシーなし) */
      scan_events: {
        Row: {
          seq: number
          id: string
          code: string
          mode_id: number | null
          mode_name: string
          /** 記録先データセットの denormalize 監査値(migrations/0008。モード削除後も「どのシートか」が読める) */
          source_id: number | null
          name: string | null
          actor_email: string | null
          status: string
          written: Record<string, string>
          sheet_range: string | null
          at: string
        }
        Insert: {
          code: string
          mode_id?: number | null
          mode_name: string
          source_id?: number | null
          name?: string | null
          actor_email?: string | null
          status: string
          written?: Record<string, string>
          sheet_range?: string | null
          at?: string
        }
        Update: {
          code?: string
          mode_id?: number | null
          mode_name?: string
          source_id?: number | null
          name?: string | null
          actor_email?: string | null
          status?: string
          written?: Record<string, string>
          sheet_range?: string | null
          at?: string
        }
        Relationships: []
      }
      /** 消去指示の監査(0011。select/insert のみ = 証跡は不変。insert は RPC のみ) */
      purge_events: {
        Row: {
          seq: number
          id: string
          source_id: number | null
          actor_email: string | null
          issued_by: string | null
          at: string
        }
        Insert: {
          source_id?: number | null
          actor_email?: string | null
          issued_by?: string | null
          at?: string
        }
        Update: {
          source_id?: number | null
          actor_email?: string | null
          issued_by?: string | null
          at?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      is_registered_user: { Args: Record<string, never>; Returns: boolean }
      link_my_user: { Args: Record<string, never>; Returns: void }
      user_email_allowed: { Args: { email_addr: string }; Returns: boolean }
      /** 利用者登録の要求(migrations/0002)。jsonb を返す(status / nonce / expires_at など) */
      create_registration_request: { Args: Record<string, never>; Returns: Record<string, unknown> }
      preview_registration_request: { Args: { req_nonce: string }; Returns: Record<string, unknown> }
      approve_registration_request: { Args: { req_nonce: string }; Returns: Record<string, unknown> }
      /** 端末データの消去指示(migrations/0011)。can_purge ガード。jsonb を返す(status / purge_epoch) */
      issue_dataset_purge: { Args: { p_source_id: number }; Returns: Record<string, unknown> }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
