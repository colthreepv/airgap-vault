#!/usr/bin/env bash
# Runs as reactivecircus/android-emulator-runner's pre-emulator-launch-script,
# after the AVD exists and before the emulator boots. The action runs every
# script line through a separate 'sh -c', so keep the logic here in bash.
set -euo pipefail

avd_name="${AVD_NAME:-airgap-insets}"
config=''
for dir in "${ANDROID_AVD_HOME:-}" "${ANDROID_USER_HOME:-}/avd" "${ANDROID_EMULATOR_HOME:-}/avd" "$HOME/.android/avd" "$HOME/.config/.android/avd"; do
  if [ -n "$dir" ] && [ -f "$dir/$avd_name.avd/config.ini" ]; then
    config="$dir/$avd_name.avd/config.ini"
    break
  fi
done
if [ -z "$config" ]; then
  echo "configure-avd: config.ini for $avd_name not found" >&2
  exit 1
fi

for setting in hw.lcd.width=1080 hw.lcd.height=2400 hw.lcd.density=420 hw.camera.back=emulated; do
  key="${setting%%=*}"
  if grep -q "^${key}[[:space:]]*=" "$config"; then
    sed -i "s|^${key}[[:space:]]*=.*|${setting}|" "$config"
  else
    printf '%s\n' "$setting" >> "$config"
  fi
done
echo "configure-avd: $config"
grep -E '^(hw\.lcd\.|hw\.camera\.|image\.sysdir|tag\.id|abi\.type)' "$config" || true
