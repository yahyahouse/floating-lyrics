import SwiftUI

/// UI preferences that live in the app (not in the extension).
@MainActor
final class Prefs: ObservableObject {
    @AppStorage("compact") var compact = false
    @AppStorage("clickThrough") var clickThrough = false
    @AppStorage("theme") var themeRaw = Theme.dark.rawValue

    var theme: Theme {
        get { Theme(rawValue: themeRaw) ?? .dark }
        set { themeRaw = newValue.rawValue }
    }

    func nextTheme() {
        let all = Theme.allCases
        theme = all[(all.firstIndex(of: theme)! + 1) % all.count]
    }
}

enum Theme: String, CaseIterable {
    case glass, dark, transparent

    var title: String {
        switch self {
        case .glass: return "Liquid Glass"
        case .dark: return "Dark"
        case .transparent: return "Transparent"
        }
    }
}

/// Card background for each theme. Ghost Mode always looks Transparent.
private struct ThemeBackground: View {
    let theme: Theme
    let opacity: Double

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cardRadius, style: .continuous)
        switch theme {
        case .glass:
            if #available(macOS 26.0, *) {
                Color.clear.glassEffect(.regular, in: shape)
            } else {
                VisualEffectBackground().clipShape(shape)
            }
        case .dark:
            ZStack {
                shape.fill(Color.black.opacity(opacity))
                shape.strokeBorder(Color.white.opacity(opacity > 0.3 ? 0.07 : 0), lineWidth: 1)
            }
        case .transparent:
            Color.clear
        }
    }
}

/// Blurred backdrop for Liquid Glass on macOS versions before 26.
private struct VisualEffectBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

private let cardRadius: CGFloat = 30

/// Player card: artist / title + waveform, scrolling lyrics, progress and controls.
/// Parts drop away as the window gets shorter; "Current Line Only" shows just the sung line.
struct LyricsView: View {
    @ObservedObject var model: LyricsModel
    @ObservedObject var prefs: Prefs
    /// Tuck the window away into the menu bar icon
    var onHide: () -> Void = {}

    var body: some View {
        GeometryReader { g in
            let ghost = prefs.clickThrough
            let look = ghost ? Theme.transparent : prefs.theme
            ZStack {
                ThemeBackground(theme: look, opacity: model.backgroundOpacity)

                if prefs.compact {
                    CompactLine(model: model, ghost: ghost)
                    if !ghost {
                        HStack(spacing: 6) {
                            Spacer()
                            WindowButton(symbol: "hand.raised.slash", help: "Ghost mode: click-through & transparent (⌥⌘L)") {
                                prefs.clickThrough = true
                            }
                            WindowButton(symbol: "arrow.up.left.and.arrow.down.right", help: "Expand") {
                                prefs.compact = false
                            }
                            WindowButton(symbol: "eye.slash", help: "Hide to the menu bar (⌥⌘K)", action: onHide)
                        }
                        .padding(.trailing, 10)
                        .transition(.opacity)
                    }
                } else {
                    card(height: g.size.height)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cardRadius, style: .continuous))
        .environment(\.colorScheme, .dark)
        .animation(.easeInOut(duration: 0.25), value: model.connected)
        .animation(.easeInOut(duration: 0.25), value: prefs.compact)
        .animation(.easeInOut(duration: 0.3), value: prefs.clickThrough)
        .animation(.easeInOut(duration: 0.3), value: prefs.themeRaw)
    }

    private func card(height: CGFloat) -> some View {
        let ghost = prefs.clickThrough
        let look = ghost ? Theme.transparent : prefs.theme
        // Text needs a shadow when there's no solid card behind it
        let shadow: Double = look == .transparent ? 0.85 : look == .glass ? 0.25 : 0
        let showControls = height >= 360 && !ghost
        let showProgress = height >= 260 && !ghost
        return VStack(alignment: .leading, spacing: 0) {
            Header(model: model, ghost: ghost, shadow: shadow, theme: prefs.theme,
                   onTheme: { prefs.nextTheme() },
                   onGhost: { prefs.clickThrough = true },
                   onMinimize: { prefs.compact = true },
                   onHide: onHide)
                .padding(.top, 26)

            LyricsBody(model: model, shadow: shadow)
                .padding(.top, 6)

            if showProgress && model.connected {
                ProgressRow(model: model)
                    .shadow(color: .black.opacity(shadow), radius: 3)
                    .padding(.top, 8)
                    .transition(.opacity)
            }
            if showControls && model.connected {
                Controls(model: model)
                    .shadow(color: .black.opacity(shadow * 0.6), radius: 3)
                    .padding(.top, 14)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 26)
        .padding(.bottom, showControls ? 22 : 18)
        .animation(.easeInOut(duration: 0.2), value: showControls)
        .animation(.easeInOut(duration: 0.2), value: showProgress)
    }
}

// MARK: Header

private struct Header: View {
    @ObservedObject var model: LyricsModel
    var ghost: Bool
    var shadow: Double
    var theme: Theme
    var onTheme: () -> Void
    var onGhost: () -> Void
    var onMinimize: () -> Void
    var onHide: () -> Void

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.state?.artist.nonEmpty ?? (model.connected ? " " : "Floating Lyrics"))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white.opacity(0.5))
                Text(model.state?.title.nonEmpty ?? (model.connected ? "Floating Lyrics" : "Waiting for YouTube Music"))
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .lineLimit(1)
            .shadow(color: .black.opacity(shadow), radius: 3)
            Spacer(minLength: 12)
            Waveform(playing: model.connected && !model.paused, bars: 14, height: 26)
                .shadow(color: .black.opacity(shadow), radius: 3)
            if !ghost {
                HStack(spacing: 6) {
                    WindowButton(symbol: "circle.lefthalf.filled", help: "Theme: \(theme.title) — click to switch", action: onTheme)
                    WindowButton(symbol: "hand.raised.slash", help: "Ghost mode: click-through & transparent (⌥⌘L)", action: onGhost)
                    WindowButton(symbol: "minus", help: "Minimize to the current line", action: onMinimize)
                    WindowButton(symbol: "eye.slash", help: "Hide to the menu bar (⌥⌘K)", action: onHide)
                }
                .padding(.leading, 6)
                .transition(.opacity)
            }
        }
    }
}

// MARK: Lyrics / status

private struct LyricsBody: View {
    @ObservedObject var model: LyricsModel
    var shadow: Double

    var body: some View {
        Group {
            if !model.connected {
                message("Open music.youtube.com in Chrome",
                        sub: model.serverError ?? "The Floating Lyrics extension connects here automatically.")
            } else if let st = model.state?.state {
                message(st.title, sub: st.sub, progress: st.progress)
            } else if model.lines.isEmpty {
                message("Play a song to show lyrics", sub: nil)
            } else {
                LyricsScroller(model: model, shadow: shadow)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .mask(
            LinearGradient(stops: [
                .init(color: .clear, location: 0),
                .init(color: .black, location: 0.2),
                .init(color: .black, location: 0.75),
                .init(color: .clear, location: 1)
            ], startPoint: .top, endPoint: .bottom)
        )
    }

    private func message(_ title: String, sub: String?, progress: Double? = nil) -> some View {
        VStack(spacing: 6) {
            Text(title).font(.system(size: 16, weight: .semibold))
            if let sub, !sub.isEmpty {
                Text(sub).font(.system(size: 12)).foregroundStyle(.white.opacity(0.5))
            }
            if let progress {
                ProgressView(value: min(1, max(0, progress))).frame(maxWidth: 200).tint(.white)
            }
        }
        .multilineTextAlignment(.center)
    }
}

private struct LyricsScroller: View {
    @ObservedObject var model: LyricsModel
    var shadow: Double

    var body: some View {
        GeometryReader { g in
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 14) {
                        Color.clear.frame(height: g.size.height * 0.35)
                        ForEach(Array(model.lines.enumerated()), id: \.offset) { i, text in
                            let on = i == model.active
                            Text(text)
                                .font(.system(size: model.fontSize + 2, weight: .semibold))
                                .foregroundStyle(.white.opacity(on ? 1 : i < model.active ? 0.28 : 0.4))
                                .scaleEffect(on ? 1 : 0.96, anchor: .leading)
                                .blur(radius: on ? 0 : 0.4)
                                .shadow(color: .black.opacity(shadow), radius: 3)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                                .onTapGesture { model.seek(to: i) }
                                .id(i)
                        }
                        Color.clear.frame(height: g.size.height * 0.55)
                    }
                    .animation(.easeInOut(duration: 0.45), value: model.active)
                }
                .onChange(of: model.active) { _, i in
                    withAnimation(.spring(response: 0.6, dampingFraction: 0.9)) {
                        proxy.scrollTo(max(0, i), anchor: UnitPoint(x: 0, y: 0.38))
                    }
                }
                .onChange(of: model.lines) {
                    proxy.scrollTo(max(0, model.active), anchor: UnitPoint(x: 0, y: 0.38))
                }
                .onAppear { proxy.scrollTo(max(0, model.active), anchor: UnitPoint(x: 0, y: 0.38)) }
            }
        }
    }
}

// MARK: Progress + controls

private struct ProgressRow: View {
    @ObservedObject var model: LyricsModel

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: model.paused)) { ctx in
            let t = model.elapsed(at: ctx.date)
            let d = model.duration
            VStack(spacing: 8) {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.18))
                        Capsule().fill(Color.white)
                            .frame(width: d > 0 ? g.size.width * min(1, t / d) : 0)
                    }
                }
                .frame(height: 5)
                HStack {
                    Text(clock(t))
                    Spacer()
                    Text(d > 0 ? clock(d) : "--:--")
                }
                .font(.system(size: 13, weight: .medium).monospacedDigit())
                .foregroundStyle(.white.opacity(0.55))
            }
        }
    }

    private func clock(_ s: Double) -> String {
        let s = Int(s.rounded(.down))
        return String(format: "%02d:%02d", s / 60, s % 60)
    }
}

private struct Controls: View {
    @ObservedObject var model: LyricsModel

    var body: some View {
        HStack {
            iconButton("backward.end.fill", action: model.previous)
            Spacer()
            Button(action: model.togglePlay) {
                HStack(spacing: 8) {
                    Image(systemName: model.paused ? "play.fill" : "pause.fill")
                        .font(.system(size: 18, weight: .bold))
                        .contentTransition(.symbolEffect(.replace))
                    Text(model.paused ? "Play" : "Pause")
                        .font(.system(size: 18, weight: .semibold))
                }
                .foregroundStyle(.white)
                .frame(width: 150, height: 52)
                .background(Capsule().fill(Color.white.opacity(0.16)))
                .contentShape(Capsule())
            }
            .buttonStyle(PressStyle())
            Spacer()
            iconButton("forward.end.fill", action: model.next)
        }
        .padding(.horizontal, 10)
    }

    private func iconButton(_ name: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
    }
}

/// Small round window button; faint until the cursor is over it.
private struct WindowButton: View {
    let symbol: String
    let help: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.white.opacity(hover ? 1 : 0.6))
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.white.opacity(hover ? 0.22 : 0.1)))
                .contentShape(Circle())
        }
        .buttonStyle(PressStyle())
        .help(help)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
    }
}

private struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .opacity(configuration.isPressed ? 0.75 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// MARK: Current line only

/// Only the line being sung (or the first line, dimmed, before the song starts).
private struct CompactLine: View {
    @ObservedObject var model: LyricsModel
    var ghost = false

    var body: some View {
        ZStack {
            Text(text)
                .font(.system(size: model.fontSize + 4, weight: .bold))
                .foregroundStyle(.white.opacity(dim ? 0.5 : 1))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .shadow(color: .black.opacity(0.6), radius: 3)
                .padding(.horizontal, ghost ? 20 : 106)
                .id(text)
                .transition(.asymmetric(
                    insertion: .offset(y: 14).combined(with: .opacity),
                    removal: .offset(y: -14).combined(with: .opacity)))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .animation(.spring(response: 0.42, dampingFraction: 0.86), value: text)
        .contentShape(Rectangle())
        .onTapGesture { if model.active >= 0 { model.seek(to: model.active) } }
    }

    private var text: String {
        if !model.connected { return "Waiting for YouTube Music…" }
        if let st = model.state?.state { return st.title }
        return model.line(model.active) ?? model.lines.first ?? ""
    }

    private var dim: Bool { !model.connected || model.state?.state != nil || model.active < 0 }
}

/// Thin animated audio bars, settled when paused.
private struct Waveform: View {
    var playing: Bool
    var bars: Int
    var height: CGFloat

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !playing)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: 3) {
                ForEach(0..<bars, id: \.self) { i in
                    let phase = Double(i) * 0.9
                    let a = abs(sin(t * (2.3 + Double(i % 5) * 0.55) + phase))
                    let b = abs(sin(t * 1.3 + phase * 1.7))
                    let v = playing ? 0.25 + 0.75 * (a * 0.7 + b * 0.3) : 0.18
                    Capsule()
                        .fill(Color.white.opacity(0.9))
                        .frame(width: 2, height: max(3, height * v))
                }
            }
            .frame(height: height)
        }
    }
}

private extension Optional where Wrapped == String {
    var nonEmpty: String? { self.flatMap { $0.isEmpty ? nil : $0 } }
}
