# YTM Floating Lyrics

Floating lyrics synced with the song playing on YouTube Music. When lyrics are missing, AI listens to the whole song and writes them.

## Lyrics source order

• Your own lyrics (entered or tap-synced in the editor)
• AI lyrics, if you asked AI to recreate them for that song (✦)
• LRCLIB lyrics you picked with 🔍 for that song
• YouTube Music's own lyrics (synced version, if available)
• Static YTM lyrics → timestamps from LRCLIB; if not found, lines get estimated timing (or AI timing from ⟳)
• Cached AI lyrics created earlier
• LRCLIB synced lyrics
• AI (Whisper / Gemini): listen to one full song → transcribe → save → shown when the song plays again

## Installation

### Chrome extension

1. Get the code: `git clone https://github.com/yahyahouse/floating-lyrics.git`, or on GitHub click Code → Download ZIP and unzip it
2. Open `chrome://extensions`
3. Turn on Developer mode (top right)
4. Click Load unpacked and pick the `floating-lyrics` folder
5. Open music.youtube.com and play a song. Lyrics appear in a floating card on the page

To update the extension: `git pull` (or download the ZIP again), then click the ↻ reload button on the extension card in `chrome://extensions` and refresh the YouTube Music tab.

### macOS app (optional)

1. Download `FloatingLyrics-x.y.z.dmg` from the latest [release](https://github.com/yahyahouse/floating-lyrics/releases/latest)
2. Open the DMG and drag Floating Lyrics into Applications
3. The app isn't notarized by Apple, so macOS blocks the first launch. Allow it once with:
   ```sh
   xattr -dr com.apple.quarantine "/Applications/Floating Lyrics.app"
   ```
   Or open it, then go to System Settings → Privacy & Security and click Open Anyway
4. Open Floating Lyrics (it lives in the menu bar, no Dock icon), make sure the Chrome extension is installed, and play a song on music.youtube.com

After that the app updates itself (see below). Keep it in Applications, or auto-update won't work.

## AI setup

• Click the extension icon
• Pick a provider: OpenAI (`whisper-1`), Groq (`whisper-large-v3`), Google Gemini (`gemini-3.8-flash`, API key from Google AI Studio), or a local OpenAI-compatible server
• Enter the API key and click Save
• Click "Allow AI to listen to this tab" (needed again for every new tab / browser restart)

For local Whisper on a Mac, use a server that exposes `/v1/audio/transcriptions`, e.g. speaches (faster-whisper-server) at `http://localhost:8000/v1`.

## Overlay features

• Drag the header to move, drag the bottom-right corner to resize
• Click a lyric line to jump to that part
• A- / A+ text size
• − / + next to the source badge: shift lyric timing by 0.25s for this song when lyrics run early or late. Click the value to reset
• 🔍 button (or click the song title): wrong or missing lyrics? Search LRCLIB by title & artist and pick the right result. Results show Synced / Text only and "Same length" when the duration matches the song. Shorter-title suggestions ("Try: …") strip words like "Mashup" or "(Official Video)". The pick is saved per song (✎ mark on the title); "Use original" goes back
• ✎ button: enter or edit lyrics yourself. Plain text gets estimated timing, LRC format is synced right away. Manual lyrics always win for that song
• Tap sync (in the editor): the song plays from the start, press Space/Enter or click as each line begins; Backspace undoes, Esc cancels. Saved as LRC
• ⟳ button (match timing): AI listens from start to end and matches each lyric line to its time. The known lyrics are sent to the AI so it hears the right words. The text stays the same, only timestamps are saved
• ✦ button (recreate lyrics): AI listens from the start and writes new lyrics, used for that song from then on. Reset via "Reset AI lyrics & timing for this song" in the popup
• PiP button: lyrics window floats above all tabs and apps
• Minimize: shows only the line being sung, always on one row (long lines shrink to fit); the width can be resized
• Popup → Display: background transparency slider, and "Show menu only on hover" (only the lyrics show until the cursor enters)
• Alt+Shift+L: show / hide

## macOS app (optional)

The extension works on its own. The Mac app in `macos-app/` is an extra: a native floating lyrics window that stays above every app, on every Space and over full-screen apps, with a menu bar icon.

• Install: see [Installation](#macos-app-optional) above. Build from source instead: `cd macos-app && ./build.sh --install` (needs Xcode command line tools) → `/Applications/Floating Lyrics.app`
• Open the app, then play a song on music.youtube.com. The extension connects to it within a few seconds
• While the app is open the in-tab overlay hides (turn off "Hide tab overlay while the Mac app is open" in the popup to keep both). Quit the app → the in-tab overlay comes back
• Player card: artist & title, scrolling lyrics (the sung line bright, the rest faded), progress bar with time, and ⏮ / Play-Pause / ⏭ buttons that control YouTube Music. Make the window shorter and the controls, then the progress bar, step aside
• Menu bar icon: show/hide window, Current Line Only, Click-Through (clicks pass through the lyrics), Play / Pause, Open at Login
• Drag the window by its top edge, resize from the edges. Click a line to jump to it. Text size is set from the menu bar icon → Text Size and stays the same when the window is resized; transparency follows the extension settings

Auto-update: the app checks GitHub Releases 10 seconds after it opens and every 6 hours after that. When a newer version is out it downloads the DMG, replaces itself and relaunches. "Check for Updates" in the menu bar does it right away. The app must be in the Applications folder for this to work.

Releasing a new version: bump `macos-app/VERSION`, then push a tag with the same number (`git tag v1.1.0 && git push origin v1.1.0`). GitHub Actions builds `FloatingLyrics-1.1.0.dmg` and attaches it to the release; installed apps pick it up through auto-update. Build a DMG locally with `macos-app/make-dmg.sh 1.1.0`. Optional repository secrets `SIGNING_CERT_P12` (base64 .p12) and `SIGNING_CERT_PASSWORD` sign the release with a fixed certificate; without them it is ad-hoc signed.

How it works: the app listens on `ws://127.0.0.1:47321` (localhost only, Chrome extension origins only). The extension's service worker connects to it and mirrors what the overlay shows. If the app isn't running the connection simply fails and nothing changes.

## Notes

• While AI is listening, don't skip or seek until the song ends. Pausing and buffering are fine.
• Lyrics from YouTube Music are not stored, only displayed. The cache only holds AI results and stays local in the browser.
• AI accuracy drops for songs with busy music or heavy vocals.
• Fetching YTM lyrics uses YouTube's internal API, so it may need updates if YouTube changes its structure.
