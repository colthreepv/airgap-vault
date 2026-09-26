#!/usr/bin/env bash
# Runs as reactivecircus/android-emulator-runner's script, with the emulator
# booted as emulator-5554. The action runs every script line through a separate
# 'sh -c', so the whole per-job scenario lives here.
#
# Inputs (environment): APK_PATH, RESULTS_PATH, MATRIX_API, MATRIX_NAV, MATRIX_APP.
# Exit code: the exit code of run.mjs (0 pass, 1 assertion failures, 2 harness
# error), so a candidate failure fails the job.
set -uo pipefail

: "${APK_PATH:?}" "${RESULTS_PATH:?}" "${MATRIX_API:?}" "${MATRIX_NAV:?}" "${MATRIX_APP:?}"
serial="${ADB_SERIAL:-emulator-5554}"
label="${MATRIX_APP}-api-${MATRIX_API}-${MATRIX_NAV}"
diag="$RESULTS_PATH/diagnostics"
mkdir -p "$RESULTS_PATH" "$diag"

adb -s "$serial" wait-for-device
{
  echo "serial=$serial"
  adb -s "$serial" shell getprop ro.build.version.sdk
  adb -s "$serial" shell getprop ro.product.model
  adb -s "$serial" shell wm size
  adb -s "$serial" shell wm density
  adb -s "$serial" shell settings get secure navigation_mode
  adb -s "$serial" shell dumpsys webviewupdate | grep -E 'Current WebView package|Valid package' || true
} > "$diag/device-before.txt" 2>&1 || true
adb -s "$serial" logcat -c || true

node e2e/android-insets/run.mjs \
  --apk "$APK_PATH" \
  --nav "$MATRIX_NAV" \
  --out "$RESULTS_PATH" \
  --serial "$serial" \
  --label "$label" 2>&1 | tee "$RESULTS_PATH/run.log"
status="${PIPESTATUS[0]}"
echo "$status" > "$RESULTS_PATH/exit-code"
echo "run.mjs exit code: $status"

if [ "$status" != 0 ]; then
  adb -s "$serial" logcat -d > "$diag/logcat.txt" 2>&1 || true
  adb -s "$serial" exec-out screencap -p > "$diag/final-screen.png" 2>/dev/null || true
  adb -s "$serial" shell uiautomator dump /sdcard/final-ui.xml > /dev/null 2>&1 \
    && adb -s "$serial" pull /sdcard/final-ui.xml "$diag/final-ui.xml" > /dev/null 2>&1 || true
  adb -s "$serial" shell dumpsys window windows > "$diag/dumpsys-window.txt" 2>&1 || true
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  if [ -f "$RESULTS_PATH/report.md" ]; then
    cat "$RESULTS_PATH/report.md" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "run.mjs exited $status without writing $RESULTS_PATH/report.md." >> "$GITHUB_STEP_SUMMARY"
  fi
fi

exit "$status"
