# YTM Floating Lyrics

Floating lyrics synced with the song playing on YouTube Music. When lyrics are missing, AI listens to the whole song and writes them.

## Lyrics source order

• Your own lyrics (entered or tap-synced in the editor)
• AI lyrics, if you asked AI to recreate them for that song (✦)
• YouTube Music's own lyrics (synced version, if available)
• Static YTM lyrics → timestamps from LRCLIB; if not found, lines get estimated timing (or AI timing from ⟳)
• Cached AI lyrics created earlier
• LRCLIB synced lyrics
• AI (Whisper / Gemini): listen to one full song → transcribe → save → shown when the song plays again

## Installation

• Open `chrome://extensions`
• Enable Developer mode
• Click Load unpacked and pick this folder
• Open music.youtube.com and play a song

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
• ✎ button: enter or edit lyrics yourself. Plain text gets estimated timing, LRC format is synced right away. Manual lyrics always win for that song
• Tap sync (in the editor): the song plays from the start, press Space/Enter or click as each line begins; Backspace undoes, Esc cancels. Saved as LRC
• ⟳ button (match timing): AI listens from start to end and matches each lyric line to its time. The known lyrics are sent to the AI so it hears the right words. The text stays the same, only timestamps are saved
• ✦ button (recreate lyrics): AI listens from the start and writes new lyrics, used for that song from then on. Reset via "Reset AI lyrics & timing for this song" in the popup
• PiP button: lyrics window floats above all tabs and apps
• Minimize: shows only the line being sung, always on one row (long lines shrink to fit); the width can be resized
• Popup → Display: background transparency slider, and "Show menu only on hover" (only the lyrics show until the cursor enters)
• Alt+Shift+L: show / hide

## Notes

• While AI is listening, don't skip or seek until the song ends. Pausing and buffering are fine.
• Lyrics from YouTube Music are not stored, only displayed. The cache only holds AI results and stays local in the browser.
• AI accuracy drops for songs with busy music or heavy vocals.
• Fetching YTM lyrics uses YouTube's internal API, so it may need updates if YouTube changes its structure.
