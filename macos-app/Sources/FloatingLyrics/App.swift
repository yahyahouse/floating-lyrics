import AppKit
import Carbon
import Combine
import ServiceManagement
import SwiftUI

/// Floating panel: stays above other windows, on every Space and over full-screen apps,
/// without stealing focus from the app you're using.
final class LyricsPanel: NSPanel {
    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 520),
            styleMask: [.titled, .fullSizeContentView, .resizable, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            standardWindowButton(b)?.isHidden = true
        }
        isFloatingPanel = true
        // Above the menu bar so the window can sit right at the top edge (over the notch area too)
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        minSize = NSSize(width: 260, height: 44)
        setFrameAutosaveName("LyricsPanel")
        if !setFrameUsingName("LyricsPanel"), let screen = NSScreen.main {
            let v = screen.visibleFrame
            setFrameOrigin(NSPoint(x: v.maxX - frame.width - 24, y: v.maxY - frame.height - 24))
        }
    }

    // Drag anywhere to move: a press that travels more than a few points moves the window instead
    // of reaching the lyrics/buttons; a plain click still works as usual.
    // A press near an edge resizes from that edge instead.
    private var dragStart: NSPoint?
    private var dragOrigin = NSPoint.zero
    private var dragging = false
    private var resizeEdges: ResizeEdges?
    private var resizeStart = NSRect.zero

    private struct ResizeEdges {
        var left = false, right = false, top = false, bottom = false
    }

    private static let edgeZone: CGFloat = 8

    private func edges(at p: NSPoint) -> ResizeEdges? {
        let z = Self.edgeZone
        let e = ResizeEdges(left: p.x < z, right: p.x > frame.width - z,
                            top: p.y > frame.height - z, bottom: p.y < z)
        return e.left || e.right || e.top || e.bottom ? e : nil
    }

    private func resize(_ e: ResizeEdges, dx: CGFloat, dy: CGFloat) {
        let s = resizeStart
        var f = s
        if e.right { f.size.width = max(minSize.width, s.width + dx) }
        if e.left {
            f.size.width = max(minSize.width, s.width - dx)
            f.origin.x = s.maxX - f.width
        }
        if e.top { f.size.height = max(minSize.height, s.height + dy) }
        if e.bottom {
            f.size.height = max(minSize.height, s.height - dy)
            f.origin.y = s.maxY - f.height
        }
        setFrame(f, display: true)
    }

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            dragStart = NSEvent.mouseLocation
            dragOrigin = frame.origin
            dragging = false
            resizeEdges = edges(at: event.locationInWindow)
            resizeStart = frame
            if resizeEdges != nil { return }
        case .leftMouseDragged:
            if let start = dragStart {
                let p = NSEvent.mouseLocation
                let dx = p.x - start.x, dy = p.y - start.y
                if let e = resizeEdges {
                    resize(e, dx: dx, dy: dy)
                    return
                }
                if !dragging && hypot(dx, dy) > 4 { dragging = true }
                if dragging {
                    var f = frame
                    f.origin = NSPoint(x: dragOrigin.x + dx, y: dragOrigin.y + dy)
                    setFrameOrigin(constrainFrameRect(f, to: screen).origin)
                    return
                }
            }
        case .leftMouseUp:
            let wasDragging = dragging
            let wasResizing = resizeEdges != nil
            dragStart = nil
            dragging = false
            resizeEdges = nil
            if wasResizing { return }
            if wasDragging {
                // Release far outside the window so the pressed button / line doesn't fire
                if let cancel = NSEvent.mouseEvent(
                    with: .leftMouseUp, location: NSPoint(x: -10_000, y: -10_000),
                    modifierFlags: event.modifierFlags, timestamp: event.timestamp,
                    windowNumber: windowNumber, context: nil, eventNumber: event.eventNumber,
                    clickCount: event.clickCount, pressure: 0
                ) {
                    super.sendEvent(cancel)
                }
                return
            }
        default:
            break
        }
        super.sendEvent(event)
    }

    /// AppKit normally keeps windows below the menu bar; only stop at the top edge of the screen.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        let s = (screen ?? self.screen ?? NSScreen.main)?.frame
        guard let top = s?.maxY else { return frameRect }
        var r = frameRect
        if r.maxY > top { r.origin.y = top - r.height }
        return r
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model = LyricsModel()
    private let prefs = Prefs()
    private var server: LyricsServer!
    private let updater = Updater()
    private var panel: LyricsPanel!
    private var statusItem: NSStatusItem!
    private var subs = Set<AnyCancellable>()
    @AppStorage("userHidden") private var userHidden = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        server = LyricsServer(model: model)
        server.start()

        panel = LyricsPanel()
        let host = NSHostingView(rootView: LyricsView(model: model, prefs: prefs,
                                                  onHide: { [weak self] in self?.setUserHidden(true) },
                                                  onSearch: { [weak self] in self?.openSearch() }))
        host.wantsLayer = true
        panel.contentView = host
        applyGhost()
        // ⌥⌘L toggles Ghost Mode from anywhere (the window can't be clicked while it's on)
        ghostKey = HotKey(id: 1, keyCode: kVK_ANSI_L, modifiers: cmdKey | optionKey) { [weak self] in
            self?.toggleClickThrough()
        }
        // ⌥⌘K tucks the window into the menu bar and brings it back
        hideKey = HotKey(id: 2, keyCode: kVK_ANSI_K, modifiers: cmdKey | optionKey) { [weak self] in
            self?.toggleWindow()
        }

        setupStatusItem()

        // Show/hide follows the extension's "Show floating lyrics" switch and the menu toggle
        model.$state
            .map { $0?.visible ?? true }
            .removeDuplicates()
            .sink { [weak self] _ in DispatchQueue.main.async { self?.updateVisibility() } }
            .store(in: &subs)
        // Minimize ↔ expand: shrink the window to one line and back, keeping its top edge in place
        lastCompact = prefs.compact
        prefs.objectWillChange
            .sink { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.applyGhost()
                    guard self.prefs.compact != self.lastCompact else { return }
                    self.lastCompact = self.prefs.compact
                    self.resizeForCompact(self.prefs.compact)
                }
            }
            .store(in: &subs)
        model.$connected
            .sink { [weak self] _ in DispatchQueue.main.async { self?.rebuildMenu() } }
            .store(in: &subs)

        updateVisibility()

        // Check for updates 10 seconds after launch, then every 6 hours
        updater.onChange = { [weak self] in self?.rebuildMenu() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in self?.updater.check(manual: false) }
        Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updater.check(manual: false) }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        setUserHidden(false)
        return true
    }

    private func updateVisibility() {
        guard !animating else { return }
        let allowed = model.state?.visible ?? true
        if !userHidden && allowed { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
        rebuildMenu()
    }

    @AppStorage("expandedHeight") private var expandedHeight: Double = 520
    @AppStorage("compactHeight") private var compactHeight: Double = 60
    private var lastCompact = false
    private var ghostKey: HotKey?
    private var hideKey: HotKey?
    private var animating = false
    private var ghostTimer: Timer?
    private var ghostFaded = false

    /// Ghost Mode: the lyrics fade away while the cursor is over them, so what's underneath shows.
    /// The window ignores the mouse, so the cursor position is polled (only while Ghost Mode is on).
    private func updateGhostHover() {
        if prefs.clickThrough {
            guard ghostTimer == nil else { return }
            ghostTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.ghostTick() }
            }
        } else {
            ghostTimer?.invalidate()
            ghostTimer = nil
            if ghostFaded { setGhostFaded(false) }
        }
    }

    private func ghostTick() {
        guard panel.isVisible, !animating else { return }
        let over = panel.frame.insetBy(dx: -6, dy: -6).contains(NSEvent.mouseLocation)
        if over != ghostFaded { setGhostFaded(over) }
    }

    private func setGhostFaded(_ faded: Bool) {
        ghostFaded = faded
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = faded ? 0.18 : 0.35
            ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().alphaValue = faded ? 0 : 1
        }
    }
    private var menuTheme: Theme?

    /// Ghost Mode: clicks pass straight through to whatever is underneath, and the card goes see-through.
    private func applyGhost() {
        let shadow = !prefs.clickThrough && prefs.theme != .transparent
        let changed = panel.ignoresMouseEvents != prefs.clickThrough || panel.hasShadow != shadow || menuTheme != prefs.theme
        guard changed else { return }
        panel.ignoresMouseEvents = prefs.clickThrough
        panel.hasShadow = shadow
        panel.invalidateShadow()
        updateGhostHover()
        menuTheme = prefs.theme
        rebuildMenu()
    }

    private func resizeForCompact(_ compact: Bool) {
        var f = panel.frame
        let top = f.maxY
        if compact {
            expandedHeight = f.height
            f.size.height = max(44, compactHeight)
        } else {
            compactHeight = f.height
            f.size.height = max(260, expandedHeight)
        }
        f.origin.y = top - f.height
        panel.setFrame(f, display: true, animate: true)
        rebuildMenu()
    }

    // MARK: Menu bar

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "music.note.list", accessibilityDescription: "Floating Lyrics")
        rebuildMenu()
    }

    private func rebuildMenu() {
        guard statusItem != nil else { return }
        let menu = NSMenu()

        let status: String
        if let err = model.serverError { status = err }
        else if model.connected { status = "Connected to Chrome" }
        else { status = "Waiting for the Chrome extension…" }
        let st = NSMenuItem(title: status, action: nil, keyEquivalent: "")
        st.isEnabled = false
        menu.addItem(st)
        menu.addItem(.separator())

        let show = item("Show Lyrics Window", #selector(toggleWindow), on: !userHidden, key: "k")
        show.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(show)
        menu.addItem(item("Minimize (Current Line Only)", #selector(toggleCompact), on: prefs.compact, key: "m"))
        let themeItem = NSMenuItem(title: "Theme", action: nil, keyEquivalent: "")
        let themeMenu = NSMenu()
        for t in Theme.allCases {
            let i = item(t.title, #selector(pickTheme(_:)), on: prefs.theme == t, key: "")
            i.representedObject = t.rawValue
            themeMenu.addItem(i)
        }
        themeItem.submenu = themeMenu
        menu.addItem(themeItem)
        let sizeItem = NSMenuItem(title: "Text Size", action: nil, keyEquivalent: "")
        let sizeMenu = NSMenu()
        for s in Prefs.fontSizes {
            let i = item("\(Int(s)) pt", #selector(pickFontSize(_:)), on: prefs.fontSize == s, key: "")
            i.representedObject = s
            sizeMenu.addItem(i)
        }
        sizeItem.submenu = sizeMenu
        menu.addItem(sizeItem)
        let ghost = item("Ghost Mode (click-through, transparent)", #selector(toggleClickThrough), on: prefs.clickThrough, key: "l")
        ghost.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(ghost)
        let find = item("Search Lyrics…", #selector(openSearch), on: false, key: "f")
        find.isEnabled = model.connected
        menu.addItem(find)
        let play = item("Play / Pause", #selector(togglePlay), on: false, key: "p")
        play.isEnabled = model.connected
        menu.addItem(play)
        menu.addItem(.separator())
        menu.addItem(item("Open at Login", #selector(toggleLogin), on: SMAppService.mainApp.status == .enabled, key: ""))
        menu.addItem(.separator())

        let version = NSMenuItem(title: "Version \(updater.currentVersion)", action: nil, keyEquivalent: "")
        version.isEnabled = false
        menu.addItem(version)
        if !updater.status.isEmpty {
            let st = NSMenuItem(title: updater.status, action: nil, keyEquivalent: "")
            st.isEnabled = false
            menu.addItem(st)
        }
        menu.addItem(item("Check for Updates", #selector(checkForUpdates), on: false, key: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Floating Lyrics", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        statusItem.menu = menu
    }

    private func item(_ title: String, _ action: Selector, on: Bool, key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        i.state = on ? .on : .off
        return i
    }

    @objc private func toggleWindow() {
        setUserHidden(!userHidden)
    }

    // MARK: Hide to / show from the menu bar

    /// Small rect just under the menu bar icon: where the window shrinks into / grows out of.
    private var statusTarget: NSRect {
        if let r = statusItem.button?.window?.frame {
            return NSRect(x: r.midX - 24, y: r.minY - 16, width: 48, height: 16)
        }
        let s = NSScreen.main?.frame ?? .zero
        return NSRect(x: s.maxX - 60, y: s.maxY - 40, width: 48, height: 16)
    }

    func setUserHidden(_ hidden: Bool) {
        guard !animating else { return }
        userHidden = hidden
        let allowed = model.state?.visible ?? true
        if hidden { if panel.isVisible { animateOut() } }
        else if allowed && !panel.isVisible { animateIn() }
        rebuildMenu()
    }

    private func animateOut() {
        ghostFaded = false
        let saved = panel.frame
        animating = true
        panel.setFrameAutosaveName("") // don't remember the shrunken frame
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.32
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.5, 0, 0.75, 0.4)
            panel.animator().setFrame(statusTarget, display: true)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.panel.orderOut(nil)
                self.panel.setFrame(saved, display: false)
                self.panel.alphaValue = 1
                self.panel.setFrameAutosaveName("LyricsPanel")
                self.animating = false
            }
        })
    }

    private func animateIn() {
        let target = panel.frame
        animating = true
        panel.setFrameAutosaveName("")
        panel.alphaValue = 0
        panel.setFrame(statusTarget, display: false)
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.38
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
            panel.animator().setFrame(target, display: true)
            panel.animator().alphaValue = 1
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.panel.setFrame(target, display: true)
                self.panel.setFrameAutosaveName("LyricsPanel")
                self.animating = false
            }
        })
    }

    @objc private func toggleCompact() {
        prefs.compact.toggle()
    }

    @objc private func toggleClickThrough() {
        prefs.clickThrough.toggle()
        applyGhost()
    }

    @objc private func pickTheme(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let t = Theme(rawValue: raw) else { return }
        prefs.theme = t
    }

    @objc private func pickFontSize(_ sender: NSMenuItem) {
        guard let s = sender.representedObject as? Double else { return }
        prefs.fontSize = s
        rebuildMenu()
    }

    @objc private func checkForUpdates() { updater.check(manual: true) }

    @objc private func togglePlay() { model.togglePlay() }

    // MARK: Lyrics search

    private var searchWindow: NSWindow?

    /// Wrong or missing lyrics? Search LRCLIB and pick the right result (like 🔍 in the extension).
    @objc func openSearch() {
        guard model.connected else { NSSound.beep(); return }
        let w = searchWindow ?? {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 440),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            w.title = "Search Lyrics"
            w.isReleasedWhenClosed = false
            w.level = .statusBar // the lyrics window sits at this level too; keep the search on top
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            w.setFrameAutosaveName("SearchWindow")
            if !w.setFrameUsingName("SearchWindow") { w.center() }
            searchWindow = w
            return w
        }()
        // Fresh view each time: the fields start from the song playing now
        w.contentView = NSHostingView(rootView: SearchView(model: model, onDone: { [weak w] in w?.close() }))
        NSApp.activate()
        w.makeKeyAndOrderFront(nil)
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            NSSound.beep()
        }
        rebuildMenu()
    }
}

@main
enum FloatingLyricsApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
        app.run()
    }
}
