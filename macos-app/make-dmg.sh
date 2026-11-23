#!/bin/bash
# Builds a release DMG: ./make-dmg.sh 1.1.0  →  build/FloatingLyrics-1.1.0.dmg
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-$(cat VERSION)}"
DMG="build/FloatingLyrics-$VERSION.dmg"

# The app version must match the release tag (auto-update compares them)
VERSION="$VERSION" UNIVERSAL=1 ./build.sh

STAGE="build/dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "build/Floating Lyrics.app" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# hdiutil sometimes fails with "Resource busy", retry a few times
for i in 1 2 3 4 5; do
  if hdiutil create -volname "Floating Lyrics" -srcfolder "$STAGE" -ov -format UDZO "$DMG"; then
    break
  fi
  echo "hdiutil failed, retrying ($i)..."
  sleep 5
  [ "$i" = 5 ] && exit 1
done
rm -rf "$STAGE"

echo "DMG: $(pwd)/$DMG"
