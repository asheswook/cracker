import Foundation

struct IndependentFooterState {
    let document: String
    let scope: String
    let generation: Int
    let visible: Bool
    let wire: [String: Any]
    var latestOnly: Bool {
        guard let props = wire["props"] as? [String: Any],
              props["latest"] as? Bool == true, props["readOnly"] as? Bool == false,
              props["task"] is NSNull, props["error"] as? String == "",
              let storage = props["storage"] as? [String: Any], storage["failed"] as? Bool == false,
              let drafts = props["drafts"] as? [[String: Any]], drafts.isEmpty else { return false }
        return true
    }

    static func parse(_ packet: [String: Any]) -> Self? {
        guard packet["kind"] as? String == "state", let document = HeaderWire.uuid(packet["document"]),
              let scope = HeaderWire.string(packet["scope"], limit: 512),
              let generation = HeaderWire.integer(packet["generation"]), generation > 0,
              let visible = HeaderWire.boolean(packet["visible"]), let props = packet["props"] as? [String: Any],
              let scheme = props["scheme"] as? String, ["light", "dark"].contains(scheme),
              HeaderWire.boolean(props["readOnly"]) != nil, HeaderWire.boolean(props["latest"]) != nil,
              HeaderWire.string(props["error"], limit: 8192) != nil,
              let storage = props["storage"] as? [String: Any], HeaderWire.boolean(storage["failed"]) != nil,
              HeaderWire.boolean(storage["retrying"]) != nil,
              let drafts = props["drafts"] as? [[String: Any]], drafts.count <= 8 else { return nil }
        if !(props["task"] is NSNull) {
            guard let task = props["task"] as? [String: Any], HeaderWire.uuid(task["id"]) != nil,
                  let status = task["state"] as? String, ["failed", "unknown"].contains(status),
                  task["reason"] is NSNull || HeaderWire.string(task["reason"], limit: 2000) != nil,
                  HeaderWire.boolean(task["reasonTruncated"]) != nil else { return nil }
        }
        for draft in drafts {
            guard HeaderWire.uuid(draft["id"]) != nil, HeaderWire.string(draft["name"], limit: 4096) != nil,
                  let status = draft["status"] as? String, ["ready", "uploading", "stored"].contains(status),
                  HeaderWire.string(draft["error"], limit: 8192) != nil,
                  HeaderWire.boolean(draft["canRetry"]) != nil, HeaderWire.boolean(draft["canRemove"]) != nil else { return nil }
            if !(draft["progress"] is NSNull) {
                guard let progress = HeaderWire.number(draft["progress"]), (0...100).contains(progress) else { return nil }
            }
        }
        return Self(document: document, scope: scope, generation: generation, visible: visible, wire: packet)
    }
}

enum IndependentFooterLayout {
    static func height(requested: Double, available: Double, header: Double) -> Double {
        // Reserve the measured header and one 44pt feed band. The footer has one
        // independently scrolling viewport; its intrinsic request never uses this cap.
        let capacity = max(0, available - max(0, header) - 44)
        guard requested > 0, capacity >= 44 else { return 0 }
        return min(requested, capacity, 220)
    }
}

struct IndependentFooterSession {
    private(set) var state: IndependentFooterState?
    private(set) var footerDocument: String?
    private(set) var geometryRevision = 0
    private(set) var geometryGeneration: Int?
    private(set) var activeGeneration: Int?
    private(set) var revision = 0
    private(set) var activationRevision: Int?
    var visible: Bool { state?.visible == true && activeGeneration != nil && footerDocument != nil }

    mutating func resetMain() { state = nil; geometryGeneration = nil; activeGeneration = nil; activationRevision = nil }
    mutating func resetFooter() { footerDocument = nil; geometryRevision = 0; geometryGeneration = nil; activeGeneration = nil; activationRevision = nil }
    mutating func ready(_ document: String) {
        guard footerDocument != document else { return }
        resetFooter(); footerDocument = document
    }
    mutating func accept(_ next: IndependentFooterState) -> Bool {
        if let current = state {
            guard current.document == next.document else { return false }
            if current.generation == next.generation { return NSDictionary(dictionary: current.wire).isEqual(to: next.wire) }
            guard next.generation > current.generation else { return false }
            if current.scope != next.scope { activeGeneration = nil }
        }
        state = next; geometryGeneration = nil; activationRevision = nil
        return true
    }
    func matches(_ packet: [String: Any]) -> Bool {
        guard let state else { return false }
        return packet["document"] as? String == footerDocument && packet["mainDocument"] as? String == state.document &&
            packet["scope"] as? String == state.scope && HeaderWire.integer(packet["generation"]) == state.generation
    }
    mutating func geometry(_ packet: [String: Any]) -> Bool {
        guard matches(packet), let next = HeaderWire.integer(packet["geometryRevision"]), next > geometryRevision else { return false }
        geometryRevision = next; geometryGeneration = state?.generation
        return true
    }
    mutating func event(_ kind: String) -> [String: Any]? {
        guard let state, let footerDocument else { return nil }
        revision += 1
        if kind == "activate" { activationRevision = revision }
        return ["v": 1, "kind": kind, "document": state.document, "footerDocument": footerDocument,
                "scope": state.scope, "generation": state.generation, "revision": revision]
    }
    mutating func activate(_ packet: [String: Any]) -> Bool {
        guard let state, packet["document"] as? String == state.document,
              packet["footerDocument"] as? String == footerDocument, packet["scope"] as? String == state.scope,
              HeaderWire.integer(packet["generation"]) == state.generation, geometryGeneration == state.generation,
              let activationRevision, HeaderWire.integer(packet["revision"]) == activationRevision else { return false }
        activeGeneration = state.generation; return true
    }
    func action(_ packet: [String: Any]) -> Bool {
        guard visible, matches(packet), HeaderWire.uuid(packet["commandId"]) != nil,
              let action = packet["action"] as? String else { return false }
        switch action {
        case "latest", "retry-storage", "task-details": return packet["draftId"] == nil
        case "retry-upload", "remove-draft": return HeaderWire.uuid(packet["draftId"]) != nil
        default: return false
        }
    }
}
