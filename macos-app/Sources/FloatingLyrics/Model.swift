import Foundation

/// What the extension's overlay is showing, mirrored from content.js (`appState`).
struct LyricsState: Codable, Equatable {
    struct Status: Codable, Equatable {
        var title: String
        var sub: String?
        var live: Bool?
        var progress: Double?
    }

    var title: String?
    var artist: String?
    var badge: String?
    var lines: [String]?
    var active: Int?
    var state: Status?
    var font: Double?
    var transparency: Double?
    var visible: Bool?
    var paused: Bool?
    var time: Double?
    var duration: Double?
    /// Track as YT Music shows it (title/artist above may come from a picked search result)
    var origTitle: String?
    var origArtist: String?
    /// Lyrics come from a search pick; findId = the LRCLIB entry in use
    var custom: Bool?
    var findId: Int?
}

/// One LRCLIB search result (built by background.js `lrclibSearch`).
struct SearchItem: Codable, Equatable, Identifiable {
    var id: Int
    var title: String
    var artist: String
    var album: String
    var duration: Int
    var synced: Bool
    var lengthMatch: Bool
}

/// Messages from the extension:
/// `{ "type": "state", "state": {...} | null }` or `{ "type": "search", "req": n, "items": [...] | "error": "..." }`
struct IncomingMessage: Decodable {
    var type: String
    var state: LyricsState?
    var req: Int?
    var items: [SearchItem]?
    var error: String?
}

@MainActor
final class LyricsModel: ObservableObject {
    @Published var state: LyricsState?
    @Published var connected = false
    @Published var serverError: String?
    /// When the last state arrived — the song position keeps counting from here while playing.
    var receivedAt = Date()

    /// Sends a command back to the YouTube Music tab (set by the server).
    var sendCommand: ([String: Any]) -> Void = { _ in }

    var lines: [String] { state?.lines ?? [] }
    var active: Int { state?.active ?? -1 }
    var paused: Bool { state?.paused ?? true }
    var hasLyrics: Bool { connected && state?.state == nil && !lines.isEmpty }
    func line(_ i: Int) -> String? { i >= 0 && i < lines.count ? lines[i] : nil }
    /// 0 = solid background, 100 = fully see-through (same as the extension slider)
    var backgroundOpacity: Double {
        let pct = min(100, max(0, state?.transparency ?? 22))
        return 1 - pct / 100
    }

    var duration: Double { max(0, state?.duration ?? 0) }

    /// Song position right now, interpolated between updates from the extension.
    func elapsed(at date: Date = Date()) -> Double {
        let t = state?.time ?? 0
        let now = paused ? t : t + date.timeIntervalSince(receivedAt)
        return duration > 0 ? min(duration, max(0, now)) : max(0, now)
    }

    func next() { sendCommand(["type": "cmd", "cmd": "next"]) }
    func previous() { sendCommand(["type": "cmd", "cmd": "prev"]) }
    func seek(to line: Int) { sendCommand(["type": "cmd", "cmd": "seek", "i": line]) }
    func togglePlay() { sendCommand(["type": "cmd", "cmd": "toggle"]) }

    // MARK: Lyrics search (LRCLIB, through the extension)

    @Published var searching = false
    @Published var searchItems: [SearchItem] = []
    @Published var searchError: String?
    private var searchReq = 0

    func search(title: String, artist: String) {
        searchReq += 1
        searching = true
        searchError = nil
        searchItems = []
        sendCommand(["type": "cmd", "cmd": "search", "req": searchReq, "title": title, "artist": artist])
    }

    func receiveSearch(_ msg: IncomingMessage) {
        guard msg.req == searchReq else { return } // an older search answered late
        searching = false
        searchError = msg.error
        searchItems = msg.items ?? []
    }

    /// Use this result's lyrics for the current song; nil goes back to the original lyrics.
    func pick(_ item: SearchItem?) {
        let pick: Any = item.map { ["title": $0.title, "artist": $0.artist, "id": $0.id] as [String: Any] } ?? NSNull()
        sendCommand(["type": "cmd", "cmd": "pick", "pick": pick])
    }
}
