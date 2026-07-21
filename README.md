<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/530ce651-c22d-48f3-af78-3cb6c4e2b873

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## iOS app (TestFlight)

The app ships to iOS as a Capacitor-wrapped native app — the Xcode project
lives in `ios/`. See [docs/ios-testflight.md](docs/ios-testflight.md) for
the full build-and-upload guide.
