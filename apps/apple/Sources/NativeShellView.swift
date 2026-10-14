import SwiftUI

enum ShellStyle {
    static let accent = Color(red: 232.0 / 255, green: 99.0 / 255, blue: 10.0 / 255)
}

struct ShellView: View {
    @ObservedObject var shell: WebShell
    @StateObject private var data = ShellData()
    @Environment(\.scenePhase) private var phase
    @State private var path: [String] = []
    @State private var panel: ShellPanel?
    @State private var selectionError: String?
    @State private var selectionRequest = UUID()

    var body: some View {
        navigation
            .tint(ShellStyle.accent)
            .alert("대화를 열지 못했어요", isPresented: Binding(get: { selectionError != nil }, set: { if !$0 { selectionError = nil } })) {
                Button("확인", role: .cancel) { selectionError = nil }
            } message: { Text(selectionError ?? "") }
            .task(id: shell.authenticated && phase == .active) {
                guard shell.authenticated, phase == .active else {
                    if !shell.authenticated { data.clear() }
                    return
                }
                while !Task.isCancelled {
                    await data.refreshConversations()
                    do { try await Task.sleep(for: .seconds(30)) } catch { return }
                }
            }
            .onChange(of: shell.conversation) { _, id in
                #if os(iOS)
                if let id, !path.isEmpty { path = [id] }
                #endif
            }
            .onChange(of: shell.resultRevision) { _, _ in
                panel = nil
                #if os(iOS)
                if let id = shell.conversation { path = [id] }
                #endif
                Task { await data.refreshConversations() }
            }
            .onChange(of: phase) { _, value in
                if value == .active { NotificationService.shared.refresh(registerIfGranted: true) }
                #if os(iOS)
                shell.composerSceneActive = value == .active
                shell.updateComposerPresentation()
                #endif
            }
    }

    @ViewBuilder private var navigation: some View {
        #if os(macOS)
        NavigationSplitView {
            conversationList
                .navigationTitle("대화")
                .navigationSplitViewColumnWidth(min: 230, ideal: 280, max: 380)
        } detail: {
            ConversationSurface(shell: shell)
                .navigationTitle(conversationTitle)
                .toolbar { shellToolbar }
        }
        .inspector(isPresented: Binding(get: { panel != nil }, set: { if !$0 { panel = nil } })) {
            if let panel {
                NativePanelView(panel: panel, data: data, openConversation: select) { self.panel = nil }
                    .inspectorColumnWidth(min: 320, ideal: panel == .computer ? 540 : 360, max: 800)
            }
        }
        .frame(minWidth: 720, minHeight: 480)
        #else
        NavigationStack(path: $path) {
            Group {
                if shell.authenticated { conversationList }
                else { ConversationSurface(shell: shell) }
            }
            .navigationTitle("대화")
            .toolbar { shellToolbar }
            .navigationDestination(for: String.self) { _ in
                ConversationSurface(shell: shell)
                    .navigationTitle(conversationTitle)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { shellToolbar }
            }
        }
        .sheet(item: $panel) { item in
            NavigationStack {
                NativePanelView(panel: item, data: data, openConversation: select) { panel = nil }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .onChange(of: panel) { _, value in
            shell.presentedPanel = value != nil
            shell.updateComposerPresentation()
        }
        #endif
    }

    private var conversationTitle: String {
        data.conversations.first { $0.id == shell.conversation }?.displayTitle ?? "Assistant"
    }
    private var conversationList: some View {
        List {
            if let error = data.errors["conversations"] {
                Section { Text(error).foregroundStyle(.secondary); Button("다시 불러오기") { Task { await data.refreshConversations() } } }
            }
            if data.conversations.isEmpty {
                if data.loading.contains("conversations") { ProgressView("대화를 불러오고 있어요") }
                else { Text(shell.authenticated ? "아직 대화가 없어요" : "대화 화면에서 연결해 주세요").foregroundStyle(.secondary) }
            }
            if let current = data.conversations.first(where: { $0.id == shell.assistant }) {
                Section("현재 대화") { row(current) }
            }
            Section("이전 대화") {
                ForEach(data.conversations.filter { $0.id != shell.assistant }) { row($0) }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        .refreshable { await data.refreshConversations() }
        #else
        .listStyle(.sidebar)
        #endif
    }
    private func row(_ item: ShellConversation) -> some View {
        Button { select(item.id, nil) } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    Text(item.displayTitle).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    if item.id == shell.conversation { Image(systemName: "checkmark").foregroundStyle(ShellStyle.accent).accessibilityLabel("선택한 대화") }
                }
                if let preview = item.preview, !preview.isEmpty { Text(preview).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
                HStack {
                    if let date = item.date { Text(date, style: .relative) }
                    Spacer()
                    if let count = item.message_count { Text("메시지 \(count)개") }
                }.font(.caption).foregroundStyle(.secondary)
            }.padding(.vertical, 4).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("conversation-\(item.id)")
    }
    @ToolbarContentBuilder private var shellToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button { Task { await data.refreshConversations() } } label: { Label("새로고침", systemImage: "arrow.clockwise") }
                .disabled(!shell.authenticated)
            Menu {
                ForEach(ShellPanel.allCases.filter { $0 != .settings }) { item in
                    Button { open(item) } label: { Label(item.title, systemImage: item.symbol) }
                }
                Divider()
                #if os(macOS)
                SettingsLink { Label("설정", systemImage: "gearshape") }
                #else
                Button { open(.settings) } label: { Label("설정", systemImage: "gearshape") }
                #endif
            } label: { Label("도구", systemImage: "ellipsis.circle") }
                .disabled(!shell.authenticated)
                .accessibilityIdentifier("shell-tools")
        }
    }
    private func open(_ item: ShellPanel) {
        #if os(iOS)
        shell.nativeComposer.preparePanelSource()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
        panel = item
    }
    private func select(_ id: String, _ message: String?) {
        let request = UUID()
        selectionRequest = request
        Task {
            let accepted = await shell.selectConversation(id, message: message)
            guard request == selectionRequest else { return }
            guard accepted else {
                selectionError = "대화를 불러오지 못했어요. 연결과 웹 앱 버전을 확인한 뒤 다시 시도해 주세요."
                return
            }
            panel = nil
            #if os(iOS)
            path = [id]
            #endif
        }
    }
}
