# RideSquad

A sporty, mobile-first group-riding companion — built as an installable web app (PWA-style) so it runs on any phone's browser with no app-store install.

## Features (mapped to spec)

1. **Splash screen** — animated bike mark, brand intro, auto-advances into onboarding/home.
2. **Home dashboard** — live circular speedometer (GPS-derived km/h), trip timer, real-time acceleration (m/s²), trip distance, max speed, average speed, ride start/stop control, screen Wake Lock while riding.
3. **Day / Night / High-Contrast display modes** — a Settings picker switches the entire UI's color scheme instantly: a light, high-contrast mode for direct sunlight (dark UI actually loses contrast and washes out in bright glare), the original dark mode for riding after dark, and a pure black/yellow high-contrast mode for extreme glare or low-vision riding. Persists across sessions.
4. **Glove-friendly touch targets** — every interactive control (nav bar, SOS, mic toggle, buttons, chips) is sized for tapping with riding gloves on, not fine fingertip precision.
5. **Squad connect** — create or join a squad with a short code; live map shows every connected rider's position, name, and color-coded marker, updating every ~2s.
6. **Group features** — member list with live per-rider speed and mic-talking indicator, in-ride text chat, and one-tap status check-ins (✅ I'm OK, ⛽ Fuel Break, 🍔 Food Break) that post straight to the squad chat so nobody has to type while riding.
7. **One-tap emergency SOS** — floating SOS button with a 3-second cancelable countdown, then broadcasts your name, location, and an optional medical/contact note to every rider in the squad. Recipients get a full-screen alert with distance, sound, vibration, a "View on Map" jump, and a persistent pulsing marker on the squad map at the sender's location (cleared when they cancel or leave).
8. **Rider-to-rider voice** — a large **MIC ON / MIC OFF** toggle (not push-to-talk — holding a button while riding with gloves on isn't practical). The first time you tap MIC ON in a squad, it requests microphone access and opens WebRTC connections to everyone currently in the squad; tapping it again just mutes your own mic; you keep hearing the channel either way. Peer-to-peer over WiFi or mobile internet via the app's own WebSocket signaling server — no Bluetooth pairing needed.
9. **Live weather** — a dashboard widget (temperature, condition, wind) for your current location via [Open-Meteo](https://open-meteo.com/) (free, no API key), refreshed every 15 minutes, plus a rain-ahead banner when the next few hours look wet.
10. **Squad speed limit** — any rider sets a shared km/h limit for the ride (Squad screen); it syncs to everyone instantly. Cross it and you get a local warning (toast + vibration + the dashboard card turns red) *and* the squad is notified who's over and by how much — throttled to avoid spamming the chat while you're sustained over.
11. **Road speed limit (Beta)** — an opt-in Settings toggle does a best-effort lookup of the legal speed limit for the road you're on, via OpenStreetMap data. Genuinely best-effort: coverage is sparse outside major cities (especially in India), so it will often show "no data" — it's clearly labeled Beta and is never meant to replace actual road signage.
12. **Hazard reports (police / bad road / traffic / accident)** — a rider taps the ⚠️ button on the map, picks a type, and it's broadcast to the squad's map as a pin for ~45 minutes. This is entirely squad-sourced — like a private, small-scale version of Waze's crowdsourced reports — not a connection to any live traffic or law-enforcement data feed (no such free public data source exists).
13. **Target / destination location** — tap the 🎯 button on the map, then tap anywhere on the map to drop a pin, and choose **Just for Me** (a private waypoint only you see) or **Share with Squad** (broadcast to everyone, replacing any previous squad destination — anyone can set or clear it). A pill on the map shows live distance to whichever destination(s) are active, with a one-tap ✕ to clear each.

## Run it

```bash
cd RideSquad
npm install
npm start
```

Then open `http://localhost:8787` in a browser.

## Testing a real group ride (multiple phones)

Two things to know:

- **HTTPS is required for GPS + microphone on real devices.** Browsers only allow `navigator.geolocation` and `getUserMedia` (mic) on a "secure context" — `localhost` is exempt, but a plain `http://192.168.x.x:8787` on your phone is not. For a real multi-phone test, put the server behind HTTPS — the fastest way is a tunnel:
  ```bash
  npx ngrok http 8787
  ```
  then open the `https://…ngrok…` URL on every rider's phone.
- **Everyone joins the same squad code.** One rider taps "Create New Squad" (gets a code like `RZ7X`), shares it verbally/by text, and the others enter it under "Join". All riders then appear on each other's map, member list, and voice channel.

## Deployment — the server is live

**Live URL: [https://ridesquad-fli7.onrender.com](https://ridesquad-fli7.onrender.com)** — deployed on [Render](https://render.com)'s free tier, Singapore region. Anyone can open that URL directly in a phone browser and use the app right now; no local server needed. `capacitor.config.json` points the Android app at this same URL, so the native app talks to it too.

**Why this fixes the recurring "app not working" problem:** the server used to only run when someone started it on this PC, and the Android app had to be told this PC's LAN IP by hand — which broke the moment the PC was off, asleep, or the router handed out a new IP. This deployment runs independently of any local machine, at a stable HTTPS address, reachable from any network in the world.

**One real tradeoff:** Render's free tier spins the instance down after ~15 minutes of inactivity. The first request after a quiet spell takes a few extra seconds while it wakes back up — everything after that is normal speed. If that becomes annoying, the fix is upgrading that one service to Render's paid tier (~$7/mo), or moving to a provider with a truly always-on free tier (Northflank's free Sandbox was the other option considered — genuinely no cold start, but requires a card on file for verification even though it isn't charged).

**What made this deployable:**
- [`Dockerfile`](Dockerfile) at the repo root — Node 20 Alpine, installs only the server's own dependency (`ws`), not the whole Capacitor/Android toolchain.
- [`server/package.json`](server/package.json) + lockfile — the server's dependencies, isolated from the root `package.json` (which is for the Capacitor/Android side).
- A `/healthz` endpoint (returns `200 ok`) — Render's health check polls this to confirm the container's alive.
- `server.js` reads the port from `process.env.PORT` (falls back to 8787 locally) — exactly what Render (and every host like it) expects.

**To redeploy after code changes:** just `git push` to `main` — Render's set to auto-deploy on every commit to this repo.

**If you ever need to move it elsewhere:** repeat the same steps against Northflank, Railway, Fly.io, or any Docker-friendly host — nothing here is Render-specific except the final URL.

**Abuse protection (because this is now reachable by strangers, not just your WiFi):** `server.js` includes several limits so one misbehaving client can't degrade things for everyone sharing the free instance:
- Squad codes are now 8 characters (~1.1 trillion combinations) instead of 5 — brute-forcing a live squad code is impractical.
- Per-IP limits: max 8 simultaneous connections, max 20 new connections/minute.
- Per-connection limits: max 6 join attempts/minute, max 15 messages/second, SOS cooldown 10s, hazard-report cooldown 5s.
- Per-squad cap of 25 riders; server-wide cap of 2000 active squads — bounds memory on a free-tier instance.
- Rejections come back to the app as a toast (e.g. "This squad is full") rather than silently failing.

None of this requires accounts, passwords, or auth — it's still exactly the same "share a code" trust model as before, just hardened against automated abuse now that the code is public.

## Architecture

- `server/server.js` — a small Node HTTP + WebSocket server. Serves the static frontend and relays, per squad room: rider join/leave, live location, chat, SOS broadcasts, and WebRTC signaling (offers/answers/ICE) for voice. It never stores ride data — everything is in-memory and per-room, for relay only. Includes basic abuse protection (per-IP/per-connection rate limits, room/member caps) since it's meant to be deployed publicly — see the deployment section below.
- `public/js/speed.js` — GPS watch loop; derives speed/acceleration/distance from raw position fixes with jitter filtering and a low-pass filter on acceleration.
- `public/js/map.js` — Leaflet map (free OpenStreetMap tiles, no API key) with a CSS filter for the dark, sporty look.
- `public/js/group.js` — thin WebSocket client wrapper (squad membership, location, chat, SOS, signaling transport).
- `public/js/voice.js` — WebRTC mesh: each rider holds one `RTCPeerConnection` per squadmate. Voice infra (peer connections) is only created the first time a rider taps MIC ON, targeting everyone currently in the squad at that moment; toggling the mic after that just enables/disables the local track (no renegotiation needed). A rider who never taps MIC ON never opens a mic connection — one who does stays reachable (can be heard, and hears others) even after muting again, since the connections stay open.
- `public/js/app.js` — screens, navigation, and wiring all of the above together.

## Android Studio

The app is now also a native Android project at `android/`, wired up with [Capacitor](https://capacitorjs.com/) — the web app in `public/` runs unmodified inside a WebView shell, so there's no separate codebase to maintain.

**Already configured on this machine:**
- Android SDK detected at `D:\Android studio 1` (`android/local.properties` points there).
- `android/variables.gradle` set to `compileSdk 37` / `targetSdk 36` — the locally installed platforms are `android-34` and `android-37.0` only (no 35/36), and Capacitor's AndroidX dependencies require compiling against ≥36, so 37 is the only installed platform that satisfies that.
- `AndroidManifest.xml` has the permissions the app needs: `INTERNET`, `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` (speedometer GPS), `RECORD_AUDIO`/`MODIFY_AUDIO_SETTINGS` (walkie-talkie voice), `WAKE_LOCK`, `VIBRATE`. Capacitor's WebView already auto-prompts the user for the location/mic runtime permissions the first time the web page calls `navigator.geolocation` / `getUserMedia` — no extra native code needed.
- `android/.idea/gradle.xml` pins this project's Gradle JDK to `jbr-21` (a JDK 21 Android Studio already has registered) — **important**: this Android Studio install's default embedded JDK is JDK 25, which the pinned Gradle version (8.14.3) can't run on yet (`Unsupported class file major version 69`). If Studio ever asks you to pick a Gradle JDK for this project, choose `jbr-21`, not the embedded default.
- A debug build was verified end-to-end from the command line (`gradlew assembleDebug` → `BUILD SUCCESSFUL`), producing `android/app/build/outputs/apk/debug/app-debug.apk`.

**How the app reaches the server:** rather than bundling the static files and separately figuring out where the WebSocket server lives, `capacitor.config.json` points the whole WebView at the live Node server via `server.url`. It is currently set to `http://192.168.29.248:8787` — this PC's Wi-Fi LAN IP, for testing on a **real phone**. Things to remember:
- **Start the server first** (`npm start` in this folder) before launching the app.
- **Phone and PC must be on the same Wi-Fi**, and Windows Firewall has to allow inbound connections to Node on port 8787 (approve the prompt for private networks). If the app opens to a blank or "can't connect" page, that firewall prompt is the usual culprit.
- **This PC's LAN IP is DHCP-assigned**, so it can change after a router reboot. If the app stops connecting, re-check it with `ipconfig`, update `server.url`, and run `npx cap sync android`.
- **To go back to the emulator** (`Pixel_10a`), set `server.url` to `http://10.0.2.2:8787` — `10.0.2.2` is the emulator's special alias for the host's `localhost` — then `npx cap sync android`.

**Open and run it:**
1. Open Android Studio → Open → select the `android/` folder (not the repo root).
2. Let Gradle sync (first sync downloads dependencies; if it prompts about the Gradle JDK, pick `jbr-21`).
3. Make sure `npm start` is running in a terminal so the server is reachable.
4. Pick the `Pixel_10a` emulator (already created) or a physical device, and hit Run.

To build a debug APK from the command line instead (useful for CI or sideloading):
```bash
cd android
./gradlew assembleDebug
```
The JDK bundled with Android Studio (`jbr`, JDK 25) is too new for Gradle 8.14.3 — point `JAVA_HOME` at a JDK 21 first, e.g. the one Studio already has at `%USERPROFILE%\.jdks\jbr-21.0.11`.

## Notes / next steps

- The Android project (see above) is a debug build for local testing. To publish to the Play Store, you'd generate a signed release build (`./gradlew bundleRelease` with a real keystore) — pair that with the deployed HTTPS server URL from the section above instead of a LAN IP.
- iOS would follow the same pattern — `npx cap add ios` — but needs a Mac with Xcode, which isn't available on this machine.
- Voice mesh is fine for the "5/6 riders" scale mentioned in the brief; beyond ~8 riders you'd want an SFU (e.g. mediasoup) instead of full mesh.
- The Bluetooth-mesh idea (direct phone-to-phone with no internet) isn't feasible from a browser — Web Bluetooth can't carry live audio between two phones. The WebRTC-over-internet/WiFi approach used here is the practical "best available" option from a web app, and is what the brief's "bluetooth / wifi / internet — whichever is best" ultimately resolves to.

### Other feature ideas worth considering

Not built yet, but each is a natural next addition:
- **Automatic crash detection** — a sudden, sharp deceleration from a meaningful speed could auto-trigger the SOS countdown instead of waiting for a tap (genuinely useful, but needs careful tuning against false positives from hard braking before shipping).
- **Lead-rider waypoints** — drop a pin ("fuel stop ahead", "turn here") that shows on everyone's map, for a designated lead rider.
- **Fatigue / break reminders** — a gentle nudge every N minutes or km of continuous riding.
- **Ride summary / route replay** — save the GPS track locally per ride and show a post-ride summary (distance, average speed, route on map).
- **Severe weather alerts** — the current weather widget shows conditions and a rain-ahead heads-up; a step further would be pushing alerts for official severe weather warnings (needs a government/meteorological alerts API, region-dependent).
