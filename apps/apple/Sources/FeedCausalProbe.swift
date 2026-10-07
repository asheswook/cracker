#if DEBUG && FEED_CAUSAL_DIAGNOSTICS && os(iOS)
import UIKit
import WebKit

@MainActor
final class FeedCausalProbe: NSObject, WKScriptMessageHandler {
    static var enabled: Bool {
        AppConfiguration.origin.scheme == "http" && AppConfiguration.origin.host == "127.0.0.1" &&
            ProcessInfo.processInfo.arguments.contains("--qa-feed-causal")
    }
    private static let probes = NSMapTable<WKWebView, FeedCausalProbe>(keyOptions: .weakMemory, valueOptions: .weakMemory)
    static func lookup(_ view: WKWebView) -> FeedCausalProbe? { probes.object(forKey: view) }
    private weak var webView: WKWebView?
    private weak var host: UIView?
    private weak var tray: UIView?
    private var displayLink: CADisplayLink?
    private var active = false
    private var cycle = 0
    private let run = UUID().uuidString
    private var start = 0.0
    private var epoch = 0.0
    private var rows: [[String: Any]] = []
    private var javascript: [String: Any]?
    private var lastTrayHeight: CGFloat?
    private var lastKeyboard = CGRect.zero
    private var duration = 0.0
    private var curve = -1.0
    private var dropped = 0

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
        Self.probes.setObject(self, forKey: webView)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardDid(_:)),
            name: UIResponder.keyboardDidChangeFrameNotification, object: nil)
    }
    deinit { displayLink?.invalidate(); NotificationCenter.default.removeObserver(self) }

    func attach(host: UIView, tray: UIView) { self.host = host; self.tray = tray }
    func layout() {
        guard let height = tray?.bounds.height, height > 0 else { return }
        let before = lastTrayHeight
        lastTrayHeight = height
        guard let before, abs(before - height) > 0.5 else { return }
        begin(trigger: 2)
        collect(kind: 2, extras: [Double(before), Double(height)])
    }
    func keyboardWill(_ notification: Notification) {
        let info = notification.userInfo ?? [:]
        lastKeyboard = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero
        duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? -1
        curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.doubleValue ?? -1
        begin(trigger: 1)
        collect(kind: 1)
    }
    @objc private func keyboardDid(_ notification: Notification) { collect(kind: 6) }
    func emitted(_ detail: [String: Any]) {
        collect(kind: 3, extras: ["startTime", "duration", "fromHeight", "toHeight", "width", "curve"].map {
            (detail[$0] as? NSNumber)?.doubleValue ?? -1
        })
    }
    func deliveryFinished(_ success: Bool) { collect(kind: 4, extras: [success ? 1 : 0]) }

    private func begin(trigger: Int) {
        guard !active, cycle < 12, let webView, let url = webView.url, AppConfiguration.isAppURL(url),
              host?.window != nil else { return }
        cycle += 1; active = true; start = CACurrentMediaTime(); epoch = Date().timeIntervalSince1970 * 1000
        rows = []; javascript = nil; dropped = 0
        let token = cycle
        let detail: [String: Any] = ["version": 1, "run": run, "cycle": cycle, "epoch": epoch,
                                    "monotonic": start, "trigger": trigger]
        if let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) {
            webView.evaluateJavaScript("window.__assistantFeedTraceStart?.(\(json))") { [weak self] value, error in
                guard let self, self.cycle == token else { return }
                self.collect(kind: 5, extras: [error == nil ? 1 : 0, (value as? Bool) == true ? 1 : 0])
            }
        }
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        displayLink = link; link.add(to: .main, forMode: .common)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.cycle == token else { return }
            self.displayLink?.invalidate(); self.displayLink = nil
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { [weak self] in
            guard let self, self.active, self.cycle == token else { return }
            self.flush()
        }
    }
    @objc private func frame(_ link: CADisplayLink) { collect(kind: 0) }
    private func rect(_ value: CGRect) -> [Double] {
        [value.origin.x, value.origin.y, value.size.width, value.size.height].map(Double.init)
    }
    private func root(_ layer: CALayer) -> CALayer {
        var result = layer
        while let parent = result.superlayer { result = parent }
        return result
    }
    private func node(_ view: UIView, window: UIWindow) -> [Double] {
        let presentation = view.layer.presentation()
        var presentationWindow = [-1.0, -1.0, -1.0, -1.0]
        var available = false
        if let presentation, let windowLayer = window.layer.presentation(), root(presentation) === root(windowLayer) {
            available = true
            presentationWindow = rect(presentation.convert(presentation.bounds, to: windowLayer))
        }
        return rect(view.convert(view.bounds, to: window)) + rect(view.bounds) +
            [presentation == nil ? 0 : 1, available ? 1 : 0] + presentationWindow + [view.layer.masksToBounds ? 1 : 0]
    }
    private func collect(kind: Int, extras: [Double] = []) {
        let now = CACurrentMediaTime()
        guard active, now - start <= 2.2, let webView, let host, let tray, let window = host.window else { return }
        guard rows.count < 260 else { dropped += 1; return }
        let scroll = webView.scrollView
        var metrics = [host, webView, scroll, tray].flatMap { node($0, window: window) }
        metrics += [scroll.contentOffset.x, scroll.contentOffset.y, scroll.contentSize.width, scroll.contentSize.height,
                    scroll.contentInset.top, scroll.contentInset.bottom, scroll.adjustedContentInset.top,
                    scroll.adjustedContentInset.bottom, scroll.zoomScale].map(Double.init)
        metrics += rect(host.convert(host.keyboardLayoutGuide.layoutFrame, to: window))
        metrics += [host.safeAreaInsets.top, host.safeAreaInsets.left, host.safeAreaInsets.bottom, host.safeAreaInsets.right].map(Double.init)
        metrics += rect(lastKeyboard) + [duration, curve]
        metrics += Array((extras + Array(repeating: -1.0, count: 8)).prefix(8))
        guard metrics.count == 91, metrics.allSatisfy(\.isFinite) else { return }
        rows.append(["time": now, "epoch": epoch + (now - start) * 1000, "kind": kind, "metrics": metrics])
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard active, javascript == nil, message.webView === webView, message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, AppConfiguration.isAppURL(url),
              let body = message.body as? [String: Any],
              Set(body.keys) == Set(["version", "run", "cycle", "nativeEpoch", "epoch", "timeOrigin", "rows"]),
              body["version"] as? Int == 1, body["run"] as? String == run, body["cycle"] as? Int == cycle,
              body["nativeEpoch"] as? Double == epoch,
              let jsEpoch = body["epoch"] as? Double, jsEpoch.isFinite,
              let timeOrigin = body["timeOrigin"] as? Double, timeOrigin.isFinite,
              let samples = body["rows"] as? [[String: Any]], samples.count <= 324 else { return }
        var frameCount = 0, phaseCount = 0
        for sample in samples {
            guard Set(sample.keys) == Set(["time", "epoch", "kind", "metrics"]),
                  let time = sample["time"] as? Double, time.isFinite,
                  let sampleEpoch = sample["epoch"] as? Double, sampleEpoch.isFinite,
                  let kind = sample["kind"] as? Int, [0, 1, 2, 3, 10, 11, 12, 13, 14, 15, 16, 17].contains(kind),
                  let metrics = sample["metrics"] as? [Double], metrics.count == 37, metrics.allSatisfy(\.isFinite) else { return }
            if kind == 0 { frameCount += 1 } else { phaseCount += 1 }
        }
        guard frameCount <= 260, phaseCount <= 64 else { return }
        javascript = body
    }

    private func flush() {
        active = false; displayLink?.invalidate(); displayLink = nil
        let batch: [String: Any] = ["version": 1, "finalized": 1, "run": run, "cycle": cycle, "nativeEpoch": epoch,
            "nativeStart": start, "endEpoch": Date().timeIntervalSince1970 * 1000, "dropped": dropped,
            "native": rows, "javascript": javascript as Any? ?? NSNull()]
        guard JSONSerialization.isValidJSONObject(batch), let data = try? JSONSerialization.data(withJSONObject: batch, options: .sortedKeys),
              data.count < 2_000_000 else { return }
        let filename = "\(run)-cycle-\(cycle).json"
        DispatchQueue.global(qos: .utility).async {
            do {
                let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                    appropriateFor: nil, create: true).appendingPathComponent("assistant-feed-causal")
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: directory.appendingPathComponent(filename), options: .atomic)
                print("FEED_CAUSAL_WRITTEN cycle=\(filename) bytes=\(data.count)")
            } catch { print("FEED_CAUSAL_WRITE_FAILED") }
        }
        rows = []; javascript = nil
    }
}
#endif
