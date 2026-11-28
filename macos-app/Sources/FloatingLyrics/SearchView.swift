import SwiftUI

/// "Wrong or missing lyrics?" — search LRCLIB by title & artist and pick the right result.
/// Same as the 🔍 panel in the extension overlay; the pick is saved per song by the extension.
struct SearchView: View {
    @ObservedObject var model: LyricsModel
    var onDone: () -> Void

    @State private var title = ""
    @State private var artist = ""
    @FocusState private var titleFocused: Bool

    private var custom: Bool { model.state?.custom ?? false }
    private var findId: Int? { model.state?.findId }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(playing)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(1)

            HStack {
                TextField("Song title", text: $title)
                    .focused($titleFocused)
                TextField("Artist (optional)", text: $artist)
                    .frame(maxWidth: 160)
                Button("Search", action: run)
                    .keyboardShortcut(.defaultAction)
            }
            .textFieldStyle(.roundedBorder)
            .onSubmit(run)

            let tries = simplerTitles(title.trimmingCharacters(in: .whitespaces))
            if !tries.isEmpty {
                HStack(spacing: 6) {
                    ForEach(tries, id: \.self) { t in
                        Button("Try: \(t)") { title = t; run() }
                            .buttonStyle(.link)
                            .font(.system(size: 12))
                            .lineLimit(1)
                            .help("Search with this shorter title")
                    }
                }
            }

            results
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack {
                if custom {
                    Button("Use original") { model.pick(nil); onDone() }
                        .help("Go back to the normal lyrics search")
                }
                Spacer()
                Button("Cancel", action: onDone)
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(16)
        .frame(minWidth: 460, minHeight: 360)
        .onAppear {
            let s = model.state
            title = s?.title ?? ""
            // YT Music often lists several artists ("A, B, C") → only the first one searches better
            artist = custom ? s?.artist ?? "" : firstArtist(s?.artist ?? "")
            titleFocused = true
            run()
        }
    }

    @ViewBuilder private var results: some View {
        if !model.connected {
            message("Not connected to the Chrome extension.")
        } else if model.searching {
            message("Searching…")
        } else if let err = model.searchError {
            message(err)
        } else if model.searchItems.isEmpty {
            message(title.trimmingCharacters(in: .whitespaces).isEmpty
                    ? "Type a song title to search."
                    : artist.isEmpty
                    ? "No lyrics found. Try a shorter title or check the spelling."
                    : "No lyrics found. Try clearing the artist or using a shorter title.")
        } else {
            List(model.searchItems) { it in
                Button { model.pick(it); onDone() } label: { row(it) }
                    .buttonStyle(.plain)
                    .help(it.synced ? "Use these lyrics (timed)" : "Use these lyrics (timing will be estimated)")
            }
            .listStyle(.bordered(alternatesRowBackgrounds: true))
        }
    }

    private func row(_ it: SearchItem) -> some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(it.title).font(.system(size: 13, weight: .semibold))
                Text([it.artist, it.album].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            Spacer(minLength: 8)
            if it.id == findId { tag("In use", .blue) }
            tag(it.synced ? "Synced" : "Text only", it.synced ? .purple : .gray)
            if it.lengthMatch { tag("Same length", .green) }
            if it.duration > 0 {
                Text(String(format: "%d:%02d", it.duration / 60, it.duration % 60))
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }

    private func tag(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.2)))
            .foregroundStyle(color)
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var playing: String {
        let t = model.state?.origTitle ?? model.state?.title ?? ""
        let a = model.state?.origArtist ?? ""
        return "Playing: \(t.isEmpty ? "?" : t)\(a.isEmpty ? "" : " — \(a)")"
    }

    private func run() {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { model.searchItems = []; model.searchError = nil; return }
        model.search(title: t, artist: artist.trimmingCharacters(in: .whitespaces))
    }
}

/// "A, B & C" / "A x B" / "A and B" → "A"
private func firstArtist(_ s: String) -> String {
    let parts = s.split(separator: #/\s*[,&]\s*|\s+(?i:x|and)\s+/#, maxSplits: 1)
    return parts.first.map(String.init) ?? s
}

/// "Romance Like SRK - Mashup (Official Video) ft. X" → "Romance Like SRK" (mirrors content.js)
private func simplerTitles(_ title: String) -> [String] {
    var out: [String] = []
    func add(_ x: String) {
        let x = x.replacing(#/\s+/#, with: " ").trimmingCharacters(in: .whitespaces)
        if !x.isEmpty && x != title && !out.contains(x) { out.append(x) }
    }
    let noBrackets = title.replacing(#/\s*[(\[{【][^)\]}】]*[)\]}】]/#, with: "")
    add(noBrackets)
    add(String(noBrackets.split(separator: #/\s+[-–—|:]\s+/#, maxSplits: 1).first ?? ""))
    add(noBrackets.replacing(#/(?i)\s+(feat\.?|ft\.?|featuring)\s.*$/#, with: ""))
    return Array(out.prefix(2))
}
