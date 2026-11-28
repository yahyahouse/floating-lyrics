import Foundation
import Network

/// Local WebSocket server the Chrome extension connects to (ws://127.0.0.1:47321).
/// Only loopback, and only connections whose Origin is a Chrome extension are accepted.
@MainActor
final class LyricsServer {
    static let port: UInt16 = 47321

    private let model: LyricsModel
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var pingTimer: Timer?

    init(model: LyricsModel) {
        self.model = model
        model.sendCommand = { [weak self] obj in self?.broadcast(obj) }
    }

    func start() {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = 4 * 1024 * 1024
        ws.setClientRequestHandler(.main) { _, headers in
            let origin = headers.first { $0.name.lowercased() == "origin" }?.value ?? ""
            let ok = origin.hasPrefix("chrome-extension://")
            return NWProtocolWebSocket.Response(status: ok ? .accept : .reject, subprotocol: nil, additionalHeaders: nil)
        }

        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)

        do {
            let listener = try NWListener(using: params)
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self else { return }
                    if case .failed(let err) = state {
                        self.model.serverError = "Port \(Self.port) unavailable: \(err.localizedDescription)"
                    } else if case .ready = state {
                        self.model.serverError = nil
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] conn in
                Task { @MainActor in self?.accept(conn) }
            }
            listener.start(queue: .main)
            self.listener = listener
        } catch {
            model.serverError = "Could not start server: \(error.localizedDescription)"
        }

        // Regular traffic keeps the extension's service worker (and so the connection) alive.
        pingTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.broadcast(["type": "ping"]) }
        }
    }

    private func accept(_ conn: NWConnection) {
        let id = ObjectIdentifier(conn)
        connections[id] = conn
        conn.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .ready:
                    self.updateConnected()
                case .failed, .cancelled:
                    self.connections[id] = nil
                    self.updateConnected()
                default:
                    break
                }
            }
        }
        conn.start(queue: .main)
        receive(on: conn)
    }

    private func receive(on conn: NWConnection) {
        conn.receiveMessage { [weak self] data, context, _, error in
            Task { @MainActor in
                guard let self else { return }
                if error != nil {
                    conn.cancel()
                    return
                }
                let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
                if meta?.opcode == .close {
                    conn.cancel()
                    return
                }
                if let data, meta?.opcode == .text {
                    self.handle(data)
                }
                self.receive(on: conn)
            }
        }
    }

    private func handle(_ data: Data) {
        guard let msg = try? JSONDecoder().decode(IncomingMessage.self, from: data) else { return }
        if msg.type == "state" {
            model.receivedAt = Date()
            if model.state != msg.state { model.state = msg.state }
        } else if msg.type == "search" {
            model.receiveSearch(msg)
        }
    }

    private func broadcast(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "msg", metadata: [meta])
        for conn in connections.values where conn.state == .ready {
            conn.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
        }
    }

    private func updateConnected() {
        let any = connections.values.contains { $0.state == .ready }
        model.connected = any
        if !any { model.state = nil }
    }
}
