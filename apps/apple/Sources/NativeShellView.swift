import SwiftUI

enum ShellStyle {
    static let accent = Color(red: 232.0 / 255, green: 99.0 / 255, blue: 10.0 / 255)
}

struct ShellView: View {
    @ObservedObject var shell: WebShell
    @StateObject private var data: ShellData
    @StateObject private var panels: PanelStore
    @Environment(\.scenePhase) private var phase
    @State private var panel: ShellPanel?
    @State private var selectionError: String?
    @State private var failedSelection: (id: String, message: String?)?
    @State private var selectionRequest = UUID()

    init(shell: WebShell) {
        self.shell = shell
        let data = ShellData()
        _data = StateObject(wrappedValue: data)
        _panels = StateObject(wrappedValue: PanelStore(data: data))
    }

    var body: some View {
        navigation
            .tint(ShellStyle.accent)
            .alert("대화를 열지 못했어요", isPresented: Binding(get: { selectionError != nil }, set: { if !$0 { selectionError = nil } })) {
                if let failedSelection {
                    Button("다시 시도") { selectionError = nil; select(failedSelection.id, failedSelection.message) }
                }
                Button("닫기", role: .cancel) { selectionError = nil }
            } message: { Text(selectionError ?? "") }
            .task(id: shell.authenticated && phase == .active) {
                data.webView = shell.webView
                guard shell.authenticated, phase == .active else {
                    if !shell.authenticated { data.clear(); panels.clear() }
                    return
                }
                WebPanelCache.warm(["settings", "computer"])
                await panels.prefetch()
            }
            .onChange(of: shell.resultRevision) { _, _ in panel = nil }
            .onChange(of: shell.panelRequest) { _, request in
                guard let request else { return }
                shell.panelRequest = nil
                open(request)
            }
            .onChange(of: shell.openRequest) { _, request in
                guard let request else { return }
                shell.openRequest = nil
                select(request.conversation, request.message)
            }
            .onChange(of: phase) { _, value in
                if value == .active {
                    NotificationService.shared.clearDelivered()
                    NotificationService.shared.refresh(registerIfGranted: true)
                }
                #if os(iOS)
                shell.composerSceneActive = value == .active
                shell.updateComposerPresentation()
                #endif
            }
    }

    @ViewBuilder private var navigation: some View {
        #if os(macOS)
        NavigationStack {
            ConversationSurface(shell: shell)
                .ignoresSafeArea(.container, edges: .top)
                .navigationTitle("")
                .toolbar { shellToolbar }
                .toolbarBackground(.hidden, for: .windowToolbar)
        }
        .inspector(isPresented: Binding(get: { panel != nil }, set: { if !$0 { panel = nil } })) {
            if let panel {
                NavigationStack {
                    NativePanelView(panel: panel, data: data, panels: panels, assistant: shell.assistant, openConversation: select) { self.panel = nil }
                }
                .inspectorColumnWidth(min: 320, ideal: panel == .computer ? 540 : 380, max: 800)
            }
        }
        .frame(minWidth: 560, minHeight: 480)
        #else
        ConversationSurface(shell: shell)
            .ignoresSafeArea(.container, edges: .top)
            .overlay(alignment: .top) { if shell.authenticated { conversationBar } }
        .sheet(item: $panel) { item in
            NavigationStack {
                NativePanelView(panel: item, data: data, panels: panels, assistant: shell.assistant, openConversation: select) { panel = nil }
            }
            .presentationDetents(item.compact ? [.medium, .large] : [.large])
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(24)
        }
        .onChange(of: panel) { _, value in
            shell.presentedPanel = value != nil
            shell.updateComposerPresentation()
        }
        #endif
    }

    #if os(iOS)
    /// The persona and thinking state stay in the web header (Messages-style); the tools menu is native.
    private var conversationBar: some View {
        HStack {
            Spacer()
            shellMenu
        }
        .buttonStyle(.plain)
        .foregroundStyle(ShellStyle.accent)
        .padding(.horizontal, 8)
    }
    #endif
    @ToolbarContentBuilder private var shellToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            #if os(macOS)
            ForEach([ShellPanel.tasks, .schedules, .memory, .computer]) { item in
                Button { toggle(item) } label: { Label(item.title, systemImage: item.symbol) }
                    .help(item.title)
                    .disabled(!shell.authenticated)
                    .accessibilityIdentifier("shell-\(item.rawValue)")
            }
            SettingsLink { Label("설정", systemImage: "gearshape") }.help("설정")
            #else
            shellMenu
            #endif
        }
    }
    #if os(macOS)
    private func toggle(_ item: ShellPanel) {
        withAnimation(.snappy(duration: 0.28)) { panel = panel == item ? nil : item }
    }
    #endif
    private var shellMenu: some View {
            Menu {
                ForEach(ShellPanel.allCases.filter { $0 != .settings && $0 != .notifications }) { item in
                    Button { open(item) } label: { Label(item.title, systemImage: item.symbol) }
                }
                Divider()
                #if os(macOS)
                SettingsLink { Label("설정", systemImage: "gearshape") }
                #else
                Button { open(.settings) } label: { Label("설정", systemImage: "gearshape") }
                #endif
            } label: { Label("도구", systemImage: "ellipsis.circle").labelStyle(.iconOnly).frame(width: 44, height: 44) }
                .disabled(!shell.authenticated)
                .accessibilityIdentifier("shell-tools")
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
                failedSelection = (id, message)
                selectionError = "대화를 불러오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요."
                return
            }
            panel = nil
        }
    }
}
