/**
 * 最小の手書き Database 型(supabase gen types が不要な環境でもモジュールが型解決できるように)。
 * schema.sql の users / items / user_email_domains と一致させること。
 * 本番で正確な型が必要なら `npx supabase gen types typescript` で置き換える。
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
        }
        Insert: {
          id?: string
          auth_user_id?: string | null
          email: string
          name?: string | null
          created_at?: string
          linked_at?: string | null
          email_verified_at?: string | null
        }
        Update: {
          id?: string
          auth_user_id?: string | null
          email?: string
          name?: string | null
          created_at?: string
          linked_at?: string | null
          email_verified_at?: string | null
        }
        Relationships: []
      }
      items: {
        Row: {
          code: string
          payload: Record<string, unknown>
          imported_at: string
        }
        Insert: {
          code: string
          payload?: Record<string, unknown>
          imported_at?: string
        }
        Update: {
          code?: string
          payload?: Record<string, unknown>
          imported_at?: string
        }
        Relationships: []
      }
      user_email_domains: {
        Row: { domain: string }
        Insert: { domain: string }
        Update: { domain?: string }
        Relationships: []
      }
      /** スキャンの記録モード(migrations/0006)。actions は [{ column, column_at, literal, payload_key, payload_at_key }] の jsonb */
      scan_modes: {
        Row: {
          id: number
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
          name?: string | null
          actor_email?: string | null
          status?: string
          written?: Record<string, string>
          sheet_range?: string | null
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
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
