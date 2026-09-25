#!/usr/bin/env bash
# Device + server preflight. Branches on APPIUM_PLATFORM from .env.
set -uo pipefail
[ -f .env ] && set -a && . ./.env && set +a
PLATFORM="${APPIUM_PLATFORM:-}"
FAIL=0

case "$PLATFORM" in
  android)
    echo "── [Android] devices ──"
    adb devices -l | sed '1d' | grep -q . \
      && adb devices -l | sed '1d' \
      || { echo "FAIL: no device. Replug USB, unlock, accept the debugging prompt ON THE PHONE."; FAIL=1; }
    adb devices | grep -q unauthorized \
      && { echo "FAIL: unauthorized — accept the RSA prompt on the device."; FAIL=1; }
    ;;
  ios)
    echo "── [iOS] devices ──"
    if ! xcrun simctl help >/dev/null 2>&1; then
      echo "FAIL: full Xcode required (Command Line Tools alone cannot enumerate devices)."
      echo "      Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app"
      FAIL=1
    fi
    command -v idevice_id >/dev/null 2>&1 \
      && { idevice_id -l | grep -q . || { echo "FAIL: no iOS device (trust this computer on the phone?)"; FAIL=1; }; } \
      || echo "note: libimobiledevice not installed — cannot list real devices."
    ;;
  *)
    echo "FAIL: APPIUM_PLATFORM must be 'android' or 'ios' (got '${PLATFORM:-<empty>}')."
    echo "      Run Phase −1 and fill it in .env."
    FAIL=1
    ;;
esac

echo "── Appium server ──"
curl -sf "http://${APPIUM_HOST:-127.0.0.1}:${APPIUM_PORT:-4723}/status" >/dev/null \
  && echo "server OK" \
  || { echo "FAIL: server not answering. Start it: npm run appium"; FAIL=1; }

[ "$FAIL" -eq 0 ] && echo "PREFLIGHT GREEN" || echo "PREFLIGHT RED"
exit "$FAIL"
