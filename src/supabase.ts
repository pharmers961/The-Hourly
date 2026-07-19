import { createClient } from '@supabase/supabase-js';
import config from '../supabase-config.json';

export const isSupabaseConfigured = Boolean(config.url && config.anonKey);
export const supabaseUrl = config.url || 'https://placeholder.supabase.co';

export const supabase = createClient(supabaseUrl, config.anonKey || 'placeholder');
