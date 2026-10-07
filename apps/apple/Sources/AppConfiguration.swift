import Foundation

struct AppConfiguration {
    static let origin = URL(string: Bundle.main.object(forInfoDictionaryKey: "AssistantAppOrigin") as? String
        ?? "https://assistant.example.com/")!

    static func normalizedPort(_ port: Int?, scheme: String?) -> Int {
        if let port, port != 0 { return port }
        return scheme == "https" ? 443 : scheme == "http" ? 80 : -1
    }
    static func matchesOrigin(scheme: String, host: String, port: Int) -> Bool {
        ["https", "http"].contains(scheme) && scheme == origin.scheme && host == origin.host &&
            normalizedPort(port, scheme: scheme) == normalizedPort(origin.port, scheme: origin.scheme)
    }

    static func isAppURL(_ url: URL) -> Bool {
        url.scheme == origin.scheme && url.host == origin.host &&
        normalizedPort(url.port, scheme: url.scheme) == normalizedPort(origin.port, scheme: origin.scheme) && url.user == nil && url.password == nil
    }

    static func resultURL(_ value: String) -> URL? {
        guard let url = URL(string: value, relativeTo: origin)?.absoluteURL, isAppURL(url), url.path == "/",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let items = components.queryItems ?? []
        guard items.allSatisfy({ ["conversation", "message"].contains($0.name) }) else { return nil }
        let conversations = items.filter { $0.name == "conversation" }
        let messages = items.filter { $0.name == "message" }
        guard conversations.count == 1, messages.count <= 1,
              UUID(uuidString: conversations[0].value ?? "") != nil,
              messages.allSatisfy({ UUID(uuidString: $0.value ?? "") != nil }) else { return nil }
        return url
    }
}
