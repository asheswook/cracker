#if os(iOS)
import UIKit
import WebKit

@MainActor
private final class FooterSurface: WKWebView {
    var floating = false
    var controls: [CGRect]?
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard super.point(inside: point, with: event) else { return false }
        guard floating, let controls else { return true }
        return controls.contains { $0.contains(point) }
    }
}

@MainActor
private final class FooterMessageProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: IndependentFooterController?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let owner else { replyHandler(["ok": false, "error": "footer_unavailable"], nil); return }
        owner.receive(message, reply: replyHandler)
    }
}

@MainActor
final class IndependentFooterController: NSObject, WKNavigationDelegate {
    static var enabled: Bool { true }
    private static let owners = NSMapTable<WKWebView, IndependentFooterController>(keyOptions: .weakMemory, valueOptions: .weakMemory)
    static func lookup(_ webView: WKWebView) -> IndependentFooterController? { owners.object(forKey: webView) }
    private weak var body: WKWebView?
    private weak var host: UIView?
    private weak var tray: UIView?
    private let footer: FooterSurface
    private let footprint = UIView()
    private let proxy = FooterMessageProxy()
    private var heightConstraint: NSLayoutConstraint?
    private var viewportHeight: NSLayoutConstraint?
    private var fullWidth: NSLayoutConstraint?
    private var floatingWidth: NSLayoutConstraint?
    private var trayBottom: NSLayoutConstraint?
    private var guideBottom: NSLayoutConstraint?
    private var session = IndependentFooterSession()
    private var intrinsicHeight: Double = 0
    private var external = false
    private var composerVisible = false
    private var pending: [String: (payload: NSDictionary, replies: [(Any?, String?) -> Void])] = [:]
    private var completed: [String: (payload: NSDictionary, result: [String: Any])] = [:]
    private var completedOrder: [String] = []
    var collapsedChanged: ((Bool) -> Void)?
    private var collapsed = false
    private var negotiation: DispatchWorkItem?
    private var negotiationID: UUID?
    private var unavailable = false
    private let diagnosticRun = UUID().uuidString
    private var diagnosticCount = 0
    private func trace(_ stage: Int, _ value: Double = -1, _ other: Double = -1) {}
    private func traceDOM() {}
    var bottomAnchor: NSLayoutYAxisAnchor { footprint.topAnchor }
    var reservedHeight: CGFloat { heightConstraint?.constant ?? 0 }
    var accessibilitySurface: UIView { footer }

    init(body: WKWebView, configuration: WKWebViewConfiguration) {
        self.body = body
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "AssistantNativeFooter"
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        if HybridLatestTrace.enabled {
            config.userContentController.addUserScript(WKUserScript(source: "window.__ASSISTANT_LATEST_TRACE__ = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__ASSISTANT_HYBRID_ROLE__ = \"footer\";",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        footer = FooterSurface(frame: .zero, configuration: config)
        super.init()
        proxy.owner = self
        configuration.userContentController.addScriptMessageHandler(proxy, contentWorld: .page, name: "assistantFooter")
        config.userContentController.addScriptMessageHandler(proxy, contentWorld: .page, name: "assistantFooter")
        footer.navigationDelegate = self
        footer.isOpaque = false; footer.backgroundColor = .clear; footer.scrollView.backgroundColor = .clear
        footer.scrollView.isScrollEnabled = false; footer.scrollView.bounces = false
        footer.scrollView.delaysContentTouches = false
        footer.scrollView.canCancelContentTouches = true
        footer.scrollView.contentInsetAdjustmentBehavior = .never
        footer.isHidden = true; footer.isInspectable = false
        footer.accessibilityIdentifier = "independent-footer-surface"
        Self.owners.setObject(self, forKey: body)
    }

    func attach(to host: UIView, tray: UIView) {
        trace(1)
        guard self.host == nil else { return }
        self.host = host; self.tray = tray
        footprint.translatesAutoresizingMaskIntoConstraints = false
        footprint.clipsToBounds = true
        footprint.isUserInteractionEnabled = false
        footer.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(footprint)
        host.addSubview(footer)
        heightConstraint = footprint.heightAnchor.constraint(equalToConstant: 0)
        viewportHeight = footer.heightAnchor.constraint(equalToConstant: 1)
        fullWidth = footer.widthAnchor.constraint(equalTo: host.widthAnchor)
        floatingWidth = footer.widthAnchor.constraint(equalToConstant: 160)
        trayBottom = footprint.bottomAnchor.constraint(equalTo: tray.topAnchor)
        guideBottom = footprint.bottomAnchor.constraint(equalTo: host.keyboardLayoutGuide.topAnchor)
        NSLayoutConstraint.activate([footprint.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            footprint.trailingAnchor.constraint(equalTo: host.trailingAnchor), heightConstraint!, guideBottom!,
            footer.centerXAnchor.constraint(equalTo: host.centerXAnchor), fullWidth!,
            footer.bottomAnchor.constraint(equalTo: footprint.bottomAnchor), viewportHeight!])

    }

    func setComposerVisible(_ value: Bool) {
        composerVisible = value
        if value { guideBottom?.isActive = false; trayBottom?.isActive = true }
        else { trayBottom?.isActive = false; guideBottom?.isActive = true }
        layout()
    }
    func start() { if footer.url == nil { footer.load(URLRequest(url: AppConfiguration.origin)) } }

    func setExternalPresentation(_ value: Bool) { external = value; layout() }
    func resetMain() {
        trace(2)
        negotiation?.cancel(); negotiation = nil; negotiationID = nil; unavailable = false
        session.resetMain(); intrinsicHeight = 0; clearCommands(); layout()
    }
    func requestedHeight(available: CGFloat) -> CGFloat {
        guard session.visible, !external, let body else { return 0 }
        return CGFloat(IndependentFooterLayout.height(requested: intrinsicHeight, available: Double(available),
            header: Double(IndependentHeaderController.headerHeight(body))))
    }
    func prepare(available: CGFloat) {
        let height = requestedHeight(available: available)
        let floating = session.state?.latestOnly == true
        footer.floating = floating
        if floating { fullWidth?.isActive = false; floatingWidth?.isActive = true }
        else { floatingWidth?.isActive = false; fullWidth?.isActive = true }
        let reservedHeight = floating ? 0 : height
        if heightConstraint?.constant != reservedHeight { heightConstraint?.constant = reservedHeight }
        viewportHeight?.constant = max(1, height)
        footer.isHidden = height == 0
        let nextCollapsed = session.visible && !external && intrinsicHeight > 0 && height == 0
        if nextCollapsed && !composerVisible {
            fallback("Footer needs the standard conversation layout")
            return
        }
        if nextCollapsed != collapsed { collapsed = nextCollapsed; collapsedChanged?(collapsed) }
    }
    func layout() {
        guard let host, let body, let tray else { return }
        let bottom = composerVisible ? tray.frame.minY : host.keyboardLayoutGuide.layoutFrame.minY
        prepare(available: max(0, bottom - body.frame.minY))
    }
    private func valid(_ view: WKWebView) -> Bool { view.url.map(AppConfiguration.isAppURL) == true }
    private func clearCommands() {
        let callbacks = pending.values.flatMap(\.replies)
        pending.removeAll(); completed.removeAll(); completedOrder.removeAll()
        callbacks.forEach { $0(["ok": false, "error": "stale_event"], nil) }
    }
    fileprivate func receive(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin, expected = AppConfiguration.origin
        let port = expected.scheme == "https" ? 443 : 80
        guard message.frameInfo.isMainFrame, let sender = message.webView, sender === body || sender === footer,
              valid(sender), origin.protocol == expected.scheme, origin.host == expected.host,
              (origin.port == 0 ? port : origin.port) == (expected.port ?? port),
              let packet = HeaderWire.object(message.body, limit: 256 * 1024), let kind = packet["kind"] as? String else {
            reply(["ok": false, "error": "invalid_footer_packet"], nil); return
        }
        let finish: (Bool) -> Void = { reply($0 ? ["ok": true] : ["ok": false, "error": "stale_event"], nil) }
        if kind == "diagnostic", sender === footer, HybridLatestTrace.enabled,
           let stage = HeaderWire.integer(packet["stage"]), (1...4).contains(stage) {
            HybridLatestTrace.record(stage)
            finish(true); return
        }
        trace(sender === body ? 3 : 4, Double(["state", "active", "fallback", "ready", "geometry", "action"].firstIndex(of: kind) ?? -1), Double(HeaderWire.integer(packet["generation"]) ?? -1))
        if sender === body {
            switch kind {
            case "state":
                guard !unavailable else { reply(["ok": false, "error": "footer_unavailable"], nil); return }
                let previousScope = session.state?.scope
                guard let next = IndependentFooterState.parse(packet), session.accept(next) else { trace(5); finish(false); return }
                trace(6)
                if !next.visible || previousScope != next.scope { negotiation?.cancel(); negotiation = nil; negotiationID = nil }
                if negotiation == nil && session.activeGeneration == nil && next.visible {
                    let document = next.document, scope = next.scope
                    let identifier = UUID(); negotiationID = identifier
                    let timeout = DispatchWorkItem { [weak self] in
                        guard let self, self.negotiationID == identifier,
                              self.session.state?.document == document, self.session.state?.scope == scope,
                              self.session.state?.visible == true, self.session.activeGeneration == nil else { return }
                        self.fallback("Footer connection timed out")
                    }
                    negotiation = timeout
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: timeout)
                }
                layout(); render(); finish(true)
            case "active":
                let accepted = session.activate(packet)
                trace(7, accepted ? 1 : 0, Double(HeaderWire.integer(packet["revision"]) ?? -1))
                if accepted { negotiation?.cancel(); negotiation = nil; negotiationID = nil }
                finish(accepted); layout()
            case "fallback":
                guard packet["document"] as? String == session.state?.document || session.state == nil else { finish(false); return }
                resetMain(); finish(true)
            default: finish(false)
            }
            return
        }
        switch kind {
        case "fallback":
            guard session.matches(packet) else { finish(false); return }
            fallback("Footer connection failed"); finish(true)
        case "ready":
            guard let document = HeaderWire.uuid(packet["document"]) else { finish(false); return }
            if session.footerDocument != document { clearCommands(); intrinsicHeight = 0 }
            session.ready(document); layout(); render(); finish(true)
        case "geometry":
            trace(8, HeaderWire.number(packet["width"]) ?? -1, HeaderWire.number(packet["intrinsicHeight"]) ?? -1)
            guard session.matches(packet), let width = HeaderWire.number(packet["width"]),
                  let requested = HeaderWire.number(packet["intrinsicHeight"]), requested >= 0, requested <= 1_000_000,
                  abs(width - Double(footer.bounds.width)) <= 1 else { trace(9); finish(false); return }
            var controls: [CGRect]?
            if let raw = packet["controls"] {
                guard let rows = raw as? [[Any]], rows.count <= 16 else { finish(false); return }
                var rectangles: [CGRect] = []
                for row in rows {
                    guard row.count == 4, let x = HeaderWire.number(row[0]), let y = HeaderWire.number(row[1]),
                          let w = HeaderWire.number(row[2]), let h = HeaderWire.number(row[3]),
                          x >= 0, y >= 0, w >= 0, h >= 0, x + w <= width + 1, y + h <= requested + 1 else {
                        finish(false); return
                    }
                    rectangles.append(CGRect(x: x, y: y, width: w, height: h))
                }
                controls = rectangles
            }
            guard session.geometry(packet) else { finish(false); return }
            footer.controls = controls
            trace(10)
            intrinsicHeight = requested
            layout()
            guard session.state?.visible == true else { finish(true); return }
            guard let event = session.event("activate") else { finish(false); return }
            callBody(event) { [weak self] result in
                self?.trace(11, Self.ok(result) ? 1 : 0, Double(HeaderWire.integer(event["revision"]) ?? -1))
                guard let self, self.current(event), HeaderWire.integer(event["revision"]) == self.session.activationRevision else { return }
                if !Self.ok(result) { self.fallback("Footer activation failed") }
            }
            finish(true)
        case "action": action(packet, reply: reply)
        default: finish(false)
        }
    }
    private func render() {
        guard let state = session.state, let document = session.footerDocument, valid(footer) else { return }
        var wire = state.wire; wire["footerDocument"] = document
        footer.callAsyncJavaScript("return await window.__assistantFooterRender(state);", arguments: ["state": wire], in: nil, in: .page) { [weak self] result in
            if case .success(let value) = result { self?.trace(12, Self.ok(value as? [String: Any]) ? 1 : 0, Double(state.generation)) }
            else { self?.trace(12, -1, Double(state.generation)) }
            self?.traceDOM()
            guard let self, self.session.state?.document == state.document,
                  self.session.state?.generation == state.generation, self.session.footerDocument == document else { return }
            guard case .success(let value) = result, Self.ok(value as? [String: Any]) else { self.fallback("Footer render failed"); return }
        }
    }
    private func current(_ event: [String: Any]) -> Bool {
        guard let state = session.state else { return false }
        return event["document"] as? String == state.document && event["scope"] as? String == state.scope &&
            HeaderWire.integer(event["generation"]) == state.generation && event["footerDocument"] as? String == session.footerDocument
    }
    private static func ok(_ value: [String: Any]?) -> Bool { HeaderWire.boolean(value?["ok"]) == true }
    private func callBody(_ event: [String: Any], completion: @escaping ([String: Any]?) -> Void) {
        guard let body, valid(body) else { completion(nil); return }
        body.callAsyncJavaScript("return await window.__assistantFooterEvent(event);", arguments: ["event": event], in: nil, in: .page) { result in
            if case .success(let value) = result { completion(value as? [String: Any]) } else { completion(nil) }
        }
    }
    private func action(_ packet: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        HybridLatestTrace.record(10, [packet["action"] as? String == "latest" ? 1 : 0, session.action(packet) ? 1 : 0])
        guard !external, session.action(packet), let command = packet["commandId"] as? String else {
            reply(["ok": false, "error": "stale_event"], nil); return
        }
        let payload = NSDictionary(dictionary: packet)
        if let done = completed[command] { reply(done.payload.isEqual(payload) ? done.result : ["ok": false, "error": "command_mismatch"], nil); return }
        if var waiting = pending[command] {
            guard waiting.payload.isEqual(payload), waiting.replies.count < 16 else { reply(["ok": false, "error": "command_mismatch"], nil); return }
            waiting.replies.append(reply); pending[command] = waiting; return
        }
        guard pending.count < 32, var event = session.event("action") else { reply(["ok": false, "error": "footer_busy"], nil); return }
        event["commandId"] = command; event["action"] = packet["action"]; event["draftId"] = packet["draftId"]
        pending[command] = (payload, [reply])
        callBody(event) { [weak self] result in
            HybridLatestTrace.record(11, [Self.ok(result) ? 1 : 0,
                Double(["reader_busy", "reader_rejected", "stale_event", "stale_revision", "action_unavailable"].firstIndex(of: result?["error"] as? String ?? "") ?? -1)])
            guard let self, let waiting = self.pending.removeValue(forKey: command) else { return }
            let answer = result ?? ["ok": false, "error": "footer_transport_failed"]
            self.completed[command] = (waiting.payload, answer); self.completedOrder.append(command)
            if self.completedOrder.count > 256 { self.completed.removeValue(forKey: self.completedOrder.removeFirst()) }
            waiting.replies.forEach { $0(answer, nil) }
            let failure = result?["error"] as? String
            let rejection = ["stale_event", "stale_revision", "stale_footer", "inactive_footer", "hidden",
                             "action_unavailable", "action_failed", "reader_busy", "reader_rejected", "command_capacity"]
            if self.current(event), !Self.ok(result), failure.map({ !rejection.contains($0) }) ?? true {
                self.fallback("Footer action transport failed")
            }
        }
    }
    private func fallback(_ reason: String) {
        trace(13, Double(["Footer connection timed out", "Footer connection failed", "Footer activation failed", "Footer render failed", "Footer action transport failed", "Footer navigation", "Footer load failed", "Footer navigation failed", "Footer process stopped", "Footer needs the standard conversation layout"].firstIndex(of: reason) ?? -1))
        negotiation?.cancel(); negotiation = nil; negotiationID = nil; unavailable = true
        if session.footerDocument == nil { session.ready(UUID().uuidString) }
        if var event = session.event("fallback"), let body, valid(body) {
            event["reason"] = reason
            body.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('assistant-footer-fallback', {detail: event})); return true;",
                arguments: ["event": event], in: nil, in: .page) { _ in }
        }
        session.resetFooter(); intrinsicHeight = 0; clearCommands(); layout()
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url.map(AppConfiguration.isAppURL) == true ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if session.footerDocument != nil { fallback("Footer navigation") }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fallback("Footer load failed") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fallback("Footer navigation failed") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fallback("Footer process stopped") }
}
#endif
