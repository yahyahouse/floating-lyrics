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
}

/// Messages from the extension: `{ "type": "state", "state": {...} | null }`
struct IncomingMessage: Decodable {
    var type: String
    var state: LyricsState?
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
}
