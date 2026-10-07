import SwiftUI
import WebKit
import Combine

@MainActor
final class WebShell: NSObject, ObservableObject {
    let webView: WKWebView
    #if os(macOS)
    let modelLogin = LocalModelLogin()
    #endif
    @Published var loading = true
    @Published var failure: String?
    @Published var downloadNotice: String?
    @Published var exportedFile: ExportedFile?
    var webReady = false
    private var documentID = UUID()
    private var results: [URL] = []
    private var delivering = false
    private var bridge: NativeBridge!
    private var notificationObserver: AnyCancellable?
    #if os(iOS)
    private var independentHeader: IndependentHeaderController?
    private var independentFooter: IndependentFooterController?
    private var rootReader: NativeReaderBridge?
    lazy var panelTransition = NativePanelTransition(webView: webView,
        host: { [unowned self] in self.nativeComposer.view },
        keyboardVisible: { [unowned self] in self.nativeComposer.panelKeyboardVisible },
        dismissKeyboard: { [unowned self] in self.nativeComposer.preparePanelSource() })
    #endif
    let downloads = DownloadCoordinator()
    #if os(iOS)
    private var hybridDocument: String?
    private var composerDocument: String?
    var composerSceneActive = true
    lazy var nativeComposer = NativeComposerController(webView: webView, transition: { [weak self] detail in
        guard let self, detail["document"] as? String == self.composerDocument else { return }
        self.dispatch("assistant-native-keyboard-transition", detail: detail)
    }) { [weak self] command, activation, completion in
        self?.deliverComposer(command, userActivation: activation, completion: completion)
    }

    func connectHybrid(document: String) -> Bool {
        guard UUID(uuidString: document) != nil,
              hybridDocument == nil || hybridDocument == document else { return false }
        hybridDocument = document
        independentHeader?.start()
        independentFooter?.start()
        return true
    }

    func connectComposer(document: String) -> Bool {
        guard UUID(uuidString: document) != nil,
              composerDocument == nil || composerDocument == document else { return false }
        composerDocument = document
        return true
    }

    func receiveComposer(_ state: NativeComposerState) -> Bool {
        guard composerDocument == state.document else { return false }
        #if os(iOS)
        #endif
        return nativeComposer.apply(state)
    }

    func hideComposer(document: String, session: String) {
        guard composerDocument == document else { return }
        nativeComposer.hide(document: document, session: session)
    }

    func updateComposerPresentation() {
        if !composerSceneActive || exportedFile != nil || downloadNotice != nil { panelTransition.cancel() }
        nativeComposer.setExternalPresentation(!composerSceneActive || exportedFile != nil || downloadNotice != nil)
        #if os(iOS)
        independentHeader?.setExternalPresentation(!composerSceneActive || exportedFile != nil || downloadNotice != nil)
        independentFooter?.setExternalPresentation(!composerSceneActive || exportedFile != nil || downloadNotice != nil)
        rootReader?.setExternal(!composerSceneActive || exportedFile != nil || downloadNotice != nil)
        #endif
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

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        #endif
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.preferences.isElementFullscreenEnabled = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        #if os(iOS)
        if NativeReaderBridge.enabled { rootReader = NativeReaderBridge(webView: webView, configuration: configuration) }
        if IndependentFooterController.enabled { independentFooter = IndependentFooterController(body: webView, configuration: configuration) }
        if IndependentHeaderController.enabled {
            independentHeader = IndependentHeaderController(bodyWebView: webView, configuration: configuration)
        }


        #endif
        bridge = NativeBridge(shell: self)
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "assistantNative")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        #if os(iOS)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "Canvas")
        webView.scrollView.backgroundColor = UIColor(named: "Canvas")
        #endif
        downloads.onFinished = { [weak self] url in
            #if os(iOS)
            self?.exportedFile = ExportedFile(url: url)
            #else
            self?.downloadNotice = "파일을 저장했습니다: \(url.lastPathComponent)"
            #endif
        }
        downloads.onFailure = { [weak self] in self?.downloadNotice = "파일을 저장하지 못했습니다. 다시 시도해 주세요." }
        NotificationService.shared.onStateChange = { [weak self] in self?.sendState() }
        NotificationService.shared.connectResults { [weak self] url in
            self?.enqueueResult(url)
        }
        notificationObserver = NotificationCenter.default.publisher(for: NotificationService.foregroundNotification)
            .sink { [weak self] _ in
                guard let self, self.webReady else { return }
                self.dispatch("assistant-native-notification", detail: [:])
            }
        webView.load(URLRequest(url: AppConfiguration.origin))
    }

    #if os(iOS)
    override func responds(to selector: Selector!) -> Bool {
        if selector == NSSelectorFromString("webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:") {
            if #available(iOS 18.4, *) { return NativeAttachmentPicker.enabled }
            return false
        }
        return super.responds(to: selector)
    }
    #endif

    func retry() {
        failure = nil
        loading = true
        if webView.url != nil { webView.reload() }
        else { webView.load(URLRequest(url: AppConfiguration.origin)) }
    }

    func enqueueResult(_ url: URL) {
        results.append(url)
        deliverResults()
    }

    func ready() { webReady = true; sendState(); deliverResults() }

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
        panelTransition.navigation()
        nativeComposer.setExternalPresentation(true)
        #if os(iOS)
        rootReader?.reset()
        independentHeader?.resetMain()
        independentFooter?.resetMain()
        #endif
        #endif
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        #if os(iOS)
        #endif
        webReady = false
        documentID = UUID()
        #if os(iOS)
        hybridDocument = nil
        composerDocument = nil
        nativeComposer.resetDocument()
        updateComposerPresentation()
        #endif
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false
        #if os(iOS)
        #endif
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        #if os(iOS)
        panelTransition.navigation()
        #endif
        loading = false
        webReady = false
        failure = "화면이 중단되었습니다. 다시 연결해 주세요."
        #if os(iOS)
        hybridDocument = nil
        composerDocument = nil
        nativeComposer.resetDocument()
        #endif
    }
    private func failed(_ error: Error) {
        let navigationError = error as NSError
        guard navigationError.code != NSURLErrorCancelled else { return }
        loading = false
        let interruptedByPolicy = navigationError.domain == "WebKitErrorDomain" && navigationError.code == 102
        guard !interruptedByPolicy else { return }
        failure = "연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if AppConfiguration.isAppURL(url) || url.scheme == "blob" || url.absoluteString == "about:blank" {
            decisionHandler(.allow)
        } else {
            if navigationAction.targetFrame?.isMainFrame != false { openExternal(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if !navigationResponse.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
        } else {
            if navigationResponse.isForMainFrame,
               let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400 {
                loading = false
                failure = "서버에 연결하지 못했습니다 (\(response.statusCode)). 잠시 후 다시 시도해 주세요."
                decisionHandler(.cancel)
            } else { decisionHandler(.allow) }
        }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        loading = false
        download.delegate = downloads
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        loading = false
        download.delegate = downloads
    }
}

extension WebShell: WKUIDelegate {
    #if os(iOS)
    @available(iOS 18.4, *)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard webView === self.webView, frame.isMainFrame else { completionHandler(nil); return }
        nativeComposer.chooseAttachment(parameters, completion: completionHandler)
    }
    #endif
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if let result = AppConfiguration.resultURL(url.absoluteString) { enqueueResult(result) }
        else if AppConfiguration.isAppURL(url) { webView.load(navigationAction.request) }
        else { openExternal(url) }
        return nil
    }
    #if os(macOS)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    #endif
}

struct ExportedFile: Identifiable { let id = UUID(); let url: URL }

#if os(iOS)
@MainActor
private final class PanelCover: UIView {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool { true }
}

@MainActor
final class NativePanelTransition {
    private weak var webView: WKWebView?
    private let host: () -> UIView
    private let keyboardVisible: () -> Bool
    private let dismissKeyboard: () -> Void
    private var sourceIdentity: [String] = []
    private var menuSource = false
    private var awaitingSource = false
    private var awaitingKeyboard = false
    private var beginReply: ((Any?, String?) -> Void)?
    private var keyboardObserver: NSObjectProtocol?
    private var keyboardWillObserver: NSObjectProtocol?
    private var hiddenCompletionSeen = true
    private var keyboardBoundsObservation: NSKeyValueObservation?
    private var lastKeyboardOccludes = false
    private var identity = NativePanelIdentity()
    private var document: String? { identity.document }
    private var generation: Int { identity.generation }
    private var target = ""
    private var cover: PanelCover?
    private var source: UIView?
    private var targetImage: UIImageView?
    private var capture = 0
    private var deadline: DispatchWorkItem?
    private var initialSize = CGSize.zero
    private var boundsObservation: NSKeyValueObservation?
    private var reply: ((Any?, String?) -> Void)?
    init(webView: WKWebView, host: @escaping () -> UIView, keyboardVisible: @escaping () -> Bool, dismissKeyboard: @escaping () -> Void) {
        self.webView = webView; self.host = host; self.keyboardVisible = keyboardVisible; self.dismissKeyboard = dismissKeyboard
        keyboardWillObserver = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard (note.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool) != false else { return }
                self?.hiddenCompletionSeen = false
            }
        }
        keyboardObserver = NotificationCenter.default.addObserver(forName: UIResponder.keyboardDidChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard (note.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool) != false else { return }
                self?.keyboardCompleted(note)
            }
        }
    }
    deinit { if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }; if let keyboardWillObserver { NotificationCenter.default.removeObserver(keyboardWillObserver) } }
    private func keyboardCompleted(_ note: Notification) {
        guard let window = webView?.window,
              let screenFrame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let frame = window.screen.coordinateSpace.convert(screenFrame, to: window)
        let usable = window.bounds.inset(by: UIEdgeInsets(top: 0, left: 0, bottom: window.safeAreaInsets.bottom, right: 0))
        lastKeyboardOccludes = NativePanelKeyboardGate.occludes(frame: frame, usable: usable)
        hiddenCompletionSeen = !lastKeyboardOccludes
        refreshKeyboardReadiness()
    }
    private func refreshKeyboardReadiness() {
        guard awaitingKeyboard, let webView, NativePanelKeyboardGate.ready(didHide: hiddenCompletionSeen, endOccludes: lastKeyboardOccludes,
            guideVisible: keyboardVisible(), moving: NativeReaderBridge.lookup(webView)?.keyboardMoving == true) else { return }
        awaitingKeyboard = false; trace(2)
        if menuSource, let callback = beginReply { beginReply = nil; captureMenuSource(reply: callback) }
        else if target == "chat", let callback = beginReply { beginReply = nil; captureSource(reply: callback) }
        else { webView.evaluateJavaScript("window.dispatchEvent(new Event('assistant-panel-source-request'));") }
    }
    private func trace(_ phase: Int) {
        #if DEBUG
        NSLog("PANEL_TRANSITION_PHASE phase=%d generation=%d keyboardWait=%d", phase, generation, awaitingKeyboard ? 1 : 0)
        #endif
    }
    func cancel() {
        trace(9)
        if let document {
            webView?.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('assistant-panel-transition-cancel',{detail:value}));", arguments: ["value": ["document": document, "generation": generation]], in: nil, in: .page) { _ in }
        }
        reset()
    }
    func reset() {
        capture += 1; deadline?.cancel(); deadline = nil
        boundsObservation = nil; keyboardBoundsObservation = nil
        awaitingSource = false; awaitingKeyboard = false
        menuSource = false
        beginReply?(["ok": false, "error": "cancelled"], nil); beginReply = nil
        targetImage?.removeFromSuperview(); targetImage = nil
        cover?.removeFromSuperview(); cover = nil; source = nil
        reply?(["ok": false, "error": "cancelled"], nil); reply = nil
    }
    func navigation() { cancel(); identity.navigation() }
    private func captureMenuSource(reply: @escaping (Any?, String?) -> Void) {
        guard let webView else { cancel(); reply(["ok": false, "error": "cancelled"], nil); return }
        let view = host(), epoch = capture, incoming = document, next = generation
        func ready() -> Bool {
            guard capture == epoch, document == incoming, generation == next else {
                reply(["ok": false, "error": "cancelled"], nil); return false
            }
            guard menuSource, awaitingSource, webView.window != nil,
                  !sourceIdentity.isEmpty, NativeReaderBridge.lookup(webView)?.presentationIdentity == sourceIdentity,
                  view.bounds.size == initialSize, view.bounds.width > 0, view.bounds.height > 0 else {
                cancel(); reply(["ok": false, "error": "cancelled"], nil); return false
            }
            guard !awaitingKeyboard, NativePanelKeyboardGate.ready(didHide: hiddenCompletionSeen, endOccludes: lastKeyboardOccludes,
                guideVisible: keyboardVisible(), moving: NativeReaderBridge.lookup(webView)?.keyboardMoving == true) else {
                awaitingKeyboard = true; beginReply = reply; return false
            }
            return true
        }
        let menuVisible = """
        (() => { const menu = document.querySelector('dialog.menu-dialog[open]');
        if (document.visibilityState !== 'visible' || !(menu instanceof HTMLDialogElement) || !menu.matches(':modal')) return false;
        const rect = menu.getBoundingClientRect(), style = getComputedStyle(menu);
        return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && Number(style.opacity) > 0; })()
        """
        guard ready() else { return }
        webView.evaluateJavaScript(menuVisible) { [weak self] value, error in
            guard let self, ready() else { return }
            guard error == nil, value as? Bool == true else {
                self.cancel(); reply(["ok": false, "error": "cancelled"], nil); return
            }
            view.layoutIfNeeded()
            guard ready() else { return }
            let snapshot = view.snapshotView(afterScreenUpdates: true)
            guard ready() else { return }
            guard let snapshot else {
                self.reset(); reply(["ok": false, "error": "snapshot_unavailable"], nil); return
            }
            webView.evaluateJavaScript(menuVisible) { [weak self] value, error in
                guard let self, ready() else { return }
                guard error == nil, value as? Bool == true else {
                    self.cancel(); reply(["ok": false, "error": "cancelled"], nil); return
                }
                let wrapper = PanelCover(frame: view.bounds)
                wrapper.backgroundColor = view.backgroundColor; wrapper.accessibilityViewIsModal = true
                snapshot.frame = wrapper.bounds; wrapper.addSubview(snapshot); view.addSubview(wrapper)
                self.cover = wrapper; self.source = snapshot; self.awaitingSource = false; self.trace(3)
                reply(["ok": true, "stage": "covered"], nil)
            }
        }
    }
    private func captureSource(reply: @escaping (Any?, String?) -> Void) {
        let view = host(), epoch = capture
        func ready() -> Bool {
            guard capture == epoch else {
                reply(["ok": false, "error": "cancelled"], nil); return false
            }
            guard awaitingSource, view.bounds.size == initialSize,
                  view.bounds.width > 0, view.bounds.height > 0 else {
                cancel(); reply(["ok": false, "error": "cancelled"], nil); return false
            }
            guard !awaitingKeyboard, NativePanelKeyboardGate.ready(didHide: hiddenCompletionSeen, endOccludes: lastKeyboardOccludes,
                guideVisible: keyboardVisible(), moving: webView.flatMap(NativeReaderBridge.lookup)?.keyboardMoving == true) else {
                if target == "chat" { awaitingKeyboard = true; beginReply = reply }
                else { reply(["ok": false, "error": "reader_pending"], nil) }
                return false
            }
            return true
        }
        view.layoutIfNeeded()
        guard ready() else { return }
        let captured = view.snapshotView(afterScreenUpdates: true)
        guard ready() else { return }
        guard let snapshot = captured else {
            reset(); reply(["ok": false, "error": "snapshot_unavailable"], nil); return
        }
        let wrapper = PanelCover(frame: view.bounds)
        wrapper.backgroundColor = view.backgroundColor; wrapper.accessibilityViewIsModal = true
        snapshot.frame = wrapper.bounds; wrapper.addSubview(snapshot); view.addSubview(wrapper)
        cover = wrapper; source = snapshot; awaitingSource = false; trace(3)
        reply(["ok": true, "stage": "covered"], nil)
    }
    func receive(_ packet: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        let version = packet["version"] as? Int
        let fromMenu = version == 3 && packet["source"] as? String == "menu"
            && packet["kind"] as? String == "begin" && packet["target"] as? String == "panel"
        let toMenu = version == 4 && packet["source"] == nil && packet["target"] as? String == "menu"
        guard (version == 2 && packet["source"] == nil && packet["target"] as? String != "menu") || fromMenu || toMenu,
              let incoming = packet["document"] as? String, UUID(uuidString: incoming) != nil,
              let next = packet["generation"] as? Int, next > 0, next <= 9_007_199_254_740_991,
              let kind = packet["kind"] as? String, ["begin", "source", "finish", "cancel"].contains(kind),
              let destination = packet["target"] as? String, ["panel", "chat", "menu"].contains(destination),
              document == nil || document == incoming else { reply(["ok": false, "error": "invalid"], nil); return }
        if kind == "cancel" {
            guard identity.canAdvance(document: incoming, generation: next) else { reply(["ok": false, "error": "stale"], nil); return }
            reset(); identity.advance(document: incoming, generation: next); reply(["ok": true], nil); return
        }
        if kind == "begin" {
            guard identity.canAdvance(document: incoming, generation: next), let webView, webView.window != nil else { reply(["ok": false, "error": "stale"], nil); return }
            reset(); identity.advance(document: incoming, generation: next); target = destination; menuSource = fromMenu
            let view = host(); initialSize = view.bounds.size
            awaitingSource = true
            sourceIdentity = NativeReaderBridge.lookup(webView)?.presentationIdentity ?? []
            awaitingKeyboard = lastKeyboardOccludes || keyboardVisible() || NativeReaderBridge.lookup(webView)?.keyboardMoving == true
            keyboardBoundsObservation = webView.observe(\.bounds, options: [.new]) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.refreshKeyboardReadiness() }
            }
            boundsObservation = view.observe(\.bounds, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated {
                    guard let self, view.bounds.size != self.initialSize else { return }
                    self.cancel(); NSLog("PANEL_TRANSITION_ABORT resized")
                }
            }
            let limit = DispatchWorkItem { [weak self] in
                guard let self, self.generation == next else { return }
                self.cancel(); NSLog("PANEL_TRANSITION_ABORT timeout generation=%d", next)
            }
            deadline = limit; DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: limit)
            trace(1)
            dismissKeyboard()
            awaitingKeyboard = awaitingKeyboard || NativeReaderBridge.lookup(webView)?.keyboardMoving == true
            if menuSource {
                if awaitingKeyboard { beginReply = reply }
                else { captureMenuSource(reply: reply) }
            }
            else if destination == "panel" || destination == "menu" { reply(["ok": true, "stage": "waiting"], nil) }
            else if awaitingKeyboard { beginReply = reply }
            else { captureSource(reply: reply) }
            return
        }
        if kind == "source" {
            refreshKeyboardReadiness()
            guard identity.current(document: incoming, generation: next), awaitingSource, !menuSource, (target == "panel" || target == "menu"), destination == target else {
                reply(["ok": false, "error": "cancelled"], nil); return
            }
            guard let webView, NativeReaderBridge.lookup(webView)?.presentationIdentity == sourceIdentity else {
                cancel(); reply(["ok": false, "error": "cancelled"], nil); return
            }
            guard !awaitingKeyboard, let proof = packet["reader"] as? [String: Any],
                  NativeReaderBridge.lookup(webView)?.presentationMatches(proof) == true else {
                reply(["ok": false, "error": "reader_pending"], nil); return
            }
            captureSource(reply: reply); return
        }
        guard identity.current(document: incoming, generation: next), destination == target,
              cover != nil, self.reply == nil else { reply(["ok": false, "error": "stale"], nil); return }
        let view = host(); view.layoutIfNeeded()
        guard view.bounds.size == initialSize, let webView else {
            reset(); reply(["ok": false, "error": "geometry_changed"], nil); return
        }
        if target == "chat" {
            guard let proof = packet["reader"] as? [String: Any],
                  NativeReaderBridge.lookup(webView)?.presentationMatches(proof) == true else {
                reply(["ok": false, "error": "reader_pending"], nil); return
            }
        }
        self.reply = reply; capture += 1
        let request = capture, frame = webView.frame, offset = webView.scrollView.contentOffset
        let size = webView.scrollView.contentSize
        func captureTarget() {
            guard request == self.capture, next == self.generation else { return }
            let configuration = WKSnapshotConfiguration(); configuration.afterScreenUpdates = true
            webView.takeSnapshot(with: configuration) { [weak self] image, error in
                guard let self, request == self.capture, next == self.generation, let cover = self.cover,
                      let webView = self.webView else { return }
                guard let image, error == nil else {
                    self.reset(); return
                }
                guard self.host().bounds.size == self.initialSize, webView.frame == frame,
                      webView.scrollView.contentOffset == offset, webView.scrollView.contentSize == size,
                      destination != "chat" || (packet["reader"] as? [String: Any]).map({ NativeReaderBridge.lookup(webView)?.presentationMatches($0) == true }) == true else {
                    let callback = self.reply; self.reply = nil
                    callback?(["ok": false, "error": "geometry_changed"], nil); return
                }
                self.trace(4)
                let targetImage = UIImageView(image: image); targetImage.frame = frame
                self.host().insertSubview(targetImage, aboveSubview: webView)
                self.targetImage = targetImage
                cover.backgroundColor = .clear
                self.deadline?.cancel(); self.deadline = nil
                let duration = UIAccessibility.isReduceMotionEnabled ? 0 : 0.18
                UIView.animate(withDuration: duration, animations: { self.source?.alpha = 0 }) { [weak self] _ in
                    guard let self, request == self.capture, next == self.generation else { return }
                    let callback = self.reply; self.reply = nil
                    self.trace(5); self.reset(); callback?(["ok": true], nil)
                }
            }
        }
        if destination == "menu" {
            let menuReady = """
            (() => { const menu = document.querySelector('dialog.menu-dialog[open][data-native-covered]');
            if (document.visibilityState !== 'visible' || !(menu instanceof HTMLDialogElement) || !menu.matches(':modal')) return false;
            const rect = menu.getBoundingClientRect(), style = getComputedStyle(menu);
            return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && Number(style.opacity) === 1 && style.transform === 'none'; })()
            """
            webView.evaluateJavaScript(menuReady) { [weak self] value, error in
                guard let self, request == self.capture, next == self.generation else { return }
                guard error == nil, value as? Bool == true,
                      NativeReaderBridge.lookup(webView)?.presentationIdentity == self.sourceIdentity,
                      !self.keyboardVisible() else { self.cancel(); return }
                captureTarget()
            }
        } else { captureTarget() }
    }
}
#endif
