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
    static let locale = Locale(identifier: "ko_KR")
    static func dueLabel(_ date: Date) -> String {
        date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale))
    }
    static func listLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale)) }
        if calendar.isDateInYesterday(date) { return "어제" }
        if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day, days < 7 {
            return date.formatted(.dateTime.weekday(.wide).locale(locale))
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) { return date.formatted(.dateTime.month().day().locale(locale)) }
        return date.formatted(Date.FormatStyle(date: .numeric, time: .omitted).locale(locale))
    }
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

enum ShellPanel: String, CaseIterable, Identifiable {
    case attention, tasks, schedules, memory, computer, settings, notifications
    var id: String { rawValue }
    var title: String {
        switch self {
        case .attention: return "피드"
        case .tasks: return "맡긴 일"
        case .schedules: return "예약"
        case .memory: return "기억"
        case .notifications: return "알림"
        case .computer: return "컴퓨터"
        case .settings: return "설정"
        }
    }
    var symbol: String {
        switch self {
        case .attention: return "dot.radiowaves.up.forward"
        case .tasks: return "checklist"
        case .schedules: return "calendar"
        case .memory: return "brain"
        case .notifications: return "bell"
        case .computer: return "desktopcomputer"
        case .settings: return "gearshape"
        }
    }
    var webPanel: String { rawValue }
    var compact: Bool { self == .notifications }
    init?(webName: String) {
        switch webName {
        case "attention": self = .attention
        case "tasks": self = .tasks
        case "schedules": self = .schedules
        case "memory": self = .memory
        case "computer": self = .computer
        case "settings": self = .settings
        #if os(iOS)
        case "notifications": self = .notifications
        #endif
        default: return nil
        }
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

@MainActor
final class ShellData: ObservableObject {
    @Published private(set) var conversations: [ShellConversation] = []
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var loading: Set<String> = []
    private var epoch = 0
    func clear() {
        epoch += 1; conversations = []; errors = [:]; loading = []
    }
    weak var webView: WKWebView?
    /// Reads through the conversation web view so the request uses exactly the session the web app holds.
    func fetch<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        guard let webView, let current = webView.url, AppConfiguration.isAppURL(current) else { throw ShellAPIError.unavailable }
        let script = """
        const response = await fetch('/v1/' + path, { credentials: 'include', headers: { accept: 'application/json' }, cache: 'no-store' });
        return { status: response.status, body: response.ok ? await response.text() : '' };
        """
        let value: Any = try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(script, arguments: ["path": path], in: nil, in: .page) { continuation.resume(with: $0) }
        }
        guard let result = value as? [String: Any], let status = (result["status"] as? NSNumber)?.intValue else { throw ShellAPIError.response }
        if status == 401 || status == 403 { throw ShellAPIError.signIn }
        guard (200..<300).contains(status), let body = (result["body"] as? String)?.data(using: .utf8) else { throw ShellAPIError.unavailable }
        do { return try JSONDecoder().decode(T.self, from: body) }
        catch { throw ShellAPIError.response }
    }
    func send(_ path: String, method: String) async throws {
        guard let webView, let current = webView.url, AppConfiguration.isAppURL(current) else { throw ShellAPIError.unavailable }
        let script = """
        const response = await fetch('/v1/' + path, { method, credentials: 'include', headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
        return response.status;
        """
        let value: Any = try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(script, arguments: ["path": path, "method": method], in: nil, in: .page) { continuation.resume(with: $0) }
        }
        guard let status = (value as? NSNumber)?.intValue else { throw ShellAPIError.response }
        if status == 401 || status == 403 { throw ShellAPIError.signIn }
        guard (200..<300).contains(status) else { throw ShellAPIError.unavailable }
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
}
