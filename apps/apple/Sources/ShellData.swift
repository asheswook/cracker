import Foundation
import WebKit
import Combine

struct ShellConversation: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let created_at: String
    let preview: String?
    let last_message_at: String?
    let message_count: Int?
    var date: Date? { ShellDate.parse(last_message_at ?? created_at) }
    var displayTitle: String { title.isEmpty ? "대화" : title }
}

enum ShellDate {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

enum ShellPanel: String, CaseIterable, Identifiable {
    case tasks, schedules, memory, notifications, computer, settings
    var id: String { rawValue }
    var title: String {
        switch self {
        case .tasks: return "작업"
        case .schedules: return "예약"
        case .memory: return "기억"
        case .notifications: return "알림"
        case .computer: return "컴퓨터"
        case .settings: return "설정"
        }
    }
    var symbol: String {
        switch self {
        case .tasks: return "checklist"
        case .schedules: return "calendar"
        case .memory: return "brain"
        case .notifications: return "bell"
        case .computer: return "desktopcomputer"
        case .settings: return "gearshape"
        }
    }
    var endpoint: String? {
        switch self {
        case .tasks: return "tasks"
        case .schedules: return "schedules"
        case .memory: return "memory"
        case .computer: return "vms"
        default: return nil
        }
    }
    var collection: String { self == .memory ? "memories" : endpoint ?? "" }
}

/// The four read-only list responses share these optional display fields.
struct ShellRecord: Decodable, Identifiable {
    let id: String
    let objective: String?
    let text: String?
    let name: String?
    let state: String?
    let status: String?
    let online: Bool?
    let conversation_id: String?
    let source_message_id: String?
    let due_at: String?
    let updated_at: String?
    let created_at: String?
    let last_seen_at: String?
    var title: String { objective ?? text ?? name ?? "항목" }
    var date: Date? { (due_at ?? updated_at ?? last_seen_at ?? created_at).flatMap(ShellDate.parse) }
    var detail: String? {
        if let online { return online ? "연결돼 있어요" : "연결되지 않았어요" }
        guard let value = state ?? status else { return nil }
        return ["queued": "대기 중이에요", "running": "진행 중이에요", "completed": "완료했어요",
                "done": "완료했어요", "failed": "완료하지 못했어요", "cancelled": "취소했어요",
                "canceled": "취소했어요", "scheduled": "예약돼 있어요", "pending": "대기 중이에요",
                "stopped": "중지했어요", "waiting": "기다리고 있어요"][value] ?? value
    }
}

enum ShellAPIError: LocalizedError {
    case signIn, unavailable, response
    var errorDescription: String? {
        switch self {
        case .signIn: return "연결이 만료됐어요. 대화 화면에서 다시 연결해 주세요."
        case .unavailable: return "목록을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요."
        case .response: return "서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요."
        }
    }
}

/// Never persist credentials separately or forward session cookies across redirects.
private final class ShellRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class ShellData: ObservableObject {
    @Published private(set) var conversations: [ShellConversation] = []
    @Published private(set) var records: [ShellPanel: [ShellRecord]] = [:]
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var loading: Set<String> = []
    private var epoch = 0
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 15
        return URLSession(configuration: config, delegate: ShellRedirectPolicy(), delegateQueue: nil)
    }()
    deinit { session.invalidateAndCancel() }

    func clear() {
        epoch += 1; conversations = []; records = [:]; errors = [:]; loading = []
    }
    func fetch<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        guard let url = URL(string: "/v1/\(path)", relativeTo: AppConfiguration.origin), AppConfiguration.isAppURL(url) else { throw ShellAPIError.unavailable }
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        let host = url.host ?? ""
        let valid = cookies.filter {
            let domain = $0.domain.hasPrefix(".") ? String($0.domain.dropFirst()) : $0.domain
            return (host == domain || ($0.domain.hasPrefix(".") && host.hasSuffix(".\(domain)"))) &&
                (!$0.isSecure || url.scheme == "https") &&
                (url.path == $0.path || url.path.hasPrefix($0.path.hasSuffix("/") ? $0.path : $0.path + "/")) &&
                ($0.expiresDate.map { $0 > Date() } ?? true)
        }
        var request = URLRequest(url: url)
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: valid)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShellAPIError.response }
        if http.statusCode == 401 || http.statusCode == 403 { throw ShellAPIError.signIn }
        guard (200..<300).contains(http.statusCode) else { throw ShellAPIError.unavailable }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw ShellAPIError.response }
    }
    func refreshConversations() async {
        let key = "conversations", generation = epoch
        guard !loading.contains(key) else { return }
        loading.insert(key)
        defer { if generation == epoch { loading.remove(key) } }
        do {
            struct Response: Decodable { let conversations: [ShellConversation] }
            let result = try await fetch(key, as: Response.self)
            guard generation == epoch, !Task.isCancelled else { return }
            conversations = result.conversations.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
            errors[key] = nil
        } catch {
            guard generation == epoch, !Task.isCancelled else { return }
            errors[key] = (error as? ShellAPIError)?.localizedDescription ?? ShellAPIError.unavailable.localizedDescription
        }
    }
    func refresh(_ panel: ShellPanel) async {
        guard let path = panel.endpoint, !loading.contains(panel.id) else { return }
        let generation = epoch
        loading.insert(panel.id)
        defer { if generation == epoch { loading.remove(panel.id) } }
        do {
            let result = try await fetch(path, as: [String: [ShellRecord]].self)
            guard generation == epoch, !Task.isCancelled else { return }
            records[panel] = result[panel.collection] ?? []
            errors[panel.id] = nil
        } catch {
            guard generation == epoch, !Task.isCancelled else { return }
            errors[panel.id] = (error as? ShellAPIError)?.localizedDescription ?? ShellAPIError.unavailable.localizedDescription
        }
    }
}
