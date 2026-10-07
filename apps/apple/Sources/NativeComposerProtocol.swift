import Foundation
import CoreGraphics

enum NativePastePolicy {
    static func plainText(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }
    static func needsAttachment(_ text: String) -> Bool {
        text.utf16.count >= 4000 || text.components(separatedBy: "\n").count >= 80
    }
}

struct NativeComposerState: Decodable {
    struct Theme: Decodable {
        let canvas: String
        let surface: String
        let ink: String
        let muted: String
        let accent: String
        var valid: Bool { [canvas, surface, ink, muted, accent].allSatisfy { $0.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil } }
    }
    let version: Int
    let document: String
    let session: String
    let scope: String
    let generation: Int
    let text: String
    let revision: String
    let ack: Int
    let visible: Bool
    let editable: Bool
    let sendEnabled: Bool
    let attachEnabled: Bool
    let placeholder: String
    let error: String
    let theme: Theme
    let focus: Int?
    static let textLimit = 100_000
    static func parse(_ value: Any) -> NativeComposerState? {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value), data.count <= 2_000_000,
              let state = try? JSONDecoder().decode(Self.self, from: data),
              state.version == 1, UUID(uuidString: state.document) != nil, UUID(uuidString: state.session) != nil,
              !state.scope.isEmpty, state.scope.utf16.count <= 512,
              state.generation >= 0, state.generation <= 9_007_199_254_740_991,
              state.ack >= 0, state.ack <= 9_007_199_254_740_991,
              state.text.utf16.count <= textLimit, state.revision.utf16.count <= 128,
              state.placeholder.utf16.count <= 512, state.error.utf16.count <= 2048, state.theme.valid,
              (state.focus ?? 0) >= 0 else { return nil }
        return state
    }
}

struct NativeComposerBuffer {
    var text: String
    var sequence: Int
    var acknowledged: Int
    var selection: NSRange
    var composing = false
    var failure = false
    var dirty: Bool { sequence > acknowledged || failure }

    mutating func capture(text: String, selection: NSRange, composing: Bool) {
        guard self.text != text || self.selection != selection || self.composing != composing else { return }
        self.text = text
        self.selection = selection
        self.composing = composing
        sequence += 1
    }

    mutating func acknowledge(_ ack: Int) {
        guard ack >= acknowledged, ack <= sequence else { return }
        acknowledged = ack
        if acknowledged == sequence { failure = false }
    }

    mutating func reconcile(_ state: NativeComposerState, marked: Bool) -> Bool {
        acknowledge(state.ack)
        guard state.ack == sequence, !marked, !composing, state.text != text else { return false }
        text = state.text
        selection = NSRange(location: min(selection.location, text.utf16.count), length: 0)
        return true
    }
}


struct NativeKeyboardTransitionGeometry {
    let height: CGFloat
    let docked: Bool
    let viewportHeight: CGFloat
    var bottomInset: CGFloat { max(0, viewportHeight - height) }

    static func resolve(host: CGRect, safeBottom: CGFloat, keyboard: CGRect, trayHeight: CGFloat,
                        trayBottomConstant: CGFloat, webTop: CGFloat) -> NativeKeyboardTransitionGeometry {
        let intersection = keyboard.intersection(host)
        let docked = !intersection.isNull && intersection.height > 0 &&
            keyboard.maxY >= host.maxY - 1 && keyboard.minX <= host.minX + 1 && keyboard.maxX >= host.maxX - 1
        let guideTop = docked ? max(host.minY, keyboard.minY) : safeBottom
        return NativeKeyboardTransitionGeometry(height: max(0, guideTop + trayBottomConstant - trayHeight - webTop), docked: docked,
                                                viewportHeight: max(0, (docked ? guideTop : host.maxY) - webTop))
    }
}

struct NativePanelIdentity {
    private(set) var document: String?
    private(set) var generation = 0
    func canAdvance(document nextDocument: String, generation nextGeneration: Int) -> Bool {
        UUID(uuidString: nextDocument) != nil && nextGeneration > generation &&
            nextGeneration <= 9_007_199_254_740_991 && (document == nil || document == nextDocument)
    }
    mutating func advance(document: String, generation: Int) {
        precondition(canAdvance(document: document, generation: generation))
        self.document = document; self.generation = generation
    }
    func current(document: String, generation: Int) -> Bool { self.document == document && self.generation == generation }
    mutating func navigation() { document = nil; generation = 0 }
}

struct NativePanelKeyboardGate {
    static func occludes(frame: CGRect, usable: CGRect) -> Bool {
        let overlap = usable.intersection(frame)
        return !overlap.isNull && overlap.width > 0 && overlap.height > 0
    }
    static func ready(didHide: Bool, endOccludes: Bool, guideVisible: Bool, moving: Bool) -> Bool {
        didHide && !endOccludes && !guideVisible && !moving
    }
}
