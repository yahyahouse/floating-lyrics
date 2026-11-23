#!/bin/bash
# Builds "Floating Lyrics.app" into macos-app/build/. Usage: ./build.sh [--install]
#   VERSION        app version (default: contents of ./VERSION)
#   BUILD_NUMBER   CFBundleVersion (default: 1)
#   UNIVERSAL=1    Apple Silicon + Intel binary (used for releases)
#   SIGN_ID        signing identity (default "-" = ad-hoc)
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${VERSION:-$(cat VERSION)}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
SIGN_ID="${SIGN_ID:--}"
APP="build/Floating Lyrics.app"

ARCHS=()
if [[ "${UNIVERSAL:-0}" == "1" ]]; then ARCHS=(--arch arm64 --arch x86_64); fi
swift build -c release ${ARCHS[@]+"${ARCHS[@]}"}
BIN="$(swift build -c release ${ARCHS[@]+"${ARCHS[@]}"} --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/FloatingLyrics" "$APP/Contents/MacOS/FloatingLyrics"

# App icon from the extension's 128px icon
ICONSET="build/AppIcon.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512; do
  sips -z $s $s ../icons/128.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d ../icons/128.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Floating Lyrics</string>
  <key>CFBundleDisplayName</key><string>Floating Lyrics</string>
  <key>CFBundleIdentifier</key><string>com.floatinglyrics.mac</string>
  <key>CFBundleExecutable</key><string>FloatingLyrics</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

strip -x "$APP/Contents/MacOS/FloatingLyrics"
codesign --force --sign "$SIGN_ID" --identifier com.floatinglyrics.mac "$APP"
echo "Built v$VERSION: $(pwd)/$APP"

if [[ "${1:-}" == "--install" ]]; then
  rm -rf "/Applications/Floating Lyrics.app"
  cp -R "$APP" /Applications/
  echo "Installed: /Applications/Floating Lyrics.app"
fi
