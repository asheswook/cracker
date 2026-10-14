import Foundation
import Combine

struct TaskItem: Decodable, Identifiable, Hashable {
    let id: String
    let conversation_id: String
    let objective: String
    let state: String
    let reason: String?
    let created_at: String
    let updated_at: String
    var created: Date? { ShellDate.parse(created_at) }
    var active: Bool { ["queued", "running", "waiting", "pausing", "paused", "cancelling", "unknown"].contains(state) }
    var stateLabel: String {
        ["queued": "대기 중", "running": "진행 중", "waiting": "응답 대기", "pausing": "일시 정지 중", "paused": "일시 정지",
         "cancelling": "중지 중", "cancelled": "취소됨", "succeeded": "완료", "failed": "실패", "unknown": "확인 필요"][state] ?? state
    }
}

struct TaskNavigationTarget: Decodable {
    let task_id: String
    let conversation_id: String
    let request_message_id: String?
    let reply_message_id: String?
}

struct Responsibility: Decodable, Identifiable, Hashable {
    struct Trigger: Decodable, Hashable {
        let kind: String
        let hour: Int?
        let minute: Int?
        let timezone: String?
        let interval_minutes: Int?
        let due_at: String?
    }
    struct LastAction: Decodable, Hashable { let state: String; let task: TaskItem? }
    let id: String
    let objective: String
    let state: String
    let trigger: Trigger
    let next_review_at: String
    let last_error: String?
    let last_action: LastAction?
    var nextReview: Date? { ShellDate.parse(next_review_at) }
    var triggerLabel: String {
        switch trigger.kind {
        case "daily": return String(format: "매일 %02d:%02d", trigger.hour ?? 0, trigger.minute ?? 0)
        case "periodic":
            let minutes = trigger.interval_minutes ?? 0
            return minutes % 60 == 0 ? "\(minutes / 60)시간마다" : "\(minutes)분마다"
        case "deadline": return "기한까지 확인"
        case "task_change": return "작업 상태가 바뀔 때"
        default: return "반복"
        }
    }
}

struct OneOffSchedule: Decodable, Identifiable, Hashable {
    let id: String
    let objective: String
    let due_at: String
    let status: String
    let timezone: String
    let task: TaskItem?
    var due: Date? { ShellDate.parse(due_at) }
}

struct MemoryItem: Decodable, Identifiable, Hashable {
    let id: String
    let text: String
    let created_at: String
    let provenance: String
    let epistemic_status: String
    let source_excerpt: String?
    let source_created_at: String?
    let conversation_id: String?
    var created: Date? { ShellDate.parse(created_at) }
    var kindLabel: String {
        if provenance == "user_correction" { return "직접 정정함" }
        if provenance == "user_note" { return "직접 저장함" }
        return ["reported": "대화에서 들은 내용", "inferred": "대화에서 추론함", "disputed": "확인이 필요해요"][epistemic_status] ?? "기억"
    }
}

enum LoadState: Equatable { case idle, loading, loaded, failed(String) }

/// Panel data stays in memory so sheets open with content and refresh quietly.
@MainActor
final class PanelStore: ObservableObject {
    @Published private(set) var tasks: [TaskItem] = []
    @Published private(set) var responsibilities: [Responsibility] = []
    @Published private(set) var schedules: [OneOffSchedule] = []
    @Published private(set) var memories: [MemoryItem] = []
    @Published private(set) var states: [ShellPanel: LoadState] = [:]
    let data: ShellData

    init(data: ShellData) { self.data = data }

    func state(_ panel: ShellPanel) -> LoadState { states[panel] ?? .idle }

    func clear() {
        tasks = []; responsibilities = []; schedules = []; memories = []; states = [:]
    }

    func prefetch() async {
        async let a: Void = refresh(.tasks)
        async let b: Void = refresh(.schedules)
        async let c: Void = refresh(.memory)
        _ = await (a, b, c)
    }

    func refresh(_ panel: ShellPanel) async {
        guard states[panel] != .loading else { return }
        let hadData = hasData(panel)
        states[panel] = hadData ? .loaded : .loading
        do {
            switch panel {
            case .tasks:
                struct Response: Decodable { let tasks: [TaskItem] }
                let value = try await data.fetch("tasks", as: Response.self)
                tasks = value.tasks.sorted { ($0.created ?? .distantPast) > ($1.created ?? .distantPast) }
            case .schedules:
                struct R: Decodable { let responsibilities: [Responsibility] }
                struct S: Decodable { let schedules: [OneOffSchedule] }
                async let r = data.fetch("responsibilities", as: R.self)
                async let s = data.fetch("schedules", as: S.self)
                let (rv, sv) = try await (r, s)
                responsibilities = rv.responsibilities
                schedules = sv.schedules
            case .memory:
                struct Response: Decodable { let memories: [MemoryItem] }
                memories = try await data.fetch("memory", as: Response.self).memories
            default: break
            }
            states[panel] = .loaded
        } catch {
            if !hadData { states[panel] = .failed((error as? LocalizedError)?.errorDescription ?? "불러오지 못했어요.") }
        }
    }

    private func hasData(_ panel: ShellPanel) -> Bool {
        switch panel {
        case .tasks: return !tasks.isEmpty
        case .schedules: return !responsibilities.isEmpty || !schedules.isEmpty
        case .memory: return !memories.isEmpty
        default: return false
        }
    }

    func taskTarget(_ task: TaskItem, reply: Bool) async throws -> (String, String) {
        let target = try await data.fetch("tasks/\(task.id)/navigation", as: TaskNavigationTarget.self)
        guard let message = reply ? target.reply_message_id : target.request_message_id else { throw ShellAPIError.unavailable }
        return (target.conversation_id, message)
    }

    func cancelResponsibility(_ item: Responsibility) async throws {
        try await data.send("responsibilities/\(item.id)", method: "DELETE")
        responsibilities.removeAll { $0.id == item.id }
        await refresh(.schedules)
    }

    func cancelSchedule(_ item: OneOffSchedule) async throws {
        try await data.send("schedules/\(item.id)", method: "DELETE")
        schedules.removeAll { $0.id == item.id }
        await refresh(.schedules)
    }

    func forget(_ item: MemoryItem) async throws {
        try await data.send("memory/\(item.id)", method: "DELETE")
        memories.removeAll { $0.id == item.id }
    }
}
