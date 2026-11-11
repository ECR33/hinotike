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
