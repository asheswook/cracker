#if os(iOS)
import UIKit
import WebKit

@MainActor
final class NativeRootScrollTrial {
    private static let owners = NSMapTable<WKWebView, NativeRootScrollTrial>(keyOptions: .weakMemory, valueOptions: .weakMemory)
    static func lookup(_ webView: WKWebView) -> NativeRootScrollTrial? { owners.object(forKey: webView) }
    static var enabled: Bool { true }
    private weak var webView: WKWebView?
    private var sizeObservation: NSKeyValueObservation?
    private var offsetObservation: NSKeyValueObservation?
    private var pinned = true
    private var active = false
    private var changingOffset = false
    private var lastTrayHeight: CGFloat?
    private var lastBottomInset: CGFloat?
    private var lastContentSize = CGSize.zero
    private var keyboardTransitionID: UUID?

    init(webView: WKWebView) {
        self.webView = webView
        Self.owners.setObject(self, forKey: webView)
        sizeObservation = webView.scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.contentSizeChanged() }
        }
        offsetObservation = webView.scrollView.observe(\.contentOffset, options: [.new]) { [weak self] scroll, _ in
            MainActor.assumeIsolated {
                guard let self, self.active, !self.changingOffset,
                      scroll.isDragging || scroll.isDecelerating else { return }
                self.pinned = self.maximumOffset(height: scroll.bounds.height) - scroll.contentOffset.y < 24
                self.probe(16)
            }
        }
    }

    func setActive(_ visible: Bool) {
        probe(10, target: visible ? 1 : 0)
        if NativeReaderBridge.enabled { return }
        guard active != visible else { return }
        active = visible
        if visible { pinned = true; contentChanged() }
    }

    func readerState(mode: String, suspended: Bool) {
        active = !suspended
        pinned = mode == "follow"
    }
    func readerMove(to offset: Double) { setOffset(CGFloat(offset)) }

    private func maximumOffset(height: CGFloat) -> CGFloat {
        guard let scroll = webView?.scrollView else { return 0 }
        return max(-scroll.adjustedContentInset.top,
                   scroll.contentSize.height + scroll.adjustedContentInset.bottom - height)
    }

    private func setOffset(_ value: CGFloat) {
        guard let scroll = webView?.scrollView else { return }
        changingOffset = true
        probe(11, target: Double(value))
        scroll.contentOffset = CGPoint(x: scroll.contentOffset.x, y: value)
        changingOffset = false
        probe(12, target: Double(value))
    }

    private func contentSizeChanged() {
        guard let scroll = webView?.scrollView, scroll.contentSize != lastContentSize else { return }
        lastContentSize = scroll.contentSize
        contentChanged()
    }

    private func contentChanged() {
        probe(13)
        if let webView, NativeReaderBridge.lookup(webView)?.keyboardMoving == true { return }
        guard active, pinned, let scroll = webView?.scrollView,
              !scroll.isDragging, !scroll.isDecelerating,
              keyboardTransitionID == nil else { return }
        setOffset(maximumOffset(height: scroll.bounds.height))
    }

    func layout(trayHeight: CGFloat) {
        let previous = lastTrayHeight
        let inset = webView?.scrollView.adjustedContentInset.bottom ?? 0
        let previousInset = lastBottomInset
        lastTrayHeight = trayHeight; lastBottomInset = inset
        guard previous != nil, previous != trayHeight || previousInset != inset else { return }
        contentChanged()
    }

    func keyboardTransition(toHeight: CGFloat, bottomInset: CGFloat, duration: TimeInterval, curve: Int, prepare: (() -> Void)? = nil, layout: @escaping () -> Void) {
        probe(14, target: Double(toHeight))
        guard active, let scroll = webView?.scrollView,
              !scroll.isDragging, !scroll.isDecelerating else { return }
        if let webView { NativeReaderBridge.lookup(webView)?.keyboardBegan() }
        let maximum = max(-scroll.adjustedContentInset.top, scroll.contentSize.height + bottomInset - toHeight)
        let target = pinned ? maximum
            : min(maximum, max(-scroll.adjustedContentInset.top, scroll.contentOffset.y))
        let transitionID = UUID()
        keyboardTransitionID = transitionID
        prepare?()
        let options = UIView.AnimationOptions(rawValue: UInt(curve) << 16).union([.beginFromCurrentState, .allowUserInteraction])
        UIView.animate(withDuration: duration, delay: 0, options: options) {
            layout()
            self.setOffset(target)
        } completion: { [weak self] _ in
            guard let self, self.keyboardTransitionID == transitionID else { return }
            self.keyboardTransitionID = nil
            self.contentChanged()
            if let webView = self.webView { NativeReaderBridge.lookup(webView)?.keyboardEnded() }
        }
    }

    private func probe(_ kind: Int, target: Double = -1) {
        guard let webView else { return }
    }
}
#endif
