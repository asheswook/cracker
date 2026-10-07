#if DEBUG && os(iOS)
import UIKit
import WebKit

@MainActor
final class CompactGeometryProbe {
    private weak var host: UIView?
    private weak var tray: UIView?
    private weak var header: WKWebView?
    private weak var body: WKWebView?
    private var timer: Timer?
    private var rows: [[String: Any]] = []
    private var collecting = true
    private var finalized = false
    private let run = UUID().uuidString
    private let start = Date().timeIntervalSince1970 * 1000
    private var dropped = 0
    private var events: [[String: Any]] = []
    private var eventDropped = 0
    private let startedMonotonic = CACurrentMediaTime()
    private var collectionEnd: Double?

    init?(host: UIView, tray: UIView, header: WKWebView, body: WKWebView) {
        guard ProcessInfo.processInfo.arguments.contains("--qa-compact-geometry") else { return nil }
        self.host = host; self.tray = tray; self.header = header; self.body = body
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
        sample()
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in
            self?.stop()
        }
    }
    private func rect(_ view: UIView?) -> [Double]? {
        guard let view, let window = view.window else { return nil }
        let r = view.convert(view.bounds, to: window)
        return [r.minX, r.minY, r.width, r.height].map(Double.init)
    }
    private func scroll(_ web: WKWebView?) -> [Double]? {
        guard let s = web?.scrollView else { return nil }
        return [s.bounds.width, s.bounds.height, s.contentSize.width, s.contentSize.height,
                s.contentOffset.x, s.contentOffset.y, s.contentInset.top, s.contentInset.right,
                s.contentInset.bottom, s.contentInset.left, s.adjustedContentInset.top,
                s.adjustedContentInset.right, s.adjustedContentInset.bottom, s.adjustedContentInset.left].map(Double.init)
    }
    private func stop() {
        guard collecting else { return }
        collecting = false; timer?.invalidate()
        collectionEnd = Date().timeIntervalSince1970 * 1000
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.finish() }
    }
    func rejection(_ reason: Int, packet: [String: Any]?, generation: Int?) {
        guard collecting, CACurrentMediaTime() - startedMonotonic < 90 else { return }
        guard events.count < 32 else { eventDropped += 1; return }
        let rects = packet?["rects"] as? [[String: Any]] ?? []
        let number: (Any?) -> Double = { value in
            guard let n = value as? NSNumber, n.doubleValue.isFinite else { return -1 }
            return n.doubleValue
        }
        let right = rects.map { number($0["x"]) + number($0["width"]) }.max() ?? -1
        let bottom = rects.map { number($0["y"]) + number($0["height"]) }.max() ?? -1
        events.append(["epoch": Date().timeIntervalSince1970 * 1000, "reason": reason,
            "geometry": [number(packet?["height"]), right, bottom, Double(rects.count), number(packet?["generation"])],
            "native": rect(header) as Any? ?? NSNull(), "generation": generation ?? -1])
    }
    private func sample() {
        guard collecting else { return }
        guard CACurrentMediaTime() - startedMonotonic < 90, rows.count < 180 else { stop(); return }
        let index = rows.count
        rows.append(["epoch": Date().timeIntervalSince1970 * 1000, "host": rect(host) as Any? ?? NSNull(),
            "tray": rect(tray) as Any? ?? NSNull(), "header": rect(header) as Any? ?? NSNull(),
            "body": rect(body) as Any? ?? NSNull(), "headerScroll": scroll(header) as Any? ?? NSNull(),
            "bodyScroll": scroll(body) as Any? ?? NSNull(), "headerHidden": header?.isHidden == true ? 1 : 0,
            "headerJSStatus": "pending", "bodyJSStatus": "pending"])
        for (key, web) in [("header", header), ("body", body)] {
            guard let web else { rows[index][key + "JSStatus"] = "unavailable"; continue }
            web.evaluateJavaScript(Self.script) { [weak self] result, error in
                guard let self, !self.finalized else { return }
                self.rows[index][key + "JSEpoch"] = Date().timeIntervalSince1970 * 1000
                if error != nil { self.rows[index][key + "JSStatus"] = "evaluation_failed" }
                else if let data = result as? [String: Any], JSONSerialization.isValidJSONObject(data) {
                    self.rows[index][key + "JSStatus"] = "ok"; self.rows[index][key + "JS"] = data
                } else { self.rows[index][key + "JSStatus"] = "invalid_result" }
            }
        }
    }
    private func finish() {
        guard !finalized else { return }; finalized = true
        let value: [String: Any] = ["version": 2, "run": run, "start": start, "collectionEnd": collectionEnd ?? start,
            "events": events, "eventDropped": eventDropped,
            "end": Date().timeIntervalSince1970 * 1000, "finalized": true, "dropped": dropped, "rows": rows]
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let path = directory.appendingPathComponent("compact-geometry-\(run).json")
            try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: path, options: .atomic)
            NSLog("COMPACT_GEOMETRY_FINAL run=%@ rows=%d dropped=%d events=%d eventDropped=%d", run, rows.count, dropped, events.count, eventDropped)
        } catch { NSLog("COMPACT_GEOMETRY_WRITE_FAILED") }
    }
    private static let script = #"""
    (() => {
      const r = el => { if (!el) return null; const b=el.getBoundingClientRect(); return [b.x,b.y,b.width,b.height]; };
      const alpha = style => { const c=style.backgroundColor;if(c==='transparent')return 0;const m=c.match(/^rgba?\(([^)]+)\)$/);if(!m)return null;const v=m[1].split(',').map(Number);return v.length===4?v[3]:1; };
      const selectors=['html','body','#root','.assistant-shell','.main-surface','.messenger-header','.message-feed','.message-column'];
      const boxes=selectors.map(s=>r(document.querySelector(s)));
      const backgrounds=selectors.map(s=>{const e=document.querySelector(s);return e?alpha(getComputedStyle(e)):null;});
      const main=document.querySelector('.main-surface'), pseudo=main?getComputedStyle(main,'::before'):null;
      const messages=document.querySelectorAll('.message[id]'), tail=messages[messages.length-1];
      const scrolling=document.scrollingElement, vv=window.visualViewport;
      return {viewport:[innerWidth,innerHeight,document.documentElement.clientWidth,document.documentElement.clientHeight],
        visual:vv?[vv.width,vv.height,vv.offsetLeft,vv.offsetTop,vv.scale]:null,
        compact:matchMedia('(max-height: 180px)').matches?1:0, boxes,backgrounds,
        fade:pseudo?[parseFloat(pseudo.height)||0,parseFloat(pseudo.opacity)||0,pseudo.display==='none'?0:1]:null,
        root:scrolling?[scrolling.scrollWidth,scrolling.scrollHeight,scrolling.scrollLeft,scrolling.scrollTop]:null,
        messageCount:messages.length,tail:r(tail),bubble:r(tail?.querySelector('.bubble')),
        pet:r(document.querySelector('.assistant-character'))};
    })()
    """#
}
#endif
