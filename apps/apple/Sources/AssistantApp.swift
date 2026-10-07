import SwiftUI
import WebKit

@main
struct AssistantApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #else
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #endif
    var body: some Scene {
        WindowGroup { ShellView() }
        #if os(macOS)
        .defaultSize(width: 1120, height: 780)
        .commands { CommandGroup(replacing: .newItem) {} }
        #endif
    }
}

struct ShellView: View {
    @StateObject private var shell = WebShell()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        ZStack {
            if shell.failure == nil {
                #if os(iOS)
                NativeComposerHost(controller: shell.nativeComposer)
                    .ignoresSafeArea(.container, edges: .bottom)
                    .ignoresSafeArea(.keyboard, edges: .bottom)
                #else
                NativeWebView(webView: shell.webView)
                #endif
            }
            if let failure = shell.failure {
                VStack(spacing: 20) {
                    Image(systemName: "wifi.exclamationmark").font(.system(size: 38, weight: .light)).foregroundStyle(.secondary)
                    Text("Assistant에 연결할 수 없습니다").font(.title3.weight(.semibold))
                    Text(failure).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 320)
                    Button("다시 연결", action: shell.retry).buttonStyle(.borderedProminent).controlSize(.large)
                }
                .padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
            } else if shell.loading {
                ProgressView("연결 중…").padding(22).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 480)
        #else
        .background(Color("Canvas").ignoresSafeArea(.container))
        .sheet(item: $shell.exportedFile) { file in ActivitySheet(url: file.url) }
        .onChange(of: shell.exportedFile?.id) { _, _ in shell.updateComposerPresentation() }
        .onChange(of: shell.downloadNotice) { _, _ in shell.updateComposerPresentation() }
        #endif
        .alert("파일 다운로드", isPresented: Binding(get: { shell.downloadNotice != nil }, set: { if !$0 { shell.downloadNotice = nil } })) {
            Button("확인") { shell.downloadNotice = nil }
        } message: { Text(shell.downloadNotice ?? "") }
        .onChange(of: phase) { _, newPhase in
            if newPhase == .active { NotificationService.shared.refresh(registerIfGranted: true) }
            #if os(iOS)
            shell.composerSceneActive = newPhase == .active
            shell.updateComposerPresentation()
            #endif
        }
    }
}

#if os(iOS)
struct ActivitySheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NotificationService.shared.configure()
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationService.shared.registered(deviceToken: deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationService.shared.registrationFailed()
    }
}
#else
struct NativeWebView: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) { NotificationService.shared.configure() }
    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationService.shared.registered(deviceToken: deviceToken)
    }
    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationService.shared.registrationFailed()
    }
}
#endif
