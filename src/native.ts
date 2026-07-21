// Native (Capacitor/iOS) integration. Everything here is a no-op on the web,
// so the same bundle serves both the browser PWA and the wrapped iOS app.
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { supabase } from './supabase';

export const isNative = Capacitor.isNativePlatform();

// Canonical deployed web app. Native builds use this for anything that must be
// a real, shareable https URL (invite links), since the webview's own origin
// is capacitor://localhost.
export const WEB_APP_URL = 'https://the-hourly.vercel.app';

// Custom scheme registered in ios/App/App/Info.plist (CFBundleURLTypes). Both
// this and WEB_APP_URL must be whitelisted under Supabase Auth > URL
// Configuration > Redirect URLs for sign-in to complete on device.
export const NATIVE_AUTH_CALLBACK = 'thehourly://auth-callback';

// Origin for user-facing shareable links (group invites).
export function shareOrigin(): string {
  return isNative ? WEB_APP_URL : window.location.origin;
}

// Where Supabase should send the user after a magic link / OAuth round trip.
export function authRedirectUrl(): string {
  return isNative ? NATIVE_AUTH_CALLBACK : window.location.origin;
}

// OAuth consent must run in the system browser (SFSafariViewController):
// Google rejects sign-in from embedded webviews, and the system browser is
// what makes the thehourly:// redirect reach the app.
export async function openAuthUrl(url: string): Promise<void> {
  await Browser.open({ url, windowName: '_self' });
}

// Wire up thehourly:// deep links. The auth callback arrives here with
// tokens in the URL fragment (implicit flow) or a ?code= (PKCE); either way
// the session is installed and supabase-js fires SIGNED_IN, which the app
// already listens for.
export function initNativeDeepLinks(): void {
  if (!isNative) return;
  void CapacitorApp.addListener('appUrlOpen', async ({ url }) => {
    try {
      const parsed = new URL(url);
      const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');
      const pkceCode = parsed.searchParams.get('code');

      if (accessToken && refreshToken) {
        await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        await Browser.close().catch(() => undefined);
        return;
      }
      if (pkceCode) {
        await supabase.auth.exchangeCodeForSession(pkceCode);
        await Browser.close().catch(() => undefined);
        return;
      }

      // Group invites: thehourly://join?code=<invite> (and, if universal
      // links are set up later, https://.../join/<invite> lands here too).
      const joinCode =
        parsed.searchParams.get('join') ||
        (/(^|\/)join(\/|$)/.test(`${parsed.host}${parsed.pathname}`)
          ? parsed.searchParams.get('code') || parsed.pathname.match(/\/join\/([^/?#]+)/)?.[1] || null
          : null);
      if (joinCode) {
        // Same stash the web flow uses (App.tsx picks it up post-auth).
        localStorage.setItem('pendingJoinCode', joinCode);
        window.location.reload();
      }
    } catch (err) {
      console.warn('Failed to handle deep link:', err);
    }
  });
}
