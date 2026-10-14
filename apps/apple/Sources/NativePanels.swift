import SwiftUI

struct NativePanelView: View {
    let panel: ShellPanel
    @ObservedObject var data: ShellData
    let openConversation: (String, String?) -> Void
    let close: () -> Void
    @State private var screen = false
    var body: some View {
        Group {
            if panel == .settings { NativeSettingsView() }
            else if panel == .notifications { NativeNotificationsView() }
            else {
                List {
                    if let error = data.errors[panel.id] {
                        Text(error).foregroundStyle(.secondary)
                        Button("다시 불러오기") { Task { await data.refresh(panel) } }
                    }
                    if data.loading.contains(panel.id) { ProgressView("불러오고 있어요") }
                    else if (data.records[panel] ?? []).isEmpty { Text("표시할 항목이 없어요").foregroundStyle(.secondary) }
                    ForEach(data.records[panel] ?? []) { record in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(record.title).font(.body).textSelection(.enabled)
                            if let detail = record.detail { Text(detail).font(.subheadline).foregroundStyle(.secondary) }
                            if let date = record.date {
                                if panel == .schedules { Text(date, format: .dateTime.month().day().hour().minute()).font(.caption).foregroundStyle(.secondary) }
                                else { Text(date, style: .relative).font(.caption).foregroundStyle(.secondary) }
                            }
                            if let conversation = record.conversation_id {
                                Button("대화에서 보기") { openConversation(conversation, record.source_message_id) }
                            }
                        }.padding(.vertical, 6)
                    }
                    if panel == .computer, !(data.records[panel] ?? []).isEmpty {
                        Button("컴퓨터 화면 열기", systemImage: "display") { screen = true }
                    }
                }
                #if os(iOS)
                .listStyle(.insetGrouped)
                #endif
                .refreshable { await data.refresh(panel) }
            }
        }
        .navigationTitle(panel.title)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("닫기", action: close) }
        }
        .task(id: panel) { await data.refresh(panel) }
        .sheet(isPresented: $screen) {
            NavigationStack {
                WebPanelView(panel: "computer").navigationTitle("컴퓨터")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("닫기") { screen = false } } }
            }
            #if os(iOS)
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            #else
            .frame(minWidth: 800, minHeight: 600)
            #endif
        }
    }
}

struct NativeSettingsView: View {
    @State private var advanced = false
    var body: some View {
        Form {
            Section("Assistant") {
                LabeledContent("버전", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")
                Text("시스템의 화면 모드와 동작 줄이기 설정을 따라요.").foregroundStyle(.secondary)
            }
            Section("계정과 어시스턴트") {
                Button("어시스턴트 설정 열기") { advanced = true }
                Text("모델 연결과 어시스턴트의 세부 설정을 관리해요.").font(.caption).foregroundStyle(.secondary)
            }
            Section("알림") { NativeNotificationsView() }
        }
        .formStyle(.grouped)
        #if os(macOS)
        .frame(width: 480, height: 430)
        #endif
        .sheet(isPresented: $advanced) {
            NavigationStack {
                WebPanelView(panel: "settings").navigationTitle("어시스턴트 설정")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("닫기") { advanced = false } } }
            }
            #if os(iOS)
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            #else
            .frame(minWidth: 640, minHeight: 620)
            #endif
        }
    }
}

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
struct WebPanelView: View {
    @StateObject private var shell: WebShell
    init(panel: String) { _shell = StateObject(wrappedValue: WebShell(panel: panel)) }
    var body: some View {
        ZStack {
            NativeWebView(webView: shell.webView)
            if shell.loading { ProgressView("불러오고 있어요") }
            if let error = shell.failure {
                ContentUnavailableView { Label("연결하지 못했어요", systemImage: "wifi.exclamationmark") }
                    description: { Text(error) } actions: { Button("다시 연결", action: shell.retry) }
            }
        }
        #if os(iOS)
        .sheet(item: $shell.exportedFile) { ActivitySheet(url: $0.url) }
        #endif
        .alert("파일 다운로드", isPresented: Binding(get: { shell.downloadNotice != nil }, set: { if !$0 { shell.downloadNotice = nil } })) {
            Button("확인") { shell.downloadNotice = nil }
        } message: { Text(shell.downloadNotice ?? "") }
    }
}
