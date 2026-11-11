import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const ROOT = path.resolve(import.meta.dirname, '..')
function load(f) {
  const out = {}
  for (const line of fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1)
  }
  return out
}

for (const f of ['.env', '.env.development']) {
  const e = load(f)
  const url = e.SUPABASE_URL ?? e.NUXT_PUBLIC_SUPABASE_URL
  const key = e.SUPABASE_SECRET_KEY ?? e.NUXT_SUPABASE_SECRET_KEY
  const table = e.SUPABASE_TABLE_NAME ?? 'items'
  const sb = createClient(url, key)
  const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true })
  console.log(`${f} -> ${url} / ${table}: ${error ? 'ERROR: ' + error.message : count + ' 件'}`)
  if (!error) {
    const { data } = await sb.from(table).select('code,payload').order('code', { ascending: true }).limit(2)
    for (const row of data ?? []) {
      console.log(`  code=${row.code} payload=${JSON.stringify(row.payload).slice(0, 220)}`)
    }
  }
  const { count: users } = await sb.from('users').select('*', { count: 'exact', head: true })
  console.log(`  users: ${users} 件`)
}
