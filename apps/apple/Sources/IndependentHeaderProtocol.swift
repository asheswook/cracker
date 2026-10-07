import Foundation

enum IndependentHeaderReply: Equatable {
    case accepted, stale, failed
    static func parse(_ value: Any?) -> Self {
        guard let object = value as? [String: Any], let ok = HeaderWire.boolean(object["ok"]) else { return .failed }
        if ok { return .accepted }
        if let error = object["error"] as? String,
           ["stale_event", "stale_header", "inactive_header", "hidden", "time_unavailable"].contains(error) { return .stale }
        return .failed
    }
}
import CoreFoundation

enum HeaderWire {
    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991 else { return nil }
        return number.intValue
    }
    static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    static func uuid(_ value: Any?) -> String? {
        guard let value = value as? String, UUID(uuidString: value) != nil else { return nil }
        return value
    }
    static func string(_ value: Any?, limit: Int) -> String? {
        guard let value = value as? String, value.utf16.count <= limit else { return nil }
        return value
    }
    static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }
    static func object(_ value: Any, limit: Int = 32 * 1024) -> [String: Any]? {
        guard let object = value as? [String: Any], integer(object["v"]) == 1,
              JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object), data.count <= limit else { return nil }
        return object
    }
}

struct IndependentHeaderState {
    let document: String
    let generation: Int
    let scope: String
    let visible: Bool
    let wire: [String: Any]

    static func parse(_ object: [String: Any]) -> Self? {
        guard object["kind"] as? String == "state", let document = HeaderWire.uuid(object["document"]),
              let generation = HeaderWire.integer(object["generation"]), generation > 0,
              let scope = HeaderWire.string(object["scope"], limit: 512),
              let visible = HeaderWire.boolean(object["visible"]), let props = object["props"] as? [String: Any],
              HeaderWire.string(props["name"], limit: 80) != nil,
              props["archiveTitle"] is NSNull || HeaderWire.string(props["archiveTitle"], limit: 200) != nil,
              HeaderWire.boolean(props["connected"]) != nil, HeaderWire.boolean(props["computerOpen"]) != nil,
              HeaderWire.boolean(props["working"]) != nil,
              let scheme = props["scheme"] as? String, ["light", "dark"].contains(scheme),
              let appearance = props["appearance"] as? [String: Any], !appearance.isEmpty, appearance.count <= 20,
              let time = props["time"] as? [String: Any], HeaderWire.boolean(time["available"]) != nil,
              HeaderWire.boolean(time["pinned"]) != nil else { return nil }
        return Self(document: document, generation: generation, scope: scope, visible: visible, wire: object)
    }
}

struct IndependentHeaderGeometry {
    let document: String
    let mainDocument: String
    let generation: Int
    let scope: String
    let height: Double
    let rectangles: [[Double]]

    static func parse(_ object: [String: Any]) -> Self? {
        guard let document = HeaderWire.uuid(object["document"]), let mainDocument = HeaderWire.uuid(object["mainDocument"]),
              let generation = HeaderWire.integer(object["generation"]),
              let scope = HeaderWire.string(object["scope"], limit: 512), let height = HeaderWire.number(object["height"]),
              height > 0, let rects = object["rects"] as? [[String: Any]], rects.count <= 16 else { return nil }
        var rectangles: [[Double]] = []
        for rect in rects {
            guard let x = HeaderWire.number(rect["x"]), let y = HeaderWire.number(rect["y"]),
                  let width = HeaderWire.number(rect["width"]), let h = HeaderWire.number(rect["height"]),
                  x >= 0, y >= 0, width > 0, h > 0, y + h <= height + 1 else { return nil }
            rectangles.append([x, y, width, h])
        }
        return Self(document: document, mainDocument: mainDocument, generation: generation, scope: scope, height: height, rectangles: rectangles)
    }
}

struct IndependentHeaderSession {
    private(set) var state: IndependentHeaderState?
    private(set) var headerDocument: String?
    private(set) var geometryGeneration: Int?
    private(set) var activeGeneration: Int?
    private var actionGenerationFloor = 0
    private var commands = Set<String>()
    private var commandOrder: [String] = []

    var visible: Bool { state?.visible == true && activeGeneration != nil && headerDocument != nil }
    mutating func resetMain() {
        state = nil; geometryGeneration = nil; activeGeneration = nil; actionGenerationFloor = 0
        commands.removeAll(); commandOrder.removeAll()
    }
    mutating func resetHeader() {
        headerDocument = nil; geometryGeneration = nil; activeGeneration = nil
        actionGenerationFloor = state?.generation ?? 0
    }
    mutating func ready(_ document: String) {
        guard headerDocument != document else { return }
        resetHeader(); headerDocument = document
    }
    mutating func accept(_ next: IndependentHeaderState) -> Bool {
        if let current = state {
            guard current.document == next.document else { return false }
            if next.generation == current.generation { return NSDictionary(dictionary: current.wire).isEqual(to: next.wire) }
            guard next.generation > current.generation else { return false }
            if next.scope != current.scope { activeGeneration = nil }
        }
        if state == nil || state?.scope != next.scope || state?.visible != next.visible { actionGenerationFloor = next.generation }
        state = next; geometryGeneration = nil
        return true
    }
    mutating func geometry(_ value: IndependentHeaderGeometry) -> Bool {
        guard let state, value.document == headerDocument, value.mainDocument == state.document,
              value.generation == state.generation, value.scope == state.scope else { return false }
        geometryGeneration = value.generation
        return true
    }
    mutating func activate(_ object: [String: Any]) -> Bool {
        guard let state, object["document"] as? String == state.document,
              object["headerDocument"] as? String == headerDocument,
              HeaderWire.integer(object["generation"]) == state.generation,
              geometryGeneration == state.generation else { return false }
        activeGeneration = state.generation
        return true
    }
    mutating func action(_ object: [String: Any]) -> Bool {
        guard visible, let state, object["document"] as? String == headerDocument,
              object["mainDocument"] as? String == state.document, object["scope"] as? String == state.scope,
              let generation = HeaderWire.integer(object["generation"]),
              generation >= actionGenerationFloor, generation <= state.generation,
              let command = HeaderWire.uuid(object["commandId"]),
              let action = object["action"] as? String, ["menu", "settings", "computer", "time-toggle", "archive-return"].contains(action),
              !commands.contains(command) else { return false }
        if action == "archive-return", let props = state.wire["props"] as? [String: Any], props["archiveTitle"] is NSNull { return false }
        if action == "time-toggle", let props = state.wire["props"] as? [String: Any],
           let time = props["time"] as? [String: Any], HeaderWire.boolean(time["available"]) != true { return false }
        commands.insert(command); commandOrder.append(command)
        if commandOrder.count > 256 { commands.remove(commandOrder.removeFirst()) }
        return true
    }
}
