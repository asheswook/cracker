#if os(macOS)
import AppKit
import Network

@MainActor
final class LocalModelLogin {
    typealias Reply = (Any?, String?) -> Void
    @MainActor private final class Session {
        let id = UUID().uuidString
        let listener: NWListener
        var redirect: String?
        var state: String?
        var prepared: Reply?
        var callback: Reply?
        var timeout: Task<Void, Never>?
        var connections: [ObjectIdentifier: NWConnection] = [:]
        init(listener: NWListener, reply: @escaping Reply) { self.listener = listener; prepared = reply }
    }
    private var session: Session?
    private let openBrowser: (URL) -> Bool
    init(openBrowser: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }) { self.openBrowser = openBrowser }

    func prepare(reply: @escaping Reply) {
        guard session == nil else { reply(nil, "A local login is already in progress."); return }
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            let listener = try NWListener(using: parameters, on: .any)
            let current = Session(listener: listener, reply: reply)
            session = current
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self, self.session === current else { return }
                    switch state {
                    case .ready:
                        guard let port = listener.port else { self.fail("Local login listener unavailable."); return }
                        let redirect = "http://127.0.0.1:\(port.rawValue)/auth/callback"
                        current.redirect = redirect
                        current.prepared?(["version": 1, "session_id": current.id, "redirect_uri": redirect], nil)
                        current.prepared = nil
                    case .failed: self.fail("Local login listener unavailable.")
                    default: break
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.receive(connection, session: current) }
            }
            current.timeout = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 300_000_000_000) }
                catch { return }
                guard let self, self.session === current else { return }
                self.fail("Local login timed out.")
            }
            listener.start(queue: .main)
        } catch { reply(nil, "Local login listener unavailable.") }
    }

    func authorize(id: String, value: String, reply: @escaping Reply) {
        guard let current = session, current.id == id, current.callback == nil,
              let redirect = current.redirect, let url = URL(string: value),
              url.scheme == "https", url.host == "auth.openai.com", url.port == nil,
              url.path == "/api/accounts/authorize", url.user == nil, url.password == nil, url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            reply(nil, "Invalid local login request."); return
        }
        let items = components.queryItems ?? []
        let parameter = { (name: String) -> String? in
            let matches = items.filter { $0.name == name }
            return matches.count == 1 ? matches[0].value : nil
        }
        guard parameter("redirect_uri") == redirect, parameter("response_type") == "code",
              parameter("code_challenge_method") == "S256", parameter("code_challenge")?.count == 43,
              parameter("nonce") != nil, parameter("id_token_hint") == nil,
              let state = parameter("state"), state.count >= 16 else {
            reply(nil, "Invalid local login request."); return
        }
        current.state = state
        current.callback = reply
        if !openBrowser(url) { fail("The system browser could not be opened.") }
    }

    func cancel(id: String) {
        guard session?.id == id else { return }
        fail("Local login cancelled.")
    }

    private func receive(_ connection: NWConnection, session current: Session) {
        guard session === current, current.connections.count < 8 else { connection.cancel(); return }
        current.connections[ObjectIdentifier(connection)] = connection
        connection.start(queue: .main)
        Task { try? await Task.sleep(nanoseconds: 5_000_000_000); connection.cancel() }
        read(connection, session: current, bytes: Data())
    }
    private func read(_ connection: NWConnection, session current: Session, bytes: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self, self.session === current else { connection.cancel(); return }
                var accumulated = bytes
                if let data { accumulated.append(data) }
                guard accumulated.count <= 8192, error == nil else { self.respond(connection, status: "400 Bad Request"); return }
                if let text = String(data: accumulated, encoding: .utf8), text.contains("\r\n\r\n") {
                    self.handle(text, connection: connection, session: current)
                } else if complete { self.respond(connection, status: "400 Bad Request") }
                else { self.read(connection, session: current, bytes: accumulated) }
            }
        }
    }
    private func handle(_ text: String, connection: NWConnection, session current: Session) {
        let line = text.components(separatedBy: "\r\n").first?.split(separator: " ") ?? []
        guard line.count == 3, line[0] == "GET", line[1].hasPrefix("/auth/callback?"),
              let components = URLComponents(string: "http://127.0.0.1\(line[1])"),
              components.path == "/auth/callback", current.callback != nil else {
            respond(connection, status: "400 Bad Request"); return
        }
        var payload: [String: String] = [:]
        for item in components.queryItems ?? [] where ["state", "code", "client_id", "error"].contains(item.name) {
            guard payload[item.name] == nil, let value = item.value, value.count <= 4096 else { respond(connection, status: "400 Bad Request"); return }
            payload[item.name] = value
        }
        guard let state = payload["state"], state == current.state,
              (payload["code"] != nil) != (payload["error"] != nil) else {
            respond(connection, status: "400 Bad Request"); return
        }
        respond(connection, status: "200 OK", body: "Sign-in received. You can return to Assistant.") { [weak self] in
            guard let self, self.session === current else { return }
            current.callback?(["version": 1, "session_id": current.id, "callback": payload], nil)
            current.callback = nil
            self.clear()
        }
    }
    private func respond(_ connection: NWConnection, status: String, body: String = "Invalid callback.", completion: (() -> Void)? = nil) {
        let content = "HTTP/1.1 \(status)\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
        connection.send(content: Data(content.utf8), completion: .contentProcessed { [weak self] _ in
            Task { @MainActor in
                self?.session?.connections.removeValue(forKey: ObjectIdentifier(connection))
                connection.cancel(); completion?()
            }
        })
    }
    private func fail(_ message: String) {
        session?.prepared?(nil, message); session?.callback?(nil, message)
        clear()
    }
    private func clear() {
        session?.timeout?.cancel(); session?.listener.cancel()
        for connection in session?.connections.values ?? [:].values { connection.cancel() }
        session = nil
    }
}
#endif
