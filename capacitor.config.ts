import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.thehourly.app',
  appName: 'The Hourly',
  webDir: 'dist',
  ios: {
    // Photos and Supabase auth cookies should survive app restarts
    limitsNavigationsToAppBoundDomains: false,
    contentInset: 'automatic',
  },
};

export default config;
