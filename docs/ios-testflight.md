# Shipping The Hourly to TestFlight

The Hourly is a web app wrapped in a native iOS shell with
[Capacitor](https://capacitorjs.com). The `ios/` directory contains a real
Xcode project; the web bundle (`dist/`) is copied into it by `cap sync`.
This guide takes you from this repo to a build your testers can install
from TestFlight.

## What you need

- A Mac with [Xcode](https://apps.apple.com/us/app/xcode/id497799835) 15+
  (building/uploading iOS apps requires macOS — there is no way around this).
- [CocoaPods](https://cocoapods.org): `sudo gem install cocoapods`
- Node/Bun to build the web bundle.
- An [Apple Developer Program](https://developer.apple.com/programs/) account
  ($99/year). TestFlight distribution is not possible with a free account.

## One-time setup

### 1. Supabase redirect URLs

The native app signs in via a `thehourly://` deep link instead of a web
redirect. In the [Supabase dashboard](https://supabase.com/dashboard) →
your project → **Authentication → URL Configuration → Redirect URLs**, add:

```
thehourly://auth-callback
```

Without this, magic links and Google sign-in from the iOS app will bounce
back to the website instead of the app.

### 2. App Store Connect record

1. Sign in to [App Store Connect](https://appstoreconnect.apple.com).
2. **Apps → “+” → New App**: platform iOS, name "The Hourly", bundle ID
   `com.thehourly.app` (register the bundle ID first at
   [developer.apple.com → Identifiers](https://developer.apple.com/account/resources/identifiers/list)
   if it isn't offered in the dropdown).
3. If `com.thehourly.app` is taken, pick your own (e.g.
   `com.<yourname>.thehourly`) and change `appId` in `capacitor.config.ts`
   to match, then re-run `bun run ios:sync`.

### 3. Signing in Xcode

1. Clone the repo on the Mac, then:

   ```sh
   bun install
   bun run ios:sync        # builds the web bundle and copies it into ios/
   cd ios/App && pod install && cd ../..
   bun run ios:open        # opens ios/App in Xcode
   ```

2. In Xcode select the **App** target → **Signing & Capabilities**:
   - Check **Automatically manage signing**.
   - Pick your **Team** (your Apple Developer account).
   - Confirm the bundle identifier matches the App Store Connect record.

### 4. App icon

Xcode requires a full app-icon set. The repo ships the PWA icons
(`public/icon-512.png` etc.); in Xcode open
`App/Assets.xcassets/AppIcon` and drop a 1024×1024 PNG on the
"App Store" slot (Xcode 15+ generates the rest automatically).

## Every release

```sh
bun run ios:sync          # rebuild web bundle + copy into the iOS project
bun run ios:open
```

Then in Xcode:

1. Bump the version/build number: **App target → General → Identity**
   (each TestFlight upload needs a higher build number).
2. Select the destination **Any iOS Device (arm64)**.
3. **Product → Archive**.
4. When the Organizer window opens: **Distribute App → TestFlight & App
   Store → Upload** and accept the defaults.
5. In App Store Connect → your app → **TestFlight**, wait for the build to
   finish processing (~5–15 min), answer the export-compliance question
   (the app uses only standard HTTPS encryption → "None of the algorithms
   mentioned above"), then add testers:
   - **Internal testers** (your team, up to 100) get the build immediately.
   - **External testers** (up to 10,000, invited by email or public link)
     require a one-time Beta App Review, usually approved within a day.

Testers install the TestFlight app from the App Store and accept the
invite; new uploads reach them automatically.

## How the native wrapper works

- `capacitor.config.ts` — app ID/name; `dist/` is the web bundle that gets
  embedded.
- `ios/` — the generated Xcode project (committed; `Pods/`, the copied
  `public/` bundle, and other build products are gitignored).
- `src/native.ts` — all platform-specific behavior:
  - Auth redirects use `thehourly://auth-callback` (deep link) natively and
    `window.location.origin` on the web.
  - Google OAuth opens in `SFSafariViewController` (Google blocks embedded
    webviews) and deep-links back.
  - Group invite links always use the deployed web URL
    (`https://the-hourly.vercel.app`), never the webview's internal origin.
- Camera capture, photo library, and location prompts use the usage strings
  declared in `ios/App/App/Info.plist`.

## Known limitations (fine for a first TestFlight build)

- **Push notifications**: the web-push service worker doesn't run inside
  the iOS webview, so background push is off in the native app. In-app
  nudges/notifications (delivered over Supabase realtime while the app is
  open) still work. Real background push needs APNs via
  `@capacitor/push-notifications` plus a server-side sender — a good
  follow-up.
- **Invite links open the website**, not the app. Making
  `https://the-hourly.vercel.app/join/...` open the app directly requires
  Universal Links (an `apple-app-site-association` file on the domain +
  Associated Domains entitlement). The deep-link handler in `src/native.ts`
  already handles `/join/` URLs for when that's added.
- The service worker/offline cache is inert in the webview; the app's own
  offline capture queue (IndexedDB) still works.
