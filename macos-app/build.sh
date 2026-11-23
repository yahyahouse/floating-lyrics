#!/bin/bash
# Builds "Floating Lyrics.app" into macos-app/build/. Usage: ./build.sh [--install]
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Floating Lyrics.app"
swift build -c release
BIN="$(swift build -c release --show-bin-path)"

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

cat > "$APP/Contents/Info.plist" <<'PLIST'
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
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signature (enough to run on this Mac)
codesign --force --deep --sign - "$APP"
echo "Built: $(pwd)/$APP"

if [[ "${1:-}" == "--install" ]]; then
  rm -rf "/Applications/Floating Lyrics.app"
  cp -R "$APP" /Applications/
  echo "Installed: /Applications/Floating Lyrics.app"
fi
