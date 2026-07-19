import { createClient } from '@supabase/supabase-js';
import config from '../supabase-config.json';

export const isSupabaseConfigured = Boolean(config.url && config.anonKey);
export const supabaseUrl = config.url || 'https://placeholder.supabase.co';

export const supabase = createClient(supabaseUrl, config.anonKey || 'placeholder');

// Builds a one-off elevated client for admin-only, one-time operations
// (the Firebase import). The service role key bypasses row-level security
// entirely, so it is only ever typed in by the person running the import,
// held in memory for that single call, and never persisted, logged, or
// bundled into the app.
export function createAdminClient(serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
