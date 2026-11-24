#!/usr/bin/env bash
# Build a signed, notarized, stapled DMG of Webscape Wanderer (Apple Silicon).
#
#   CSC_NAME="Your Org (TEAMID)" APPLE_KEYCHAIN_PROFILE=your-notary-profile scripts/release-mac.sh
#
# CSC_NAME:               the "Developer ID Application" identity in your keychain,
#                         without the "Developer ID Application: " prefix.
# APPLE_KEYCHAIN_PROFILE: a notarytool profile (xcrun notarytool store-credentials).
#
# Steps: build the app and the AI helper, sign everything with the hardened
# runtime, notarize + staple the app (electron-builder), build the DMG, then
# notarize + staple the DMG itself, and verify both with Gatekeeper.
set -euo pipefail

: "${CSC_NAME:?Set CSC_NAME to your Developer ID Application identity, e.g. \"Your Org (TEAMID)\"}"
: "${APPLE_KEYCHAIN_PROFILE:?Set APPLE_KEYCHAIN_PROFILE to a notarytool keychain profile}"
export CSC_NAME APPLE_KEYCHAIN_PROFILE

cd "$(dirname "$0")/.."
rm -rf release

npm run build
npm run build:ai
npx electron-builder --mac --arm64 --publish never

DMG=$(ls release/*.dmg | head -1)
APP=$(ls -d release/mac-arm64/*.app | head -1)

echo "Notarizing $DMG …"
xcrun notarytool submit "$DMG" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$DMG"

echo "Verifying …"
codesign --verify --deep --strict "$APP"
spctl --assess --type execute "$APP"
spctl --assess --type open --context context:primary-signature "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
echo "Done: $DMG"
