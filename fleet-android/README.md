# Driver Log Shalom – Android app

The Driver Log Shalom website in an Android app, plus **location sharing during trips with the screen off**. A website can't do this, because phones stop GPS for websites in the background.

## What it does
- Opens `https://driver-log.shalomchurch.co.in` with the same login and pages. Change the address with `-PbaseUrl=…` when building.
- **Start trip**: the website asks the app to start a *foreground service* (Android shows the notification "Driver Log Shalom – sharing location"). The service records GPS every ~30 s, or sooner after 50 m, with the screen off. **End trip** stops it.
- Points are queued in a file on the phone and sent to `/api/osmand` every ~45 s. With no signal they wait and are sent later.
- Works without Google Play services (uses Android's own `LocationManager`).
- **Reminders as phone notifications**: website push doesn't work inside an app, so the app checks `/api/notifications` with its login every 30 minutes (JobScheduler; also after a restart, and when the app opens) and shows new reminders as Android notifications. Tapping one opens the vehicle. No Firebase is needed.
- Camera photos, file and PDF uploads, and PDF / CSV downloads (saved to *Downloads*) work inside the app.
- Needs Android 7.0 or newer.

## Getting the APK
Every push that changes `fleet-android/` is built by GitHub Actions (`.github/workflows/android.yml`). The APK is published at:

    https://github.com/anandcar730-svg/test2/releases/download/android-app/driver-log-shalom.apk

Open that link on the phone, then install the file. Allow "Install unknown apps" for the browser when asked. Updates install over the previous version.

## Signing key
The app is signed with the key in `app/signing/driverlog.p12` so that every build can update the previous one. The repository is public, so that key is public too. For more security, use your own private key:

1. `keytool -genkeypair -alias driverlog -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -keystore my.p12`
2. Add repository secrets: **DRIVERLOG_KEYSTORE_B64** (`base64 -w0 my.p12`) and **DRIVERLOG_KEYSTORE_PASSWORD**.
3. Uninstall the old app once, because a new key can't update an app signed with the old one, then install the newly built APK.

## Building locally
You need Android Studio, or the Android SDK plus JDK 17 and Gradle 8.9:

    cd fleet-android && gradle assembleRelease
