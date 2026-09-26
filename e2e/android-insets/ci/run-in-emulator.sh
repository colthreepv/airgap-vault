#!/usr/bin/env bash
# Runs as reactivecircus/android-emulator-runner's script, with the emulator
# booted as emulator-5554. The action runs every script line through a separate
# 'sh -c', so the whole per-job scenario lives here.
#
# Inputs (environment): APK_PATH, RESULTS_PATH, MATRIX_API, MATRIX_NAV, MATRIX_APP.
# Optional: RUN_TIMEOUT (default 15m) bounds run.mjs.
# Exit code: the exit code of run.mjs (0 pass, 1 assertion failures, 2 harness
# error), so a candidate failure fails the job.
set -uo pipefail

: "${APK_PATH:?}" "${RESULTS_PATH:?}" "${MATRIX_API:?}" "${MATRIX_NAV:?}" "${MATRIX_APP:?}"
serial="${ADB_SERIAL:-emulator-5554}"
run_timeout="${RUN_TIMEOUT:-15m}"
label="${MATRIX_APP}-api-${MATRIX_API}-${MATRIX_NAV}"
diag="$RESULTS_PATH/diagnostics"
mkdir -p "$RESULTS_PATH" "$diag"

# adb blocks indefinitely on an offline device; bound every diagnostic call.
adb_t() { timeout --kill-after=5s 30s adb -s "$serial" "$@"; }

timeout 120s adb -s "$serial" wait-for-device
{
  echo "serial=$serial"
  adb_t shell getprop ro.build.version.sdk
  adb_t shell getprop ro.product.model
  adb_t shell wm size
  adb_t shell wm density
  adb_t shell settings get secure navigation_mode
  adb_t shell dumpsys webviewupdate | grep -E 'Current WebView package|Valid package' || true
} > "$diag/device-before.txt" 2>&1 || true
adb_t logcat -c || true

timeout --kill-after=30s "$run_timeout" node e2e/android-insets/run.mjs \
  --apk "$APK_PATH" \
  --nav "$MATRIX_NAV" \
  --out "$RESULTS_PATH" \
  --serial "$serial" \
  --label "$label" 2>&1 | tee "$RESULTS_PATH/run.log"
status="${PIPESTATUS[0]}"
if [ "$status" = 124 ] || [ "$status" = 137 ]; then
  # run.mjs can write its report and then fail to exit; recover its verdict.
  echo "run.mjs did not exit within $run_timeout (status $status)"
  status="$(node -e '
    const fs = require("fs")
    try {
      const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      console.log(r.error ? 2 : r.failed > 0 || r.passed === 0 ? 1 : 0)
    } catch { console.log(2) }
  ' "$RESULTS_PATH/report.json")"
  echo "timed out; verdict from report.json: $status" >> "$RESULTS_PATH/run.log"
fi
echo "$status" > "$RESULTS_PATH/exit-code"
echo "run.mjs exit code: $status"

if [ "$status" != 0 ]; then
  timeout 10s adb devices -l > "$diag/adb-devices.txt" 2>&1 || true
  adb_t logcat -d > "$diag/logcat.txt" 2>&1 || true
  adb_t exec-out screencap -p > "$diag/final-screen.png" 2>/dev/null || true
  adb_t shell uiautomator dump /sdcard/final-ui.xml > /dev/null 2>&1 \
    && adb_t pull /sdcard/final-ui.xml "$diag/final-ui.xml" > /dev/null 2>&1 || true
  adb_t shell dumpsys window windows > "$diag/dumpsys-window.txt" 2>&1 || true
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  if [ -f "$RESULTS_PATH/report.md" ]; then
    cat "$RESULTS_PATH/report.md" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "run.mjs exited $status without writing $RESULTS_PATH/report.md." >> "$GITHUB_STEP_SUMMARY"
  fi
fi

exit "$status"
