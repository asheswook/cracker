#if DEBUG && FEED_CAUSAL_DIAGNOSTICS && os(iOS)
import UIKit
import WebKit

@MainActor
final class ReaderLifecycleProbe {
    static var enabled: Bool {
        AppConfiguration.origin.scheme == "http" && AppConfiguration.origin.host == "127.0.0.1" &&
            ProcessInfo.processInfo.arguments.contains("--qa-reader-lifecycle")
    }
    private static let probes = NSMapTable<WKWebView, ReaderLifecycleProbe>(keyOptions: .weakMemory, valueOptions: .weakMemory)
    static func lookup(_ webView: WKWebView) -> ReaderLifecycleProbe? { probes.object(forKey: webView) }
    private weak var webView: WKWebView?
    private weak var host: UIView?
    private weak var tray: UIView?
    private var observations: [NSKeyValueObservation] = []
    private var rows: [[String: Any]] = []
    private var dropped = 0
    private var collecting = true
    private let run = UUID().uuidString
    private let epoch = Date().timeIntervalSince1970 * 1000
    private var documentOrdinal = 0
    private var scopeOrdinal = 0
    private var scope: String?
    private var rootState = [-1.0, -1.0, -1.0]

    init(webView: WKWebView, configuration: WKWebViewConfiguration) {
        self.webView = webView
        Self.probes.setObject(self, forKey: webView)
        configuration.userContentController.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let scroll = webView.scrollView
        observations = [
            scroll.observe(\.contentSize, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.mark(4) } },
            scroll.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.mark(5) } },
            scroll.observe(\.bounds, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.mark(6) } }
        ]
        mark(0)
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in self?.finish() }
    }
    func attach(host: UIView, tray: UIView) { self.host = host; self.tray = tray; mark(7) }
    func navigation(_ kind: Int) { if kind == 2 { documentOrdinal += 1 }; mark(kind) }
    func composer(scope: String, visible: Bool) {
        if self.scope != scope { self.scope = scope; scopeOrdinal += 1 }
        mark(8, details: [visible ? 1 : 0])
    }
    func root(_ kind: Int, active: Bool, pinned: Bool, changing: Bool, target: Double = -1) {
        rootState = [active ? 1 : 0, pinned ? 1 : 0, changing ? 1 : 0]
        mark(kind, details: [target])
    }
    func mark(_ kind: Int, details: [Double] = []) {
        guard collecting, let webView else { return }
        guard rows.count < 1600 else { dropped += 1; return }
        let scroll = webView.scrollView
        let window = host?.window
        let wkRect = window.map { webView.convert(webView.bounds, to: $0) }
        let trayRect = window.flatMap { window in tray.map { $0.convert($0.bounds, to: window) } }
        var metrics = [scroll.contentOffset.x, scroll.contentOffset.y, scroll.contentSize.width,
                       scroll.contentSize.height, scroll.bounds.width, scroll.bounds.height].map(Double.init)
        metrics.append(Double(wkRect?.minY ?? -1))
        metrics.append(Double(wkRect?.height ?? -1))
        metrics.append(Double(host?.bounds.height ?? -1))
        metrics.append(Double(trayRect?.minY ?? -1))
        metrics.append(Double(trayRect?.height ?? -1))
        let hidden: Double = tray.map { $0.isHidden ? 1 : 0 } ?? -1
        metrics += [hidden, scroll.isDragging ? 1 : 0, scroll.isDecelerating ? 1 : 0]
        metrics += [Double(documentOrdinal), Double(scopeOrdinal)] + rootState
        rows.append(["epoch": Date().timeIntervalSince1970 * 1000, "kind": kind, "metrics": metrics,
                     "details": Array((details + [-1, -1, -1, -1]).prefix(4))])
    }
    private func finish() {
        guard collecting else { return }
        mark(15); collecting = false
        observations.removeAll()
        guard let webView, let url = webView.url, AppConfiguration.isAppURL(url) else {
            persist(javascript: nil, status: "invalid_document"); return
        }
        var completed = false
        webView.callAsyncJavaScript("return window.__assistantReaderLifecycleFinish?.() ?? null;", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self, !completed else { return }; completed = true
            if case .success(let object) = result, let value = object as? [String: Any],
               JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value), data.count <= 300_000 {
                self.persist(javascript: value, status: "received")
            } else { self.persist(javascript: nil, status: "failed") }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard !completed else { return }; completed = true
            self?.persist(javascript: nil, status: "timeout")
        }
    }
    private func persist(javascript: [String: Any]?, status: String) {
        let value: [String: Any] = ["version": 1, "finalized": 1, "run": run, "startEpoch": epoch,
            "endEpoch": Date().timeIntervalSince1970 * 1000, "nativeDropped": dropped, "native": rows,
            "javascriptStatus": status, "javascript": javascript ?? NSNull()]
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("ReaderLifecycle", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
            try data.write(to: directory.appendingPathComponent("\(run).json"), options: .atomic)
            print("ReaderLifecycle finalized \(run) native=\(rows.count) dropped=\(dropped) javascript=\(status)")
        } catch { print("ReaderLifecycle write_failed \(run)") }
    }
    private static let script = #"""
    (() => {
      if (location.hostname !== '127.0.0.1') return;
      const rows = []; let dropped = 0, active = true, scheduled = false;
      const startEpoch = Date.now();
      const take = (kind, details = []) => {
        if (!active) return;
        if (rows.length >= 900) { dropped++; return; }
        const root = document.scrollingElement, vv = window.visualViewport;
        const nodes = document.querySelectorAll('.message[id]');
        const first = nodes[0]?.getBoundingClientRect(), last = nodes[nodes.length - 1]?.getBoundingClientRect();
        rows.push({epoch: performance.timeOrigin + performance.now(), kind,
          metrics: [innerWidth, innerHeight, vv?.height ?? -1, vv?.offsetTop ?? -1, vv?.scale ?? -1,
            root?.scrollTop ?? -1, root?.scrollHeight ?? -1, document.documentElement?.clientHeight ?? -1,
            nodes.length, first?.top ?? -1, first?.height ?? -1, last?.top ?? -1, last?.height ?? -1,
            document.documentElement?.dataset.rootScrollTrial === 'true' ? 1 : 0,
            document.readyState === 'loading' ? 0 : document.readyState === 'interactive' ? 1 : 2],
          details: Array.from({length: 8}, (_, i) => Number.isFinite(details[i]) ? details[i] : -1)});
      };
      const schedule = () => { if (!active || scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; take(4); }); };
      const ready = () => take(1), loaded = () => take(2), resized = () => take(5), scrolled = () => take(6);
      const mutation = new MutationObserver(schedule), resize = new ResizeObserver(() => take(3));
      mutation.observe(document, {subtree: true, childList: true});
      const observe = () => { if (document.documentElement) resize.observe(document.documentElement); if (document.body) resize.observe(document.body); };
      document.addEventListener('DOMContentLoaded', observe, {once: true});
      document.addEventListener('DOMContentLoaded', ready);
      window.addEventListener('load', loaded); window.addEventListener('resize', resized);
      document.addEventListener('scroll', scrolled); window.visualViewport?.addEventListener('resize', resized);
      window.__assistantReaderLifecycle = take;
      window.__assistantReaderLifecycleFinish = () => {
        take(15); active = false; mutation.disconnect(); resize.disconnect();
        document.removeEventListener('DOMContentLoaded', observe); document.removeEventListener('DOMContentLoaded', ready);
        window.removeEventListener('load', loaded); window.removeEventListener('resize', resized);
        document.removeEventListener('scroll', scrolled); window.visualViewport?.removeEventListener('resize', resized);
        return {version: 1, startEpoch, endEpoch: Date.now(), dropped, rows};
      };
      take(0); observe();
    })();
    """#
}
#endif
