import SwiftUI
import WebKit
import Combine

/// One conversation renderer. Navigation and presentations belong to SwiftUI.
@MainActor
final class WebShell: NSObject, ObservableObject {
    static let processPool = WKProcessPool()
    let webView: WKWebView
    let panel: String?
    #if os(macOS)
    let modelLogin = LocalModelLogin()
    #endif
    @Published var loading = true
    @Published var failure: String?
    @Published var downloadNotice: String?
    @Published var exportedFile: ExportedFile?
    @Published var authenticated = false
    @Published var conversation: String?
    @Published var assistant: String?
    @Published var assistantName = "크래커"
    @Published var resultRevision = 0
    @Published var openRequest: ShellOpenRequest?
    @Published var panelRequest: ShellPanel?
    static weak var body: WebShell?
    var webReady = false
    private var documentID = UUID()
    private var results: [URL] = []
    private var pendingResultConversation: String?
    private var delivering = false
    private var bridge: NativeBridge!
    private var notificationObserver: AnyCancellable?
    let downloads = DownloadCoordinator()
    #if os(iOS)
    private var rootReader: NativeReaderBridge?
    private var hybridDocument: String?
    private var composerDocument: String?
    var composerSceneActive = true
    var presentedPanel = false
    lazy var nativeComposer = NativeComposerController(webView: webView, transition: { [weak self] detail in
        guard let self, detail["document"] as? String == self.composerDocument else { return }
        self.dispatch("assistant-native-keyboard-transition", detail: detail)
    }) { [weak self] command, activation, completion in
        self?.deliverComposer(command, userActivation: activation, completion: completion)
    }
    func connectHybrid(document: String) -> Bool {
        guard panel == nil, UUID(uuidString: document) != nil,
              hybridDocument == nil || hybridDocument == document else { return false }
        hybridDocument = document
        return true
    }
    func connectComposer(document: String) -> Bool {
        guard panel == nil, UUID(uuidString: document) != nil,
              composerDocument == nil || composerDocument == document else { return false }
        composerDocument = document
        return true
    }
    func receiveComposer(_ state: NativeComposerState) -> Bool {
        guard composerDocument == state.document else { return false }
        return nativeComposer.apply(state)
    }
    func hideComposer(document: String, session: String) {
        guard composerDocument == document else { return }
        nativeComposer.hide(document: document, session: session)
    }
    func updateComposerPresentation() {
        let external = !composerSceneActive || presentedPanel || exportedFile != nil || downloadNotice != nil
        nativeComposer.setExternalPresentation(external)
        rootReader?.setExternal(external)
    }
    private func deliverComposer(_ command: [String: Any], userActivation: Bool,
                                 completion: @escaping (Result<Any, Error>) -> Void) {
        let failed = NSError(domain: "AssistantComposer", code: 1)
        guard let url = webView.url, AppConfiguration.isAppURL(url),
              command["document"] as? String == composerDocument else { completion(.failure(failed)); return }
        let currentDocument = documentID
        let finish: (Result<Any, Error>) -> Void = { [weak self] result in
            guard self?.documentID == currentDocument else { completion(.failure(failed)); return }
            completion(result)
        }
        if userActivation {
            guard let data = try? JSONSerialization.data(withJSONObject: command),
                  let json = String(data: data, encoding: .utf8) else { completion(.failure(failed)); return }
            webView.evaluateJavaScript("window.__assistantComposer && window.__assistantComposer(\(json))") { value, error in
                if let error { finish(.failure(error)) }
                else { finish(.success(value ?? NSNull())) }
            }
        } else {
            webView.callAsyncJavaScript("return await window.__assistantComposer(command);", arguments: ["command": command],
                                       in: nil, in: .page, completionHandler: finish)
        }
    }
    #endif

    init(panel: String? = nil) {
        self.panel = panel
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.processPool = Self.processPool
        let mode: [String: Any] = panel.map { ["version": 1, "role": "panel", "panel": $0] } ?? ["version": 1, "role": "body"]
        if let data = try? JSONSerialization.data(withJSONObject: mode), let json = String(data: data, encoding: .utf8) {
            configuration.userContentController.addUserScript(WKUserScript(source: "window.__ASSISTANT_SHELL__ = Object.freeze(\(json));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        #endif
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.preferences.isElementFullscreenEnabled = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        #if os(iOS)
        if panel == nil { rootReader = NativeReaderBridge(webView: webView, configuration: configuration) }
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        // The web header (persona and thinking state) draws its own top fade; a system edge blur would wash it out.
        if #available(iOS 26.0, *) { webView.scrollView.topEdgeEffect.isHidden = true }
        #endif
        bridge = NativeBridge(shell: self)
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "assistantNative")
        #if os(iOS)
        if panel == nil {
            configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "assistantHeader")
            configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "assistantFooter")
        }
        #endif
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // The edge swipe belongs to NavigationStack, not browser history.
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        downloads.onFinished = { [weak self] url in
            #if os(iOS)
            self?.exportedFile = ExportedFile(url: url)
            #else
            self?.downloadNotice = "파일을 저장했어요: \(url.lastPathComponent)"
            #endif
        }
        downloads.onFailure = { [weak self] in self?.downloadNotice = "파일을 저장하지 못했어요. 다시 시도해 주세요." }
        if panel == nil {
            Self.body = self
            NotificationService.shared.onStateChange = { [weak self] in self?.sendState() }
            NotificationService.shared.connectResults { [weak self] url in self?.enqueueResult(url) }
            notificationObserver = NotificationCenter.default.publisher(for: NotificationService.foregroundNotification)
                .sink { [weak self] _ in
                    guard let self, self.webReady else { return }
                    self.dispatch("assistant-native-notification", detail: [:])
                }
        }
        webView.load(URLRequest(url: AppConfiguration.origin))
    }

    func selectConversation(_ id: String, message: String? = nil) async -> Bool {
        guard UUID(uuidString: id) != nil, webReady, let url = webView.url, AppConfiguration.isAppURL(url) else { return false }
        let epoch = documentID
        var command: [String: Any] = ["version": 1, "conversation": id]
        if let message { command["message"] = message }
        do {
            let result: Any = try await withCheckedThrowingContinuation { continuation in
                webView.callAsyncJavaScript("return await window.__assistantShellCommand?.(command);", arguments: ["command": command], in: nil, in: .page) { result in
                    continuation.resume(with: result)
                }
            }
            guard epoch == documentID, let reply = result as? [String: Any], reply["accepted"] as? Bool == true else { return false }
            conversation = id
            return true
        } catch { return false }
    }
    func receiveShellState(_ body: [String: Any]) {
        authenticated = body["authenticated"] as? Bool == true
        conversation = (body["conversation"] as? String).flatMap { UUID(uuidString: $0) == nil ? nil : $0 }
        assistant = (body["assistant"] as? String).flatMap { UUID(uuidString: $0) == nil ? nil : $0 }
        if let name = body["name"] as? String, !name.isEmpty, name.count <= 80 { assistantName = name }
        if let pendingResultConversation, conversation == pendingResultConversation {
            self.pendingResultConversation = nil
            resultRevision += 1
        }
    }
    func retry() {
        failure = nil; loading = true
        if webView.url != nil { webView.reload() }
        else { webView.load(URLRequest(url: AppConfiguration.origin)) }
    }
    func enqueueResult(_ url: URL) {
        guard AppConfiguration.resultURL(url.absoluteString) != nil else { return }
        results.append(url)
        if let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "conversation" })?.value {
            pendingResultConversation = id
            if conversation == id { pendingResultConversation = nil; resultRevision += 1 }
        }
        deliverResults()
    }
    func ready() {
        webReady = true; sendState(); deliverResults()
        #if os(iOS)
        if panel == nil { nativeComposer.resetSafeTop() }
        #else
        if panel == nil { publishTitlebarInset() }
        #endif
    }
    #if os(macOS)
    /// The conversation runs under the transparent titlebar; the centred persona sits between the traffic lights and the toolbar.
    static let titlebarInset = 0
    private func publishTitlebarInset() {
        webView.evaluateJavaScript("document.documentElement.style.setProperty('--native-safe-top', '\(Self.titlebarInset)px')")
    }
    #endif
    func sendState() {
        guard webReady else { return }
        dispatch("assistant-native-notification-state", detail: NotificationService.shared.state)
    }
    private func deliverResults() {
        guard webReady, !delivering, let result = results.first else { return }
        delivering = true
        let deliveryDocument = documentID
        dispatch("assistant-native-result", detail: ["url": result.absoluteString]) { [weak self] success in
            guard let self else { return }
            self.delivering = false
            if success { self.results.removeFirst(); self.deliverResults() }
            else if self.documentID != deliveryDocument { self.deliverResults() }
        }
    }
    private func dispatch(_ event: String, detail: [String: Any], completion: ((Bool) -> Void)? = nil) {
        guard let url = webView.url, AppConfiguration.isAppURL(url),
              let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else {
            completion?(false); return
        }
        let currentDocument = documentID
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(event)', {detail: \(json)}));") { [weak self] _, error in
            completion?(error == nil && self?.documentID == currentDocument && self?.webReady == true)
        }
    }
    func openExternal(_ url: URL) {
        guard ["https", "http", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") else { return }
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }
}

extension WebShell: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loading = true; failure = nil
        #if os(iOS)
        if panel == nil { nativeComposer.setExternalPresentation(true); rootReader?.reset() }
        #endif
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        webReady = false; authenticated = false; documentID = UUID()
        #if os(iOS)
        hybridDocument = nil; composerDocument = nil
        if panel == nil { nativeComposer.resetDocument(); updateComposerPresentation() }
        #endif
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false
        #if os(iOS)
        if panel == nil { nativeComposer.resetSafeTop() }
        #else
        if panel == nil { publishTitlebarInset() }
        #endif
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loading = false; webReady = false
        failure = "화면이 중단됐어요. 다시 연결해 주세요."
        #if os(iOS)
        hybridDocument = nil; composerDocument = nil
        if panel == nil { nativeComposer.resetDocument() }
        #endif
    }
    private func failed(_ error: Error) {
        let navigationError = error as NSError
        guard navigationError.code != NSURLErrorCancelled else { return }
        loading = false
        let interruptedByPolicy = navigationError.domain == "WebKitErrorDomain" && navigationError.code == 102
        guard !interruptedByPolicy else { return }
        failure = "연결할 수 없어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if AppConfiguration.isAppURL(url) || url.scheme == "blob" || url.absoluteString == "about:blank" { decisionHandler(.allow) }
        else {
            if navigationAction.targetFrame?.isMainFrame != false { openExternal(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if !navigationResponse.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") { decisionHandler(.download) }
        else if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400 {
            loading = false
            failure = "서버에 연결하지 못했어요 (\(response.statusCode)). 잠시 후 다시 시도해 주세요."
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { loading = false; download.delegate = downloads }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { loading = false; download.delegate = downloads }
}

extension WebShell: WKUIDelegate {
    #if os(iOS)
    @available(iOS 18.4, *)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard panel == nil, frame.isMainFrame else { completionHandler(nil); return }
        nativeComposer.chooseAttachment(parameters, completion: completionHandler)
    }
    #else
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = true
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    #endif
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if let result = AppConfiguration.resultURL(url.absoluteString) { enqueueResult(result) }
        else if AppConfiguration.isAppURL(url) { webView.load(navigationAction.request) }
        else { openExternal(url) }
        return nil
    }
}
struct ExportedFile: Identifiable { let id = UUID(); let url: URL }
struct ShellOpenRequest: Equatable { let id = UUID(); let conversation: String; let message: String? }
