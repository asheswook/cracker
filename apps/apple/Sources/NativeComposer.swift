#if os(iOS)
import SwiftUI
import WebKit

private final class ComposerButton: UIButton {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        NativeComposerLayout.hitBounds(bounds).contains(point)
    }

    override var accessibilityFrame: CGRect {
        get { UIAccessibility.convertToScreenCoordinates(NativeComposerLayout.hitBounds(bounds), in: self) }
        set { super.accessibilityFrame = newValue }
    }
}

struct NativeComposerHost: UIViewControllerRepresentable {
    let controller: NativeComposerController
    func makeUIViewController(context: Context) -> NativeComposerController { controller }
    func updateUIViewController(_ controller: NativeComposerController, context: Context) {}
}

@MainActor
final class NativeComposerController: UIViewController, UITextViewDelegate, UITextPasteDelegate {
    typealias Deliver = ([String: Any], Bool, @escaping (Result<Any, Error>) -> Void) -> Void
    #if os(iOS)
    private lazy var rootScrollTrial = NativeRootScrollTrial.enabled ? NativeRootScrollTrial(webView: webView) : nil
    private let attachmentPicker = NativeAttachmentPicker()
    @available(iOS 18.4, *)
    func chooseAttachment(_ parameters: WKOpenPanelParameters, completion: @escaping ([URL]?) -> Void) {
        guard let state, state.visible, !suspended, !externalPresentation, state.attachEnabled else { completion(nil); return }
        if let pastedAttachment {
            self.pastedAttachment = nil
            completion(pastedAttachment.session == state.session ? [pastedAttachment.url] : nil)
            return
        }
        attachmentPicker.begin(parameters: parameters, host: self, anchor: attach, completion: completion)
    }
    #endif
    private let webView: WKWebView
    private let deliver: Deliver
    private let transition: ([String: Any]) -> Void
    private var keyboardObserver: NSObjectProtocol?
    private var keyboardWasVisible = false
    private var keyboardAccessibilityActionVisible = false
    private let tray = UIView()
    private let editor = UITextView()
    private let placeholder = UILabel()
    private let attach = ComposerButton(type: .system)
    private let send = ComposerButton(type: .system)
    private let recovery = UIButton(type: .system)
    private var editorHeight: NSLayoutConstraint!
    private var recoveryHeight: NSLayoutConstraint!
    private var activeBottom: NSLayoutConstraint!
    private var inactiveBottom: NSLayoutConstraint!
    private var trayBottom: NSLayoutConstraint!
    private var footerBottom: NSLayoutConstraint?
    private var overlayBottom: NSLayoutConstraint!
    private var overlayActive = false
    private var portraitConstraints: [NSLayoutConstraint] = []
    private var compactConstraints: [NSLayoutConstraint] = []
    private var compactLayout = false
    private var state: NativeComposerState?
    private var buffers: [String: NativeComposerBuffer] = [:]
    private var sessions: [String: NativeComposerState] = [:]
    private var generation = -1
    private var lastFocus = 0
    private var applying = false
    private var suspended = false
    private var externalPresentation = false
    private var pendingSends = Set<String>()
    private var uncertainSends: [String: [String: Any]] = [:]
    private var pastedAttachment: (url: URL, session: String)?
    private var pastedDirectories: [URL] = []

    init(webView: WKWebView, transition: @escaping ([String: Any]) -> Void, deliver: @escaping Deliver) {
        self.webView = webView
        self.deliver = deliver
        self.transition = transition
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use init(webView:deliver:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(named: "Canvas")
        [webView, tray].forEach { $0.translatesAutoresizingMaskIntoConstraints = false; view.addSubview($0) }
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        tray.layer.cornerRadius = NativeComposerLayout.cornerRadius
        tray.layer.borderWidth = 1
        editor.delegate = self
        editor.pasteDelegate = self
        editor.allowsEditingTextAttributes = false
        editor.font = .systemFont(ofSize: 16)
        editor.adjustsFontForContentSizeCategory = true
        editor.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 16))
        editor.backgroundColor = .clear
        editor.textContainerInset = UIEdgeInsets(top: NativeComposerLayout.textTopInset, left: NativeComposerLayout.padding,
                                                bottom: NativeComposerLayout.textBottomInset, right: NativeComposerLayout.padding)
        editor.textContainer.lineFragmentPadding = 0
        editor.isScrollEnabled = false
        editor.accessibilityIdentifier = "native-composer-editor"
        editor.accessibilityLabel = "메시지 입력"
        editor.returnKeyType = .default
        placeholder.font = editor.font
        placeholder.heightAnchor.constraint(greaterThanOrEqualToConstant: NativeComposerLayout.lineHeight).isActive = true
        placeholder.isAccessibilityElement = false
        placeholder.isUserInteractionEnabled = false
        configure(attach, symbol: "plus", label: "파일 첨부", action: #selector(attachFile))
        configure(send, symbol: "arrow.up", label: "메시지 보내기", action: #selector(sendMessage))
        send.layer.cornerRadius = NativeComposerLayout.controlSize / 2
        recovery.titleLabel?.font = .systemFont(ofSize: 12)
        recovery.titleLabel?.numberOfLines = 2
        recovery.addTarget(self, action: #selector(recoverDraft), for: .touchUpInside)
        [editor, placeholder, attach, send, recovery].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false; tray.addSubview($0)
        }
        editorHeight = editor.heightAnchor.constraint(equalToConstant: NativeComposerLayout.editorMinimum)
        recoveryHeight = recovery.heightAnchor.constraint(equalToConstant: 0)
        activeBottom = webView.bottomAnchor.constraint(equalTo: tray.topAnchor)
        inactiveBottom = webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        overlayBottom = webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        trayBottom = tray.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -8)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor), inactiveBottom,
            tray.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            tray.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            tray.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
            tray.widthAnchor.constraint(lessThanOrEqualToConstant: 680),
            trayBottom,
            editor.topAnchor.constraint(equalTo: tray.topAnchor, constant: 8),
            editorHeight,
            placeholder.leadingAnchor.constraint(equalTo: editor.leadingAnchor, constant: 8),
            placeholder.topAnchor.constraint(equalTo: editor.topAnchor, constant: NativeComposerLayout.textTopInset),
            placeholder.trailingAnchor.constraint(lessThanOrEqualTo: editor.trailingAnchor, constant: -8),
            attach.leadingAnchor.constraint(equalTo: tray.leadingAnchor, constant: 8),
            send.trailingAnchor.constraint(equalTo: tray.trailingAnchor, constant: -8),
            recovery.leadingAnchor.constraint(equalTo: tray.leadingAnchor, constant: 8),
            recovery.trailingAnchor.constraint(equalTo: tray.trailingAnchor, constant: -8),
            recovery.bottomAnchor.constraint(equalTo: tray.bottomAnchor, constant: -8), recoveryHeight
        ])
        let width = tray.widthAnchor.constraint(equalTo: view.safeAreaLayoutGuide.widthAnchor, constant: -40)
        width.priority = .defaultHigh; width.isActive = true
        for control in [attach, send] {
            NSLayoutConstraint.activate([
                control.widthAnchor.constraint(equalToConstant: NativeComposerLayout.controlSize),
                control.heightAnchor.constraint(equalToConstant: NativeComposerLayout.controlSize)
            ])
        }
        portraitConstraints = [
            editor.leadingAnchor.constraint(equalTo: tray.leadingAnchor, constant: 8),
            editor.trailingAnchor.constraint(equalTo: tray.trailingAnchor, constant: -8),
            recovery.topAnchor.constraint(equalTo: send.bottomAnchor)
        ] + [attach, send].map { $0.topAnchor.constraint(equalTo: editor.bottomAnchor) }
        compactConstraints = [
            editor.leadingAnchor.constraint(equalTo: attach.trailingAnchor, constant: 8),
            editor.trailingAnchor.constraint(equalTo: send.leadingAnchor, constant: -8),
            recovery.topAnchor.constraint(equalTo: editor.bottomAnchor)
        ] + [attach, send].map { $0.centerYAnchor.constraint(equalTo: editor.centerYAnchor) }
        NSLayoutConstraint.activate(portraitConstraints)
        #if os(iOS)
        #endif
        tray.isHidden = true
        #if os(iOS)
        if let footer = IndependentFooterController.lookup(webView) {
            footer.attach(to: view, tray: tray)
            inactiveBottom.isActive = false
            footerBottom = webView.bottomAnchor.constraint(equalTo: footer.bottomAnchor)
            footerBottom?.isActive = true
        }
        IndependentHeaderController.lookup(webView)?.attach(to: view, tray: tray)
        #endif
        keyboardObserver = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification,
                                                                   object: nil, queue: .main) { [weak self] notification in
            MainActor.assumeIsolated { self?.keyboardWillChange(notification) }
        }
    }

    deinit {
        if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
        for directory in pastedDirectories { try? FileManager.default.removeItem(at: directory) }
    }

    private func keyboardWillChange(_ notification: Notification) {
        #if os(iOS)
        #endif
        guard let state, state.visible, !suspended, !externalPresentation,
              editor.isFirstResponder || keyboardWasVisible,
              let window = view.window, let info = notification.userInfo,
              (info[UIResponder.keyboardIsLocalUserInfoKey] as? Bool) != false,
              let screenFrame = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue,
              let seconds = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue,
              let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.intValue else { return }
        let startedAt = Date().timeIntervalSince1970 * 1000
        let frameInWindow = window.screen.coordinateSpace.convert(screenFrame, to: window)
        let frame = view.convert(frameInWindow, from: window)
        let baseGeometry = NativeKeyboardTransitionGeometry.resolve(host: view.bounds,
            safeBottom: view.safeAreaLayoutGuide.layoutFrame.maxY, keyboard: frame,
            trayHeight: tray.bounds.height, trayBottomConstant: trayBottom.constant, webTop: webView.frame.minY)
        var targetHeight = overlayActive ? baseGeometry.viewportHeight : baseGeometry.height
        var targetInset = overlayActive ? baseGeometry.bottomInset : 0
        #if os(iOS)
        if let footer = IndependentFooterController.lookup(webView) {
            footer.prepare(available: baseGeometry.height)
            if overlayActive { targetInset += footer.reservedHeight }
            else { targetHeight -= footer.reservedHeight }
        }
        #endif
        keyboardWasVisible = baseGeometry.docked
        var fromHeight = webView.bounds.height
        if abs(fromHeight - targetHeight) <= 0.5,
           let beginFrame = (info[UIResponder.keyboardFrameBeginUserInfoKey] as? NSValue)?.cgRectValue {
            let beginInWindow = window.screen.coordinateSpace.convert(beginFrame, to: window)
            let begin = view.convert(beginInWindow, from: window)
            let fromGeometry = NativeKeyboardTransitionGeometry.resolve(host: view.bounds,
                safeBottom: view.safeAreaLayoutGuide.layoutFrame.maxY, keyboard: begin,
                trayHeight: tray.bounds.height, trayBottomConstant: trayBottom.constant, webTop: webView.frame.minY)
            fromHeight = overlayActive ? fromGeometry.viewportHeight : fromGeometry.height
            #if os(iOS)
            if !overlayActive { fromHeight -= IndependentFooterController.lookup(webView)?.reservedHeight ?? 0 }
            #endif
        }
        // Interactive zero-duration geometry remains owned entirely by UIKit; this is not a frame follower.
        guard seconds > 0, seconds <= 10, targetHeight > 0, webView.bounds.width > 0,
              abs(targetHeight - fromHeight) > 0.5 else { return }
        #if os(iOS)
        if let rootScrollTrial {
            rootScrollTrial.keyboardTransition(toHeight: targetHeight, bottomInset: targetInset, duration: seconds, curve: curve, prepare: { [weak self] in
                self?.prepareKeyboardTerminalLayout(docked: baseGeometry.docked, keyboardEndFrame: frame, duration: seconds)
            }) { [weak self] in
                self?.view.layoutIfNeeded()
            }
            return
        }
        #endif
        transition(["version": 1, "document": state.document, "session": state.session,
                    "transition": UUID().uuidString, "startTime": startedAt,
                    "duration": seconds * 1000, "curve": curve, "fromHeight": fromHeight,
                    "toHeight": targetHeight, "width": webView.bounds.width])
    }

    private func prepareKeyboardTerminalLayout(docked: Bool, keyboardEndFrame: CGRect, duration: TimeInterval) {
        let hostBounds = view.bounds
        guard !docked, duration > 0, duration <= 10, UIView.areAnimationsEnabled,
              hostBounds.width > 0, hostBounds.height > 0, keyboardEndFrame.minY.isFinite,
              keyboardEndFrame.minY >= hostBounds.maxY - 0.5,
              !webView.scrollView.isDragging, !webView.scrollView.isDecelerating,
              (tray.layer.animationKeys() ?? []).isEmpty,
              let presentation = tray.layer.presentation() else { return }
        let modelFrame = tray.frame
        let presentationFrame = presentation.frame
        guard abs(presentationFrame.width - modelFrame.width) <= 0.5,
              abs(presentationFrame.height - modelFrame.height) <= 0.5 else { return }
        let delta = presentationFrame.minY - modelFrame.minY
        guard delta.isFinite, delta < -0.5 else { return }
        let originalBottom = trayBottom.constant
        UIView.performWithoutAnimation {
            trayBottom.constant = originalBottom + delta
            view.layoutIfNeeded()
        }
        trayBottom.constant = originalBottom
    }

    private func configure(_ button: UIButton, symbol: String, label: String, action: Selector) {
        button.setImage(UIImage(systemName: symbol), for: .normal)
        button.accessibilityLabel = label
        button.addTarget(self, action: action, for: .touchUpInside)
    }

    @discardableResult
    func apply(_ next: NativeComposerState) -> Bool {
        loadViewIfNeeded()
        guard next.generation > generation else { return true }
        let switching = state?.session != next.session || state?.document != next.document
        if switching && buffers[next.session] == nil && buffers.values.filter({ $0.dirty }).count >= 16 {
            suspended = true
            updateVisibility()
            return false
        }
        if switching {
            pastedAttachment = nil
            #if os(iOS)
            attachmentPicker.cancel()
            #endif
            flush()
            editor.resignFirstResponder()
            // A failed prior document remains recoverable instead of being overwritten by a new draft.
            buffers = buffers.filter { $0.value.dirty }
            sessions = sessions.filter { buffers[$0.key] != nil }
            lastFocus = next.focus ?? 0
        }
        generation = next.generation
        sessions[next.session] = next
        state = next
        suspended = false
        if buffers[next.session] == nil {
            buffers[next.session] = NativeComposerBuffer(text: next.text, sequence: next.ack, acknowledged: next.ack,
                                                         selection: NSRange(location: next.text.utf16.count, length: 0))
        }
        guard var buffer = buffers[next.session] else { return false }
        let replace = buffer.reconcile(next, marked: !switching && editor.markedTextRange != nil)
        buffers[next.session] = buffer
        if switching || replace {
            applying = true
            editor.text = buffer.text
            editor.selectedRange = buffer.selection
            applying = false
        }
        applyTheme(next.theme)
        placeholder.text = next.placeholder
        updateVisibility()
        updateControls()
        resizeEditor()
        if let focus = next.focus, focus > lastFocus {
            lastFocus = focus
            if !tray.isHidden && next.editable { editor.becomeFirstResponder() }
        }
        return true
    }

    func hide(document: String, session: String) {
        guard state?.document == document, state?.session == session else { return }
        flush()
        suspended = true
        updateVisibility()
    }

    func resetDocument() {
        #if os(iOS)
        attachmentPicker.cancel()
        #endif
        flush()
        for key in buffers.keys where buffers[key]?.dirty == true { buffers[key]?.failure = true }
        generation = -1
        suspended = true
        updateVisibility()
    }

    func setExternalPresentation(_ presented: Bool) {
        if presented { flush() }
        externalPresentation = presented
        updateVisibility()
    }

    private func updateVisibility() {
        guard isViewLoaded else { return }
        let visible = state?.visible == true && !suspended && !externalPresentation
        if !visible {
            editor.resignFirstResponder()
            #if os(iOS)
            attachmentPicker.cancel()
            #endif
        }
        tray.isHidden = !visible
        view.setNeedsLayout()
        IndependentHeaderController.lookup(webView)?.setComposerVisible(visible)
        #if os(iOS)
        if let footer = IndependentFooterController.lookup(webView) {
            footer.setComposerVisible(visible)
            return
        }
        #endif
        updateViewportConstraints()
    }

    private func applyTheme(_ theme: NativeComposerState.Theme) {
        view.backgroundColor = color(theme.canvas)
        webView.backgroundColor = color(theme.canvas)
        webView.scrollView.backgroundColor = color(theme.canvas)
        tray.backgroundColor = color(theme.surface)
        tray.layer.borderColor = color(theme.ink).withAlphaComponent(0.09).cgColor
        editor.textColor = color(theme.ink)
        editor.tintColor = color(theme.accent)
        placeholder.textColor = color(theme.muted)
        attach.tintColor = color(theme.muted)
        recovery.setTitleColor(color(theme.muted), for: .normal)
        send.backgroundColor = color(theme.accent)
        send.tintColor = .white
        editor.keyboardAppearance = (color(theme.canvas).cgColor.components?.first ?? 1) < 0.5 ? .dark : .light
    }

    private func color(_ hex: String) -> UIColor {
        let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
        return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255,
                       blue: CGFloat(value & 255) / 255, alpha: 1)
    }

    private func updateControls() {
        guard let state else { return }
        editor.isEditable = state.editable
        let withinLimit = editor.text.utf16.count <= NativeComposerState.textLimit
        send.isEnabled = state.sendEnabled && withinLimit && editor.markedTextRange == nil && !pendingSends.contains(state.session) && uncertainSends[state.session] == nil
        send.alpha = send.isEnabled ? 1 : 0.4
        attach.isEnabled = state.attachEnabled
        let failed = buffers.values.contains { $0.failure } || !uncertainSends.isEmpty
        let message = !withinLimit ? "메시지는 100,000자까지 보낼 수 있어요. 내용을 줄여 주세요." :
            failed ? "초안 동기화 실패 · 복사 또는 다시 시도" : state.error
        recovery.setTitle(message, for: .normal)
        recovery.isHidden = message.isEmpty
        recoveryHeight.constant = message.isEmpty ? 0 : 44
    }

    private func capture() {
        guard !applying, let state, var buffer = buffers[state.session] else { return }
        buffer.capture(text: editor.text, selection: editor.selectedRange, composing: editor.markedTextRange != nil)
        buffers[state.session] = buffer
    }

    func textViewDidChange(_ textView: UITextView) { capture(); flush(); resizeEditor(); updateControls() }
    func textViewDidBeginEditing(_ textView: UITextView) { updateKeyboardAccessibility() }
    func textViewDidEndEditing(_ textView: UITextView) { updateKeyboardAccessibility() }
    func textViewDidChangeSelection(_ textView: UITextView) {
        guard !applying else { return }
        capture(); flush(); updateControls()
    }

    func textPasteConfigurationSupporting(_ supporting: UITextPasteConfigurationSupporting,
                                         performPasteOf attributedString: NSAttributedString, to textRange: UITextRange) -> UITextRange {
        guard let state, state.visible, state.editable, !suspended, !externalPresentation else { return textRange }
        let text = NativePastePolicy.plainText(attributedString.string)
        let replaced = editor.offset(from: textRange.start, to: textRange.end)
        if NativePastePolicy.needsAttachment(text) || editor.text.utf16.count - replaced + text.utf16.count > NativeComposerState.textLimit {
            guard state.attachEnabled, pastedAttachment == nil else { pasteError("파일 첨부가 끝난 뒤 다시 붙여넣어 주세요.", scope: state.scope); return textRange }
            guard #available(iOS 18.4, *) else { pasteError("긴 내용은 텍스트 파일로 저장한 뒤 첨부해 주세요. 원문은 클립보드에 유지됩니다.", scope: state.scope); return textRange }
            guard text.utf8.count <= 100_000_000 else { pasteError("파일은 각각 100MB까지 첨부할 수 있어요.", scope: state.scope); return textRange }
            do {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("assistant-paste-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                pastedDirectories.append(directory)
                let url = directory.appendingPathComponent("pasted-text.txt")
                try text.write(to: url, atomically: true, encoding: .utf8)
                pastedAttachment = (url, state.session)
                flush()
                if let buffer = buffers[state.session] { issue(command("attach", state: state, buffer: buffer), state: state) }
            } catch { pasteError("붙여넣은 내용을 파일로 보관하지 못했어요. 원문은 클립보드에 유지됩니다.", scope: state.scope) }
            return textRange
        }
        editor.replace(textRange, withText: text)
        textViewDidChange(editor)
        return editor.selectedTextRange ?? textRange
    }

    private func pasteError(_ message: String, scope: String) {
        webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('assistant-composer-paste-error', {detail: {message, scope}}));",
                                   arguments: ["message": message, "scope": scope], in: nil, in: .page) { _ in }
    }

    private func command(_ kind: String, state: NativeComposerState, buffer: NativeComposerBuffer) -> [String: Any] {
        var payload: [String: Any] = ["version": 1, "kind": kind, "document": state.document,
                                      "session": state.session, "scope": state.scope]
        if kind == "edit" || kind == "send" {
            payload["seq"] = buffer.sequence; payload["text"] = buffer.text
            payload["selection"] = ["start": buffer.selection.location, "end": NSMaxRange(buffer.selection)]
            payload["composing"] = buffer.composing
        }
        if kind != "edit" { payload["commandId"] = UUID().uuidString }
        return payload
    }

    func flush() {
        guard !applying, let state, let buffer = buffers[state.session], buffer.dirty,
              buffer.text.utf16.count <= NativeComposerState.textLimit else { return }
        issue(command("edit", state: state, buffer: buffer), state: state)
    }

    private func issue(_ payload: [String: Any], state sentState: NativeComposerState) {
        let isSend = payload["kind"] as? String == "send"
        let pastedURL = payload["kind"] as? String == "attach" ? pastedAttachment?.url : nil
        let pasteFailed = { [weak self] in
            guard let self, let pastedURL, self.pastedAttachment?.url == pastedURL else { return }
            self.pastedAttachment = nil
            self.pasteError("텍스트 파일을 첨부하지 못했어요. 원문은 클립보드에 유지됩니다.", scope: sentState.scope)
        }
        if isSend { pendingSends.insert(sentState.session); updateControls() }
        deliver(payload, payload["kind"] as? String == "attach") { [weak self] result in
            guard let self else { return }
            if isSend { self.pendingSends.remove(sentState.session) }
            switch result {
            case .success(let value):
                guard let reply = value as? [String: Any], let accepted = reply["accepted"] as? Bool,
                      let ack = reply["ack"] as? Int else {
                    self.buffers[sentState.session]?.failure = true
                    if isSend { self.uncertainSends[sentState.session] = payload }
                    pasteFailed()
                    self.updateControls(); return
                }
                if isSend { self.uncertainSends.removeValue(forKey: sentState.session) }
                if !accepted { pasteFailed() }
                if accepted { self.buffers[sentState.session]?.acknowledge(ack) }
                else if payload["kind"] as? String == "edit" { self.buffers[sentState.session]?.failure = true }
                if let next = reply["state"].flatMap(NativeComposerState.parse),
                   next.document == self.state?.document, next.session == self.state?.session { self.apply(next) }
            case .failure:
                pasteFailed()
                self.buffers[sentState.session]?.failure = true
                if isSend { self.uncertainSends[sentState.session] = payload }
            }
            self.updateControls()
        }
    }

    @objc private func sendMessage() {
        guard let state, state.visible, !suspended, !externalPresentation, state.sendEnabled,
              editor.markedTextRange == nil, !pendingSends.contains(state.session), uncertainSends[state.session] == nil else { return }
        capture()
        guard let buffer = buffers[state.session], !buffer.composing,
              buffer.text.utf16.count <= NativeComposerState.textLimit else { return }
        issue(command("send", state: state, buffer: buffer), state: state)
    }

    @objc private func attachFile() {
        pastedAttachment = nil
        guard let state, state.visible, !suspended, !externalPresentation, state.attachEnabled,
              let buffer = buffers[state.session] else { return }
        flush()
        issue(command("attach", state: state, buffer: buffer), state: state)
    }
    var panelKeyboardVisible: Bool {
        isViewLoaded && view.keyboardLayoutGuide.layoutFrame.minY < view.safeAreaLayoutGuide.layoutFrame.maxY - 1
    }
    func preparePanelSource() { view.endEditing(true); capture(); flush() }

    private func updateKeyboardAccessibility() {
        let visible = editor.isFirstResponder && panelKeyboardVisible && !tray.isHidden
        guard visible != keyboardAccessibilityActionVisible else { return }
        keyboardAccessibilityActionVisible = visible
        editor.accessibilityCustomActions = visible ? [UIAccessibilityCustomAction(name: "키보드 닫기", target: self,
            selector: #selector(dismissKeyboardForAccessibility))] : nil
    }

    @objc private func dismissKeyboardForAccessibility() -> Bool {
        guard editor.isFirstResponder, panelKeyboardVisible else { return false }
        capture(); flush()
        return editor.resignFirstResponder()
    }

    @objc private func recoverDraft() {
        guard presentedViewController == nil else { return }
        let failed = buffers.first { $0.value.failure }
        let buffer = failed?.value ?? state.flatMap { buffers[$0.session] }
        let alert = UIAlertController(title: "초안 보관", message: "동기화되지 않은 입력은 앱 메모리에 남아 있습니다. 앱을 닫기 전에 복사해 주세요.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "초안 복사", style: .default) { _ in UIPasteboard.general.string = buffer?.text })
        if let current = state, let pending = uncertainSends[current.session] {
            alert.addAction(UIAlertAction(title: "전송 결과 확인", style: .default) { [weak self] _ in
                self?.issue(pending, state: current)
            })
        }
        if let failed, let snapshot = sessions[failed.key], snapshot.document == state?.document {
            alert.addAction(UIAlertAction(title: "다시 동기화", style: .default) { [weak self] _ in
                guard let self else { return }
                self.issue(self.command("edit", state: snapshot, buffer: failed.value), state: snapshot)
            })
        }
        alert.addAction(UIAlertAction(title: "닫기", style: .cancel))
        editor.resignFirstResponder()
        present(alert, animated: true)
    }

    private func updateViewportConstraints() {
        let overlay = !tray.isHidden && NativeReaderBridge.lookup(webView)?.allowsComposerOverlay == true
        let desired: NSLayoutConstraint = overlay ? overlayBottom
            : footerBottom ?? (tray.isHidden ? inactiveBottom : activeBottom)
        overlayActive = overlay
        if !editor.isFirstResponder && view.keyboardLayoutGuide.layoutFrame.minY >= view.safeAreaLayoutGuide.layoutFrame.maxY - 0.5 {
            keyboardWasVisible = false
        }
        overlayBottom.constant = overlay && !keyboardWasVisible
            ? max(0, view.bounds.maxY - view.safeAreaLayoutGuide.layoutFrame.maxY) : 0
        for constraint in [activeBottom, inactiveBottom, footerBottom, overlayBottom].compactMap({ $0 })
            where constraint !== desired { constraint.isActive = false }
        desired.isActive = true
    }

    private func updateReaderInset() {
        let footerHeight = IndependentFooterController.lookup(webView)?.reservedHeight ?? 0
        let inset = overlayActive ? max(0, webView.frame.maxY - tray.frame.minY + footerHeight) : 0
        let scroll = webView.scrollView
        if abs(scroll.contentInset.bottom - inset) > 0.5 {
            var value = scroll.contentInset; value.bottom = inset; scroll.contentInset = value
            var indicator = scroll.verticalScrollIndicatorInsets; indicator.bottom = inset
            scroll.verticalScrollIndicatorInsets = indicator
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateViewportConstraints()
        let compact = NativeComposerLayout.compact(width: Double(view.bounds.width), height: Double(view.bounds.height),
                                                   safeWidth: Double(view.safeAreaLayoutGuide.layoutFrame.width))
        if compact != compactLayout {
            compactLayout = compact
            NSLayoutConstraint.deactivate(compact ? portraitConstraints : compactConstraints)
            NSLayoutConstraint.activate(compact ? compactConstraints : portraitConstraints)
            view.layoutIfNeeded()
        }
        resizeEditor()
        updateKeyboardAccessibility()
        #if os(iOS)
        IndependentFooterController.lookup(webView)?.layout()
        updateReaderInset()
        NativeReaderBridge.lookup(webView)?.geometryChanged()
        rootScrollTrial?.setActive(!tray.isHidden)
        rootScrollTrial?.layout(trayHeight: tray.bounds.height)
        #endif
    }
    private func resizeEditor() {
        guard editor.bounds.width > 0 else { return }
        let desired = editor.sizeThatFits(CGSize(width: editor.bounds.width, height: .greatestFiniteMagnitude)).height
        let height = NativeComposerLayout.editorHeight(measured: desired, compact: compactLayout)
        if editorHeight.constant != height { editorHeight.constant = height }
        editor.isScrollEnabled = desired > NativeComposerLayout.editorMaximum
        placeholder.isHidden = !editor.text.isEmpty
    }
}
#endif
