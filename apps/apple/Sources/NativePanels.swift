import SwiftUI

struct NativePanelView: View {
    let panel: ShellPanel
    @ObservedObject var data: ShellData
    @ObservedObject var panels: PanelStore
    var assistant: String? = nil
    let openConversation: (String, String?) -> Void
    let close: () -> Void
    var body: some View {
        Group {
            switch panel {
            case .notifications: NativeNotificationsView()
            case .tasks: TasksPanel(store: panels, assistant: assistant, open: openConversation)
            case .schedules: SchedulesPanel(store: panels, open: openConversation)
            case .memory: MemoryPanel(store: panels)
            case .attention, .computer, .settings: WebPanelView(panel: panel.webPanel)
            }
        }
        .navigationTitle(panel.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("닫기", action: close) }
        }
        #else
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                Text(panel.title).font(.title3.weight(.semibold))
                Spacer()
                Button(action: close) { Image(systemName: "xmark").font(.body.weight(.semibold)) }
                    .buttonStyle(.borderless).foregroundStyle(.secondary)
                    .keyboardShortcut(.cancelAction).help("닫기").accessibilityLabel("닫기")
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 4)
        }
        #endif
    }
}

#if os(macOS)
/// General preferences are native; assistant configuration reuses the web settings in its own tab.
struct MacSettingsView: View {
    var body: some View {
        TabView {
            Form {
                Section {
                    LabeledContent("버전", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")
                    Text("시스템의 화면 모드와 동작 줄이기 설정을 따라요.").foregroundStyle(.secondary)
                }
                Section("알림") { NativeNotificationsView() }
            }
            .formStyle(.grouped)
            .frame(width: 520, height: 360)
            .tabItem { Label("일반", systemImage: "gearshape") }
            WebPanelView(panel: "settings")
                .frame(minWidth: 640, idealWidth: 720, minHeight: 640, idealHeight: 760)
                .tabItem { Label("어시스턴트", systemImage: "person.crop.circle") }
        }
    }
}
#endif

struct NativeNotificationsView: View {
    @State private var permission = "default"
    @State private var configured = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("답변은 대화에 남아요", systemImage: "bubble.left.and.bubble.right")
                .font(.headline)
            Text("알림을 누르면 해당 대화와 답변을 열어요.").foregroundStyle(.secondary)
            Text(!configured ? "이 빌드에는 푸시 알림 설정이 없어요." : permission == "granted" ? "시스템 알림이 켜져 있어요." : "시스템에서 알림 권한을 확인해 주세요.")
                .font(.subheadline).foregroundStyle(.secondary)
            Button("시스템 알림 설정 열기") { NotificationService.shared.openSettings() }
        }
        .padding()
        .task {
            NotificationService.shared.refresh {
                permission = NotificationService.shared.state["permission"] as? String ?? "default"
                configured = NotificationService.shared.state["configured"] as? Bool == true
            }
        }
    }
}

/// Complex controls remain web content; the sheet, title and dismissal are native.
@MainActor
enum WebPanelCache {
    private static var shells: [String: WebShell] = [:]
    static func shell(_ panel: String) -> WebShell {
        if let shell = shells[panel] { return shell }
        let shell = WebShell(panel: panel)
        shells[panel] = shell
        return shell
    }
    static func warm(_ panels: [String]) { for panel in panels { _ = shell(panel) } }
}

struct WebPanelView: View {
    @ObservedObject private var shell: WebShell
    @State private var showSpinner = false
    init(panel: String) { shell = WebPanelCache.shell(panel) }
    var body: some View {
        ZStack {
            NativeWebView(webView: shell.webView)
                .opacity(shell.loading ? 0 : 1)
                .animation(.easeOut(duration: 0.2), value: shell.loading)
            if shell.loading && showSpinner { ProgressView() }
            if let error = shell.failure {
                ContentUnavailableView { Label("연결하지 못했어요", systemImage: "wifi.exclamationmark") }
                    description: { Text(error) } actions: { Button("다시 연결", action: shell.retry) }
            }
        }
        .task { try? await Task.sleep(for: .milliseconds(400)); showSpinner = true }
        #if os(iOS)
        .sheet(item: $shell.exportedFile) { ActivitySheet(url: $0.url) }
        #endif
        .alert("파일 다운로드", isPresented: Binding(get: { shell.downloadNotice != nil }, set: { if !$0 { shell.downloadNotice = nil } })) {
            Button("확인") { shell.downloadNotice = nil }
        } message: { Text(shell.downloadNotice ?? "") }
    }
}
