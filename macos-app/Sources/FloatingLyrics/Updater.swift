import AppKit

// MARK: - Auto-update from GitHub Releases

private struct GHRelease: Decodable {
    struct Asset: Decodable { let name: String; let browser_download_url: String }
    let tag_name: String
    let assets: [Asset]
}

/// Checks the latest GitHub release; when it is newer, downloads its DMG, replaces this app and relaunches.
@MainActor
final class Updater {
    static let repo = "yahyahouse/floating-lyrics"
    nonisolated static let appName = "Floating Lyrics.app"

    private(set) var status = "" { didSet { onChange() } }
    private var busy = false
    /// Called when `status` changes (to refresh the menu).
    var onChange: () -> Void = {}

    var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    func check(manual: Bool) {
        guard !busy else { return }
        busy = true
        if manual { status = "Checking…" }
        Task {
            defer { busy = false }
            do {
                var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(Self.repo)/releases/latest")!)
                req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
                let (data, resp) = try await URLSession.shared.data(for: req)
                if (resp as? HTTPURLResponse)?.statusCode == 404 { // no release published yet
                    status = "Up to date"
                    if manual { Self.alert("Floating Lyrics is up to date (v\(currentVersion)).") }
                    return
                }
                let rel = try JSONDecoder().decode(GHRelease.self, from: data)
                let latest = rel.tag_name.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))

                guard Self.isNewer(latest, than: currentVersion),
                      let asset = rel.assets.first(where: { $0.name.hasSuffix(".dmg") }),
                      let url = URL(string: asset.browser_download_url) else {
                    status = "Up to date"
                    if manual { Self.alert("Floating Lyrics is up to date (v\(currentVersion)).") }
                    return
                }

                let appPath = Bundle.main.bundlePath
                if appPath.contains("/AppTranslocation/") || appPath.hasPrefix("/Volumes/") {
                    status = "Move the app to Applications to update"
                    if manual { Self.alert("Move Floating Lyrics to the Applications folder so it can update itself.") }
                    return
                }

                status = "Downloading v\(latest)…"
                let (tmp, _) = try await URLSession.shared.download(from: url)
                let target = URL(fileURLWithPath: appPath)
                try await Task.detached { try Self.install(dmgAt: tmp, replacing: target) }.value
                Self.relaunch(target)
            } catch {
                status = "Update failed"
                if manual { Self.alert("Couldn't check for updates: " + error.localizedDescription) }
            }
        }
    }

    nonisolated static func isNewer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }
        let y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0
            let q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }

    nonisolated static func install(dmgAt tmp: URL, replacing target: URL) throws {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("FloatingLyricsUpdate-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }

        let dmg = work.appendingPathComponent("update.dmg")
        try fm.moveItem(at: tmp, to: dmg)

        let mount = work.appendingPathComponent("mnt")
        try run("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-quiet", "-mountpoint", mount.path])
        defer { try? run("/usr/bin/hdiutil", ["detach", mount.path, "-quiet", "-force"]) }

        let staged = work.appendingPathComponent(appName)
        try run("/usr/bin/ditto", [mount.appendingPathComponent(appName).path, staged.path])
        _ = try fm.replaceItemAt(target, withItemAt: staged)
    }

    nonisolated static func run(_ path: String, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            throw NSError(domain: "FloatingLyrics", code: Int(p.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: "\(path) failed (\(p.terminationStatus))"])
        }
    }

    static func relaunch(_ app: URL) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; open \"$0\"", app.path]
        try? p.run()
        NSApp.terminate(nil)
    }

    static func alert(_ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "Floating Lyrics"
        a.informativeText = text
        a.runModal()
    }
}
