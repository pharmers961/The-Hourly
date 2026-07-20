import { createClient } from '@supabase/supabase-js';
import config from '../supabase-config.json';

export const isSupabaseConfigured = Boolean(config.url && config.anonKey);
export const supabaseUrl = config.url || 'https://placeholder.supabase.co';

export const supabase = createClient(supabaseUrl, config.anonKey || 'placeholder');

// Public half of the Web Push VAPID key pair (the private half lives only in
// the send-push Edge Function's secrets). Safe to ship in the bundle.
export const vapidPublicKey: string = (config as { vapidPublicKey?: string }).vapidPublicKey || '';
