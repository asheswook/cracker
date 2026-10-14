import SwiftUI

extension View {
    /// Grouped rows on iPhone, an inset list in the Mac inspector.
    @ViewBuilder func panelListStyle() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset).scrollContentBackground(.hidden)
        #endif
    }
    @ViewBuilder func panelSearch(_ text: Binding<String>, prompt: String) -> some View {
        #if os(iOS)
        searchable(text: text, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt)
        #else
        safeAreaInset(edge: .top, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(prompt, text: text).textFieldStyle(.plain)
                if !text.wrappedValue.isEmpty {
                    Button { text.wrappedValue = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("검색어 지우기")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        #endif
    }
}

private struct PanelStatus: View {
    let state: LoadState
    let empty: Bool
    let emptyTitle: String
    let emptyMessage: String
    let systemImage: String
    let retry: () -> Void
    var body: some View {
        if case .failed(let message) = state {
            ContentUnavailableView {
                Label("불러오지 못했어요", systemImage: "wifi.exclamationmark")
            } description: { Text(message) } actions: { Button("다시 시도", action: retry) }
        } else if state == .loading {
            VStack(alignment: .leading, spacing: 18) {
                ForEach(0..<4, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 4).frame(width: 64, height: 10)
                        RoundedRectangle(cornerRadius: 4).frame(height: 14)
                    }
                }
            }
            .foregroundStyle(.quaternary)
            .redacted(reason: .placeholder)
            .accessibilityLabel("불러오는 중")
            .padding(.vertical, 8)
        } else if empty {
            ContentUnavailableView(emptyTitle, systemImage: systemImage, description: Text(emptyMessage))
                .padding(.top, 24)
        }
    }
}

struct TasksPanel: View {
    @ObservedObject var store: PanelStore
    let assistant: String?
    let open: (String, String) -> Void
    @State private var filter = 0
    @State private var query = ""
    @State private var failure: String?

    private var items: [TaskItem] {
        store.tasks.filter { task in
            (assistant == nil || task.conversation_id == assistant) &&
            (filter == 0 || (filter == 1 ? task.active : !task.active)) &&
            (query.isEmpty || task.objective.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        List {
            Section {
                Picker("보기", selection: $filter) {
                    Text("전체").tag(0); Text("진행 중").tag(1); Text("지난 일").tag(2)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            Section {
                ForEach(items) { task in
                    Button { go(task, reply: !task.active) } label: { TaskRow(task: task).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("요청 보기", systemImage: "text.bubble") { go(task, reply: false) }
                            if !task.active { Button("답변 보기", systemImage: "bubble.left") { go(task, reply: true) } }
                        }
                }
            } footer: {
                PanelStatus(state: store.state(.tasks), empty: items.isEmpty, emptyTitle: query.isEmpty ? "맡긴 일이 없어요" : "검색 결과가 없어요",
                            emptyMessage: query.isEmpty ? "대화로 일을 맡기면 여기에 쌓여요." : "다른 단어로 찾아보세요.",
                            systemImage: "checklist") { Task { await store.refresh(.tasks) } }
            }
        }
        .panelListStyle()
        .panelSearch($query, prompt: "맡긴 일 검색")
        .refreshable { await store.refresh(.tasks) }
        .task { await store.refresh(.tasks) }
        .alert("열지 못했어요", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("확인", role: .cancel) {}
        } message: { Text(failure ?? "") }
        .sensoryFeedback(.selection, trigger: filter)
    }

    private func go(_ task: TaskItem, reply: Bool) {
        Task {
            do { let (conversation, message) = try await store.taskTarget(task, reply: reply); open(conversation, message) }
            catch { failure = reply ? "이 작업에 저장된 답변이 없어요." : "요청 원문을 찾지 못했어요." }
        }
    }
}

private struct TaskRow: View {
    let task: TaskItem
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(task.stateLabel).font(.footnote).foregroundStyle(.secondary)
                Spacer()
                if let date = task.created { Text(ShellDate.listLabel(date)).font(.footnote).foregroundStyle(.secondary) }
            }
            Text(task.objective).font(.body).lineLimit(3)
        }
        .padding(.vertical, 4)
    }
    private var color: Color {
        switch task.state {
        case "running", "queued", "waiting": return ShellStyle.accent
        case "succeeded": return .green
        case "failed", "unknown": return .red
        default: return .secondary
        }
    }
}

struct SchedulesPanel: View {
    @ObservedObject var store: PanelStore
    let open: (String, String) -> Void
    @State private var past = false
    @State private var failure: String?

    private var recurring: [Responsibility] { store.responsibilities.filter { past ? $0.state != "active" : $0.state == "active" } }
    private var once: [OneOffSchedule] {
        store.schedules.filter { past ? $0.status != "pending" : $0.status == "pending" }
            .sorted { ($0.due ?? .distantPast) < ($1.due ?? .distantPast) }
    }

    var body: some View {
        List {
            Section {
                Picker("보기", selection: $past) { Text("예정").tag(false); Text("지난 일").tag(true) }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
            if !recurring.isEmpty {
                Section("반복") {
                    ForEach(recurring) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Label(item.triggerLabel, systemImage: "repeat").font(.footnote).foregroundStyle(.secondary)
                            Text(item.objective).lineLimit(3)
                            if item.state == "active", let next = item.nextReview {
                                Text("다음 \(ShellDate.dueLabel(next))").font(.footnote).foregroundStyle(.secondary)
                            }
                            if item.last_error != nil { Text("최근 확인에 실패했어요").font(.footnote).foregroundStyle(.red) }
                        }
                        .padding(.vertical, 4)
                        .swipeActions {
                            if item.state == "active" {
                                Button("취소", role: .destructive) { run { try await store.cancelResponsibility(item) } }
                            }
                        }
                        .contextMenu {
                            if item.state == "active" {
                                Button("반복 취소", systemImage: "xmark.circle", role: .destructive) { run { try await store.cancelResponsibility(item) } }
                            }
                        }
                    }
                }
            }
            if !once.isEmpty {
                Section("한 번") {
                    ForEach(once) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            if let due = item.due {
                                Label(ShellDate.dueLabel(due), systemImage: "calendar").font(.footnote).foregroundStyle(.secondary)
                            }
                            Text(item.objective).lineLimit(3)
                        }
                        .padding(.vertical, 4)
                        .swipeActions {
                            if item.status == "pending" {
                                Button("취소", role: .destructive) { run { try await store.cancelSchedule(item) } }
                            }
                        }
                        .contextMenu {
                            if item.status == "pending" {
                                Button("예약 취소", systemImage: "xmark.circle", role: .destructive) { run { try await store.cancelSchedule(item) } }
                            }
                        }
                    }
                }
            }
            Section {} footer: {
                PanelStatus(state: store.state(.schedules), empty: recurring.isEmpty && once.isEmpty,
                            emptyTitle: past ? "지난 예약이 없어요" : "예정된 일이 없어요",
                            emptyMessage: "\"매일 아침 9시에 뉴스 정리해줘\"처럼 대화로 맡겨 보세요.",
                            systemImage: "calendar") { Task { await store.refresh(.schedules) } }
            }
        }
        .panelListStyle()
        .refreshable { await store.refresh(.schedules) }
        .task { await store.refresh(.schedules) }
        .alert("처리하지 못했어요", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("확인", role: .cancel) {}
        } message: { Text(failure ?? "") }
        .sensoryFeedback(.selection, trigger: past)
    }

    private func run(_ work: @escaping () async throws -> Void) {
        Task { do { try await work() } catch { failure = "잠시 후 다시 시도해 주세요." } }
    }
}

struct MemoryPanel: View {
    @ObservedObject var store: PanelStore
    @State private var query = ""
    @State private var pending: MemoryItem?
    @State private var failure: String?

    private var items: [MemoryItem] {
        query.isEmpty ? store.memories : store.memories.filter { $0.text.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        List {
            Section {
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.kindLabel).font(.footnote).foregroundStyle(.secondary)
                        Text(item.text).textSelection(.enabled)
                        if let excerpt = item.source_excerpt, !excerpt.isEmpty {
                            Text("“\(excerpt)”").font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    .padding(.vertical, 4)
                    .swipeActions { Button("지우기", role: .destructive) { pending = item } }
                    .contextMenu { Button("기억 지우기", systemImage: "trash", role: .destructive) { pending = item } }
                }
            } footer: {
                PanelStatus(state: store.state(.memory), empty: items.isEmpty,
                            emptyTitle: query.isEmpty ? "아직 기억한 게 없어요" : "검색 결과가 없어요",
                            emptyMessage: query.isEmpty ? "대화하며 알게 된 사실과 선호를 기억해요." : "다른 단어로 찾아보세요.",
                            systemImage: "brain") { Task { await store.refresh(.memory) } }
            }
        }
        .panelListStyle()
        .panelSearch($query, prompt: "기억 검색")
        .refreshable { await store.refresh(.memory) }
        .task { await store.refresh(.memory) }
        .confirmationDialog("이 기억을 지울까요?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible) {
            Button("기억 지우기", role: .destructive) {
                guard let item = pending else { return }
                Task { do { try await store.forget(item) } catch { failure = "잠시 후 다시 시도해 주세요." } }
            }
        } message: { Text("어시스턴트가 다음 대화부터 이 내용을 참고하지 않아요.") }
        .alert("지우지 못했어요", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("확인", role: .cancel) {}
        } message: { Text(failure ?? "") }
    }
}
