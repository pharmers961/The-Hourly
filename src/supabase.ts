import { createClient } from '@supabase/supabase-js';
import config from '../supabase-config.json';

export const isSupabaseConfigured = Boolean(config.url && config.anonKey);

export const supabase = createClient(
  config.url || 'https://placeholder.supabase.co',
  config.anonKey || 'placeholder'
);
