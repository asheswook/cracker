#if os(iOS)
import UIKit
import WebKit

@MainActor
private final class HeaderSurface: WKWebView {
    var controls: [CGRect] = []
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event) && controls.contains { $0.contains(point) }
    }
}

@MainActor
private final class HeaderMessageProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: IndependentHeaderController?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let owner else { replyHandler(["ok": false, "error": "Header owner unavailable"], nil); return }
        owner.receive(message, reply: replyHandler)
    }
}

@MainActor
final class IndependentHeaderController: NSObject, WKNavigationDelegate {
    static var enabled: Bool { true }
    private static let owners = NSMapTable<WKWebView, IndependentHeaderController>(keyOptions: .weakMemory, valueOptions: .weakMemory)
    static func lookup(_ webView: WKWebView) -> IndependentHeaderController? { owners.object(forKey: webView) }
    static func headerHeight(_ webView: WKWebView) -> CGFloat {
        guard let owner = lookup(webView), !owner.header.isHidden else { return 0 }
        return min(owner.contentHeight, owner.header.bounds.height)
    }
    private weak var bodyWebView: WKWebView?
    private weak var host: UIView?
    private let header: HeaderSurface
    private let proxy = HeaderMessageProxy()
    private var contentHeight: CGFloat = 0
    private var trayBottom: NSLayoutConstraint?
    private var guideBottom: NSLayoutConstraint?
    private var session = IndependentHeaderSession()
    private var external = false
    private var reloads = 0
    #if DEBUG
    private var compactProbe: CompactGeometryProbe?
    #endif

    init(bodyWebView: WKWebView, configuration: WKWebViewConfiguration) {
        self.bodyWebView = bodyWebView
        let headerConfiguration = WKWebViewConfiguration()
        headerConfiguration.websiteDataStore = .default()
        headerConfiguration.applicationNameForUserAgent = "AssistantNativeHeader"
        headerConfiguration.preferences.javaScriptCanOpenWindowsAutomatically = false
        headerConfiguration.userContentController.addUserScript(WKUserScript(
            source: "window.__ASSISTANT_HYBRID_ROLE__ = \"header\";",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        header = HeaderSurface(frame: .zero, configuration: headerConfiguration)
        super.init()
        proxy.owner = self
        configuration.userContentController.addScriptMessageHandler(proxy, contentWorld: .page, name: "assistantHeader")
        headerConfiguration.userContentController.addScriptMessageHandler(proxy, contentWorld: .page, name: "assistantHeader")
        header.navigationDelegate = self
        header.isOpaque = false
        header.backgroundColor = .clear
        header.scrollView.backgroundColor = .clear
        header.scrollView.isScrollEnabled = false
        header.scrollView.bounces = false
        header.scrollView.contentInsetAdjustmentBehavior = .never
        header.isHidden = true
        #if DEBUG
        header.isInspectable = true
        #endif
        header.accessibilityIdentifier = "independent-header-surface"
        Self.owners.setObject(self, forKey: bodyWebView)
    }

    func attach(to host: UIView, tray: UIView) {
        guard self.host == nil, let bodyWebView else { return }
        self.host = host
        #if DEBUG
        compactProbe = CompactGeometryProbe(host: host, tray: tray, header: header, body: bodyWebView)
        #endif
        header.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(header)
        trayBottom = header.bottomAnchor.constraint(equalTo: tray.topAnchor)
        guideBottom = header.bottomAnchor.constraint(equalTo: host.keyboardLayoutGuide.topAnchor)
        NSLayoutConstraint.activate([header.topAnchor.constraint(equalTo: host.topAnchor),
            header.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: host.trailingAnchor), guideBottom!])
        if let footer = IndependentFooterController.lookup(bodyWebView) {
            host.accessibilityElements = [header, bodyWebView, footer.accessibilitySurface, tray]
        } else { host.accessibilityElements = [header, bodyWebView, tray] }

    }

    func start() { if header.url == nil { header.load(URLRequest(url: AppConfiguration.origin)) } }
    func setComposerVisible(_ visible: Bool) {
        if visible { guideBottom?.isActive = false; trayBottom?.isActive = true }
        else { trayBottom?.isActive = false; guideBottom?.isActive = true }
    }

    func setExternalPresentation(_ value: Bool) { external = value; updateVisibility() }
    func resetMain() { session.resetMain(); updateVisibility(); reloads = 0 }
    private func updateVisibility() {
        header.isHidden = external || !session.visible
        if let bodyWebView { NativeReaderBridge.lookup(bodyWebView)?.geometryChanged() }
    }
    private func valid(_ webView: WKWebView) -> Bool {
        guard let url = webView.url else { return false }
        return AppConfiguration.isAppURL(url)
    }

    fileprivate func receive(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        let expected = AppConfiguration.origin
        let defaultPort = expected.scheme == "https" ? 443 : 80
        guard message.frameInfo.isMainFrame, let sender = message.webView,
              sender === bodyWebView || sender === header, valid(sender),
              origin.protocol == expected.scheme, origin.host == expected.host,
              (origin.port == 0 ? defaultPort : origin.port) == (expected.port ?? defaultPort),
              let packet = HeaderWire.object(message.body), let kind = packet["kind"] as? String else {
            reply(["ok": false, "error": "Invalid header source or packet"], nil); return
        }
        let finish: (Bool) -> Void = { reply($0 ? ["ok": true] : ["ok": false, "error": "Stale or invalid header command"], nil) }
        if sender === bodyWebView {
            switch kind {
            case "state":
                guard let next = IndependentHeaderState.parse(packet), session.accept(next) else { recordRejection(7, packet); finish(false); return }
                updateVisibility(); render(); finish(true)
            case "active":
                let accepted = session.activate(packet)
                if !accepted { recordRejection(6, packet) }
                finish(accepted); updateVisibility()
            case "fallback":
                guard let document = HeaderWire.uuid(packet["document"]), session.state == nil || document == session.state?.document else { finish(false); return }
                recordRejection(8, packet)
                session.resetMain(); updateVisibility(); finish(true)
            default: finish(false)
            }
            return
        }
        switch kind {
        case "ready":
            guard let document = HeaderWire.uuid(packet["document"]) else { finish(false); return }
            session.ready(document); updateVisibility(); render(); finish(true)
        case "geometry":
            guard let geometry = IndependentHeaderGeometry.parse(packet) else { recordRejection(1, packet); fallback("Header geometry rejected"); finish(false); return }
            guard session.geometry(geometry) else { recordRejection(2, packet); finish(false); return }
            guard let window = host?.window else { recordRejection(3, packet); fallback("Header geometry rejected"); finish(false); return }
            guard geometry.height <= window.bounds.height else { recordRejection(4, packet); fallback("Header geometry rejected"); finish(false); return }
            guard geometry.rectangles.allSatisfy({ $0[0] + $0[2] <= Double(header.bounds.width) + 1 }) else { recordRejection(5, packet); fallback("Header geometry rejected"); finish(false); return }
            header.controls = geometry.rectangles.map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) }
            contentHeight = CGFloat(geometry.height)
            if let bodyWebView {
                NativeReaderBridge.lookup(bodyWebView)?.geometryChanged()
                IndependentFooterController.lookup(bodyWebView)?.layout()
            }
            sendEvent(kind: "activate") { _ in }
            finish(true)
        case "action":
            guard !external, session.action(packet), let state = session.state,
                  let headerDocument = session.headerDocument else { reply(["ok": false, "error": "stale_event"], nil); return }
            var event = packet
            event["document"] = state.document
            event["headerDocument"] = headerDocument
            event.removeValue(forKey: "mainDocument")
            callBody(event) { [weak self] result in
                guard let self else { reply(["ok": false, "error": "header_transport_failed"], nil); return }
                let accepted = result == .accepted
                guard self.session.state?.document == state.document,
                      self.session.state?.generation == state.generation,
                      self.session.headerDocument == headerDocument else {
                    reply(["ok": accepted, "error": "stale_event"], nil); return
                }
                if result == .stale { reply(["ok": false, "error": "stale_event"], nil); return }
                if !accepted { self.fallback("Header action transport failed") }
                reply(accepted ? ["ok": true] : ["ok": false, "error": "header_transport_failed"], nil)
            }
        default: finish(false)
        }
    }

    private func render() {
        guard let state = session.state, let headerDocument = session.headerDocument, valid(header) else { return }
        var wire = state.wire
        wire["headerDocument"] = headerDocument
        header.callAsyncJavaScript("return await window.__assistantHeaderRender(state);", arguments: ["state": wire], in: nil, in: .page) { [weak self] result in
            guard let self, self.session.state?.document == state.document,
                  self.session.state?.generation == state.generation, self.session.headerDocument == headerDocument else { return }
            guard case .success(let value) = result,
                  let reply = value as? [String: Any], HeaderWire.boolean(reply["ok"]) == true else { self.fallback("Header render failed"); return }
        }
    }
    private func callBody(_ event: [String: Any], completion: @escaping (IndependentHeaderReply) -> Void) {
        guard let bodyWebView, valid(bodyWebView) else { completion(.failed); return }
        let source = event["kind"] as? String == "fallback"
            ? "window.dispatchEvent(new CustomEvent('assistant-header-fallback', {detail: event})); return {ok: true};"
            : "return await window.__assistantHeaderEvent(event);"
        bodyWebView.callAsyncJavaScript(source, arguments: ["event": event], in: nil, in: .page) { result in
            if case .success(let value) = result { completion(IndependentHeaderReply.parse(value)) }
            else { completion(.failed) }
        }
    }
    private func sendEvent(kind: String, reason: String? = nil, completion: @escaping (Bool) -> Void) {
        guard let state = session.state else { completion(false); return }
        var event: [String: Any] = ["v": 1, "kind": kind, "document": state.document,
            "headerDocument": session.headerDocument ?? UUID().uuidString, "generation": state.generation, "scope": state.scope]
        if let reason { event["reason"] = reason }
        callBody(event) { completion($0 == .accepted) }
    }
    private func recordRejection(_ reason: Int, _ packet: [String: Any]? = nil) {
        #if DEBUG
        compactProbe?.rejection(reason, packet: packet, generation: session.state?.generation)
        #endif
    }
    private func fallback(_ reason: String) {
        let reasonCode = ["Header geometry rejected": 10, "Header action transport failed": 11,
                          "Header render failed": 12, "Header navigation": 13, "Header load failed": 14,
                          "Header navigation failed": 15, "Header process stopped": 16][reason] ?? 19
        recordRejection(reasonCode)
        sendEvent(kind: "fallback", reason: reason) { _ in }
        session.resetHeader(); updateVisibility()
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url.map(AppConfiguration.isAppURL) == true ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if session.headerDocument != nil { fallback("Header navigation"); }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fallback("Header load failed") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fallback("Header navigation failed") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fallback("Header process stopped")
        if reloads == 0 { reloads += 1; header.reload() }
    }
}
#endif
