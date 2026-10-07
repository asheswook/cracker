import Foundation

enum CheckFailure: Error { case failed }
@main struct LocalLoginChecks {
    @MainActor static func main() async throws {
        var opened: URL?
        let login = LocalModelLogin(openBrowser: { opened = $0; return true })
        let prepared = try await prepare(login)
        guard let id = prepared["session_id"] as? String, let redirect = prepared["redirect_uri"] as? String else { throw CheckFailure.failed }
        let state = "fixture-state-123456789"
        let url = authorization(redirect: redirect, state: state)
        let callback = Task { @MainActor in try await authorize(login, id: id, url: url) }
        try await Task.sleep(nanoseconds: 50_000_000)
        guard opened == url else { throw CheckFailure.failed }
        let (_, wrong) = try await URLSession.shared.data(from: URL(string: redirect + "?state=wrong&code=synthetic")!)
        guard (wrong as? HTTPURLResponse)?.statusCode == 400 else { throw CheckFailure.failed }
        let (_, duplicate) = try await URLSession.shared.data(from: URL(string: redirect + "?state=\(state)&state=\(state)&code=synthetic")!)
        guard (duplicate as? HTTPURLResponse)?.statusCode == 400 else { throw CheckFailure.failed }
        let (_, accepted) = try await URLSession.shared.data(from: URL(string: redirect + "?state=\(state)&code=synthetic&client_id=fixture")!)
        guard (accepted as? HTTPURLResponse)?.statusCode == 200,
              let payload = try await callback.value["callback"] as? [String: String], payload["code"] == "synthetic" else { throw CheckFailure.failed }
        print("PASS: loopback listener, system-browser request, wrong state, duplicate state, callback and cleanup")
        let second = try await prepare(login)
        guard let nextId = second["session_id"] as? String, let nextRedirect = second["redirect_uri"] as? String else { throw CheckFailure.failed }
        do { _ = try await authorize(login, id: nextId, url: URL(string: "https://evil.example/")!); throw CheckFailure.failed }
        catch CheckFailure.failed { throw CheckFailure.failed }
        catch { }
        let cancelled = Task { @MainActor in try await authorize(login, id: nextId, url: authorization(redirect: nextRedirect, state: state)) }
        try await Task.sleep(nanoseconds: 50_000_000)
        login.cancel(id: nextId)
        do { _ = try await cancelled.value; throw CheckFailure.failed }
        catch CheckFailure.failed { throw CheckFailure.failed }
        catch { }
        print("PASS: foreign authorization rejected and cancellation closes local login")
    }
    @MainActor static func prepare(_ login: LocalModelLogin) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            login.prepare { value, error in
                if let error { continuation.resume(throwing: NSError(domain: error, code: 1)); return }
                guard let value = value as? [String: Any] else { continuation.resume(throwing: CheckFailure.failed); return }
                continuation.resume(returning: value)
            }
        }
    }
    @MainActor static func authorize(_ login: LocalModelLogin, id: String, url: URL) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            login.authorize(id: id, value: url.absoluteString) { value, error in
                if let error { continuation.resume(throwing: NSError(domain: error, code: 1)); return }
                guard let value = value as? [String: Any] else { continuation.resume(throwing: CheckFailure.failed); return }
                continuation.resume(returning: value)
            }
        }
    }
    static func authorization(redirect: String, state: String) -> URL {
        var url = URLComponents(string: "https://auth.openai.com/api/accounts/authorize")!
        url.queryItems = [URLQueryItem(name: "redirect_uri", value: redirect), URLQueryItem(name: "state", value: state), URLQueryItem(name: "nonce", value: "fixture-nonce"), URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "code_challenge_method", value: "S256"), URLQueryItem(name: "code_challenge", value: String(repeating: "a", count: 43))]
        return url.url!
    }
}
