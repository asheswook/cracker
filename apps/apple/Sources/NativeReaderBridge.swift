#if os(iOS)
import UIKit
import WebKit

@MainActor
private final class ReaderMessageProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: NativeReaderBridge?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let owner else { replyHandler(["ok": false, "error": "unavailable"], nil); return }
        owner.receive(message, reply: replyHandler)
    }
}

@MainActor
final class NativeReaderBridge: NSObject {
    static var enabled: Bool { true }
    private static let bridges = NSMapTable<WKWebView, NativeReaderBridge>(keyOptions: .weakMemory, valueOptions: .weakMemory)
    static func lookup(_ webView: WKWebView) -> NativeReaderBridge? { bridges.object(forKey: webView) }
    private weak var webView: WKWebView?
    private let proxy = ReaderMessageProxy()
    private var observations: [NSKeyValueObservation] = []
    private var session = NativeReaderSession()
    private var geometry = 0
    private var snapshotRevision = 0
    private var geometryKey: [Double] = []
    private var eventQueued = false
    private var external = false
    private var movementGate = NativeReaderMovementGate()
    var keyboardMoving: Bool { movementGate.keyboardMoving }
    var bound: Bool { session.bound }
    var allowsComposerOverlay: Bool { bound && !session.suspended && !external }

    init(webView: WKWebView, configuration: WKWebViewConfiguration) {
        self.webView = webView
        super.init()
        proxy.owner = self
        Self.bridges.setObject(self, forKey: webView)
        configuration.userContentController.addScriptMessageHandler(proxy, contentWorld: .page, name: "assistantReader")
        let scroll = webView.scrollView
        observations = [
            scroll.observe(\.contentSize, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.geometryChanged() } },
            scroll.observe(\.bounds, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.geometryChanged() } },
            scroll.observe(\.isDecelerating, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.queueEvent() } },
            scroll.observe(\.contentOffset, options: [.new]) { [weak self] scroll, _ in MainActor.assumeIsolated {
                guard let self, self.bound, !self.session.suspended, !self.external else { return }
                if scroll.isDragging || scroll.isDecelerating {
                    self.session.mode = self.maximumOffset - Double(scroll.contentOffset.y) < 24 ? "follow" : "reading"
                }
                self.queueEvent()
            } }
        ]
        scroll.panGestureRecognizer.addTarget(self, action: #selector(panChanged(_:)))
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWill(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardDid(_:)), name: UIResponder.keyboardDidChangeFrameNotification, object: nil)
    }
    deinit { NotificationCenter.default.removeObserver(self) }
    func reset() {
        session.reset(); geometryKey = []; geometry += 1
        webView?.superview?.setNeedsLayout()
    }
    func setExternal(_ value: Bool) {
        guard external != value else { return }; external = value
        updateRoot(); queueEvent()
    }
    func keyboardBegan() { movementGate.keyboardWill(); queueEvent() }
    func keyboardEnded() { geometryChanged(); queueEvent() }
    @objc private func keyboardWill(_ note: Notification) {
        guard (note.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool) != false else { return }
        keyboardBegan()
    }
    @objc private func keyboardDid(_ note: Notification) {
        guard (note.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool) != false else { return }
        movementGate.keyboardDid(); keyboardEnded()
    }
    private var maximumOffset: Double {
        guard let scroll = webView?.scrollView else { return 0 }
        return Double(max(-scroll.adjustedContentInset.top, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height))
    }
    @objc private func panChanged(_ gesture: UIPanGestureRecognizer) {
        guard bound, !session.suspended, !external else { return }
        if gesture.state == .began { session.userBegan() }
        queueEvent()
    }
    var presentationIdentity: [String] {
        guard let document = session.document, let scope = session.scope else { return [] }
        return [document, scope, String(session.navigation), String(session.interaction), session.mode]
    }
    func presentationMatches(_ proof: [String: Any]) -> Bool {
        guard let webView, bound, !session.suspended, !external, !keyboardMoving,
              proof["document"] as? String == session.document,
              proof["scope"] as? String == session.scope,
              proof["navigation"] as? Int == session.navigation,
              proof["interaction"] as? Int == session.interaction,
              proof["geometry"] as? Int == geometry,
              let offset = proof["offset"] as? Double,
              let height = proof["height"] as? Double,
              let width = proof["width"] as? Double,
              let content = proof["contentHeight"] as? Double else { return false }
        let scroll = webView.scrollView
        return !scroll.isDragging && !scroll.isDecelerating &&
            abs(offset - Double(scroll.contentOffset.y)) <= 1 && abs(height - Double(scroll.bounds.height)) <= 1 &&
            abs(width - Double(scroll.bounds.width)) <= 1 && abs(content - Double(scroll.contentSize.height)) <= 1
    }
    private func updateRoot() {
        webView?.superview?.setNeedsLayout()
    }
    private func snapshot() -> [String: Any]? {
        guard let webView, let document = session.document, let scope = session.scope else { return nil }
        let scroll = webView.scrollView
        snapshotRevision += 1
        return ["v": 1, "document": document, "scope": scope, "navigation": session.navigation,
                "interaction": session.interaction, "geometry": geometry, "sequence": session.sequence,
                "revision": snapshotRevision, "mode": session.mode,
                "offset": Double(scroll.contentOffset.y), "contentHeight": Double(scroll.contentSize.height),
                "width": Double(scroll.bounds.width), "height": Double(scroll.bounds.height),
                "headerHeight": 0,
                "bottomInset": Double(max(0, scroll.adjustedContentInset.bottom)),
                "keyboardMoving": keyboardMoving, "suspended": session.suspended || external,
                "dragging": scroll.isDragging || scroll.isDecelerating || scroll.panGestureRecognizer.state == .began || scroll.panGestureRecognizer.state == .changed]
    }
    func geometryChanged() {
        guard let scroll = webView?.scrollView else { return }
        let key = [Double(scroll.bounds.width), Double(scroll.bounds.height), Double(scroll.contentSize.height),
                   Double(scroll.adjustedContentInset.top), Double(scroll.adjustedContentInset.bottom)]
        guard key != geometryKey else { return }
        geometryKey = key; geometry += 1; queueEvent()
    }
    private func queueEvent() {
        guard bound, !eventQueued else { return }; eventQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }; self.eventQueued = false
            guard let snapshot = self.snapshot(), let webView = self.webView else { return }
            webView.callAsyncJavaScript("return window.__assistantReaderEvent?.(snapshot);", arguments: ["snapshot": snapshot], in: nil, in: .page) { _ in }
        }
    }
    fileprivate func receive(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        let expected = AppConfiguration.origin, origin = message.frameInfo.securityOrigin
        guard message.webView === webView, message.frameInfo.isMainFrame,
              origin.protocol == expected.scheme, origin.host == expected.host,
              AppConfiguration.matchesOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
              let webView, let url = webView.url, AppConfiguration.isAppURL(url),
              let packet = NativeReaderPacket.parse(message.body) else {
            reply(["ok": false, "error": "unavailable"], nil); return
        }
        func finish(_ error: String? = nil) {
            var response: [String: Any] = ["ok": error == nil]
            if let error { response["error"] = error }
            if let snapshot = self.snapshot() { response["snapshot"] = snapshot }
            reply(response, nil)
        }
        if let error = session.error(for: packet) { finish(error); return }
        if session.duplicate(packet) { finish(); return }
        if packet.kind == "release" { session.release(); updateRoot(); finish(); return }
        if packet.kind == "bind" {
            let scroll = webView.scrollView
            if packet.suspended != true && (scroll.isDragging || scroll.isDecelerating || scroll.panGestureRecognizer.state == .began || scroll.panGestureRecognizer.state == .changed) {
                finish("busy"); return
            }
            session.accept(packet); geometryChanged(); updateRoot(); finish(); return
        }
        let scroll = webView.scrollView
        geometryChanged()
        guard packet.matchesGeometryRevision(geometry) else { finish("stale_geometry"); return }
        let dragging = scroll.isDragging || scroll.isDecelerating || scroll.panGestureRecognizer.state == .began || scroll.panGestureRecognizer.state == .changed
        guard movementGate.allows(suspended: session.suspended || external, dragging: dragging) else { finish("busy"); return }
        guard abs(scroll.zoomScale - 1) < 0.001 else { finish("unsupported_scale"); return }
        if packet.kind == "layout" {
            guard packet.matchesGeometry(width: Double(scroll.bounds.width), height: Double(scroll.bounds.height),
                                         contentHeight: Double(scroll.contentSize.height)) else { finish("geometry_pending"); return }
        }
        session.accept(packet); updateRoot()
        if packet.mode == "follow" {
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: maximumOffset), animated: false)
        } else if let offset = packet.offset {
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(maximumOffset, max(-Double(scroll.adjustedContentInset.top), offset))), animated: false)
        }
        finish()
    }
}
#endif
