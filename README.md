# Net Sniper — native app build

This is a real React Native app (not a website). It uses `react-native-vision-camera`,
which talks to the phone's camera hardware directly, so it can reach the actual
native frame-rate modes (120fps/240fps on supported phones) that a browser can't
reliably get to.

**What's included:** camera view at max native fps, net/target setup, manual
shot logging (on-target / missed), timer, and stats saved on-device.
**Not included yet:** automatic shot detection (the motion-sensing "auto-detect"
from the web version) — that needs a native frame-processor plugin, which is a
separate follow-up build. This version uses the two manual buttons instead.

You do **not** need a Mac or Xcode for either platform — builds happen in
Expo's cloud (EAS Build). You do need a free Expo account (create one at
expo.dev or via the CLI below).

## 1. Install tools (one time)

On any computer (Windows/Mac/Linux):
```
npm install -g eas-cli
```

## 2. Get the project running

```
cd net-sniper-app          # this folder
npm install
```

## 3. Log in to Expo

```
eas login
```
(Signs up / logs in — free.)

## 4. Build

### Android — installable APK, completely free
```
eas build --platform android --profile preview
```
- Takes a few minutes in Expo's cloud. When it finishes, EAS gives you a
  download link (and a QR code) for a `.apk` file.
- On your Android phone: open that link, download the APK, tap it to install.
  You'll need to allow "install unknown apps" for your browser the first time
  Android asks — that's normal for anything installed outside the Play Store.

### iOS — requires an Apple Developer account ($99/year)
This is an Apple requirement for installing outside the App Store, regardless
of what computer or tools you use.
1. Enroll at developer.apple.com ($99/yr).
2. Run:
```
eas build --platform ios --profile preview
```
3. EAS will walk you through connecting your Apple account (all in the
   terminal — no Xcode needed) and generating the certificates for you.
4. Once built, install it on your iPhone via **TestFlight** (Apple's official
   way to install non-App-Store builds) — EAS can submit it there for you with
   `eas submit --platform ios`.

## 5. (Optional) Quick live-preview while developing

If you just want to see it running on your phone instantly while iterating,
without waiting for a full cloud build:
```
npx expo start --dev-client
```
Note: because this app uses a native camera library, the plain "Expo Go" app
from the store won't run it — you'd need a "development build" (`eas build
--profile development`) installed once, after which `expo start` reloads
instantly like Expo Go does.

## Files
- `App.js` — the whole app
- `app.json` — app name, icon, camera permission text, bundle IDs
- `eas.json` — build profiles (`preview` = installable APK for Android)
- `assets/icon.png` — app icon
