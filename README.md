<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/0ef0f956-9e92-4b96-aab6-0adefe2a1acc

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## App Version and Android Package

`package.json` is the single source of truth for the app version and Android package mode:

- Update `version` in `package.json` to release a new app version. The app UI, web build, and GitHub Actions workflow read this value directly.
- Set `buildAab` to `false` for an APK build or `true` for an AAB build. GitHub Actions builds only the selected package type.
- Push the `package.json` change to `main` to start the release workflow. A version must be higher than the latest existing `v*` Git tag; duplicate or older versions are rejected before Android build steps start.
- APK builds are published as a GitHub Release and update `version.json`. AAB builds are uploaded as a GitHub Actions artifact for 30 days; access follows the repository's Actions permissions.
- Local `npm run build:apk` and `npm run build:aab` commands verify that the selected command matches `buildAab` before starting.
- Android `versionCode` in GitHub Actions is generated from the commit count; `versionName` comes from `package.json`.
