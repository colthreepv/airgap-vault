# Android fork build

Build the web app and sync it into Android as usual. Then run from `android/`:

```sh
./gradlew :app:assembleFork -PairgapBaseVersion=3.34.4
```

In PowerShell, quote the Gradle property argument:

```powershell
.\gradlew.bat :app:assembleFork '-PairgapBaseVersion=3.34.4'
```

The resulting APK is `app/build/outputs/apk/fork/app-fork.apk`. It installs as
**AirGap Vault Fork** (`it.airgap.vault.fork`) alongside the official app and
the debug **AirGap Vault Dev** app (`it.airgap.vault.devtest`). The Android
version name is `3.34.4-fork.1`; update the base version and fork suffix for
future builds. The fork build is not debuggable, but it currently uses the
machine's Android debug signing key. Keep that key to install updates without
uninstalling the app and losing its local data.
