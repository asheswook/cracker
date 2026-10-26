import SwiftUI

enum ShellStyle {
    static let accent = Color(red: 232.0 / 255, green: 99.0 / 255, blue: 10.0 / 255)
}

struct ShellView: View {
    @ObservedObject var shell: WebShell
    @StateObject private var data: ShellData
    @StateObject private var panels: PanelStore
    @Environment(\.scenePhase) private var phase
    #if os(macOS)
    @State private var sidebarVisibility: NavigationSplitViewVisibility = .all
    #endif
    #if os(iOS)
    private enum ShellTab: Hashable { case chat, attention, tasks, schedules, more }
    @State private var selectedTab: ShellTab = .chat
    @State private var morePath: [ShellPanel] = []
    #else
    private enum SidebarDestination: Hashable { case chat, panel(ShellPanel) }
    @State private var sidebarSelection: SidebarDestination? = .chat
    #endif
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
                guard shell.authenticated, phase == .active else { return }
                WebPanelCache.warm(["settings", "computer"])
                await panels.prefetch()
            }
            .onChange(of: shell.authenticated, initial: true) { _, authenticated in
                guard !authenticated else { return }
                data.clear()
                panels.clear()
                WebPanelCache.clear()
                showConversation()
                #if os(iOS)
                morePath = []
                shell.presentedPanel = false
                shell.updateComposerPresentation()
                #endif
            }
            .onChange(of: shell.resultRevision) { _, _ in showConversation() }
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
        if shell.authenticated {
            authenticatedNavigation
        } else {
            ConversationSurface(shell: shell)
                .ignoresSafeArea(.container, edges: .all)
                #if os(macOS)
                .frame(minWidth: 560, minHeight: 480)
                #endif
        }
    }

    @ViewBuilder private var authenticatedNavigation: some View {
        #if os(macOS)
        NavigationSplitView(columnVisibility: $sidebarVisibility) {
            List(selection: $sidebarSelection) {
                NavigationLink(value: SidebarDestination.chat) {
                    Label("대화", systemImage: "bubble.left.and.bubble.right")
                }
                ForEach([ShellPanel.attention, .tasks, .schedules, .memory, .computer]) { item in
                    NavigationLink(value: SidebarDestination.panel(item)) {
                        Label(item.title, systemImage: item.symbol)
                    }
                    .accessibilityIdentifier("shell-\(item.rawValue)")
                }
                Section {
                    SettingsLink { Label("설정", systemImage: ShellPanel.settings.symbol) }
                        .buttonStyle(.plain)
                }
            }
            .listStyle(.sidebar)
            .navigationTitle("크래커")
            .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
        } detail: {
            NavigationStack {
                if let sidebarSelection, case .panel(let item) = sidebarSelection {
                    NativePanelView(panel: item, data: data, panels: panels, assistant: shell.assistant,
                                    openConversation: select, close: showConversation, isModal: false)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ConversationSurface(shell: shell)
                        .ignoresSafeArea(.container, edges: .top)
                        .navigationTitle("")
                        .toolbarBackground(.hidden, for: .windowToolbar)
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .frame(minWidth: 560, minHeight: 480)
        #else
        TabView(selection: $selectedTab) {
            ConversationSurface(shell: shell)
                .ignoresSafeArea(.container, edges: .top)
                .tabItem { Label("대화", systemImage: "bubble.left.and.bubble.right") }
                .tag(ShellTab.chat)
            NavigationStack {
                tabPanel(.attention)
            }
            .tabItem { Label(ShellPanel.attention.title, systemImage: ShellPanel.attention.symbol) }
            .tag(ShellTab.attention)
            NavigationStack {
                tabPanel(.tasks)
            }
            .tabItem { Label(ShellPanel.tasks.title, systemImage: ShellPanel.tasks.symbol) }
            .tag(ShellTab.tasks)
            NavigationStack {
                tabPanel(.schedules)
            }
            .tabItem { Label(ShellPanel.schedules.title, systemImage: ShellPanel.schedules.symbol) }
            .tag(ShellTab.schedules)
            NavigationStack(path: $morePath) {
                List([ShellPanel.memory, .computer, .settings, .notifications]) { item in
                    NavigationLink(value: item) { Label(item.title, systemImage: item.symbol) }
                }
                .navigationTitle("더보기")
                .navigationBarTitleDisplayMode(.large)
                .navigationDestination(for: ShellPanel.self) { item in tabPanel(item) }
            }
            .tabItem { Label("더보기", systemImage: "ellipsis.circle") }
            .tag(ShellTab.more)
        }
        .onChange(of: selectedTab, initial: true) { _, value in
            if value != .chat { shell.nativeComposer.preparePanelSource() }
            shell.presentedPanel = value != .chat
            shell.updateComposerPresentation()
        }
        #endif
    }

    #if os(iOS)
    private func tabPanel(_ item: ShellPanel) -> some View {
        NativePanelView(panel: item, data: data, panels: panels, assistant: shell.assistant,
                        openConversation: select, close: {}, isModal: false)
    }
    #endif
    private func open(_ item: ShellPanel) {
        #if os(iOS)
        shell.nativeComposer.preparePanelSource()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        switch item {
        case .attention: selectedTab = .attention
        case .tasks: selectedTab = .tasks
        case .schedules: selectedTab = .schedules
        case .memory, .computer, .settings, .notifications:
            morePath = [item]
            selectedTab = .more
        }
        #else
        sidebarSelection = .panel(item)
        #endif
    }
    private func showConversation() {
        #if os(iOS)
        selectedTab = .chat
        #else
        sidebarSelection = .chat
        #endif
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
            showConversation()
        }
    }
}
