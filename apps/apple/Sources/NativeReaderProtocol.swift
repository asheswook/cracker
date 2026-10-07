import Foundation

struct NativeReaderMovementGate {
    private(set) var keyboardMoving = false
    mutating func keyboardWill() { keyboardMoving = true }
    mutating func keyboardDid() { keyboardMoving = false }
    func allows(suspended: Bool, dragging: Bool) -> Bool { !keyboardMoving && !suspended && !dragging }
}

struct NativeReaderPacket {
    let wire: [String: Any]
    let kind: String
    let document: String
    let scope: String
    let navigation: Int
    let sequence: Int
    let interaction: Int?
    let geometry: Int?
    let mode: String?
    let suspended: Bool?
    let width: Double?
    let height: Double?
    let contentHeight: Double?
    let offset: Double?
    func matchesGeometryRevision(_ current: Int) -> Bool { geometry == current }
    func matchesGeometry(width: Double, height: Double, contentHeight: Double) -> Bool {
        guard kind == "layout", let measuredWidth = self.width, let measuredHeight = self.height,
              let measuredContent = self.contentHeight else { return false }
        return abs(measuredWidth - width) < 1 && abs(measuredHeight - height) < 1 && abs(measuredContent - contentHeight) < 1
    }
    static func parse(_ value: Any) -> Self? {
        guard let wire = HeaderWire.object(value), let kind = wire["kind"] as? String,
              ["bind", "layout", "move", "release"].contains(kind),
              let document = HeaderWire.uuid(wire["document"]),
              let scope = HeaderWire.string(wire["scope"], limit: 512), !scope.isEmpty,
              let navigation = HeaderWire.integer(wire["navigation"]), navigation > 0,
              let sequence = HeaderWire.integer(wire["sequence"]), sequence > 0 else { return nil }
        let interaction = HeaderWire.integer(wire["interaction"])
        let geometry = HeaderWire.integer(wire["geometry"])
        if wire["interaction"] != nil && (interaction == nil || interaction! < 0) { return nil }
        let mode = wire["mode"] as? String
        if kind != "release" && (mode == nil || !["follow", "reading", "source"].contains(mode!)) { return nil }
        let suspended = HeaderWire.boolean(wire["suspended"])
        if kind == "bind" && suspended == nil { return nil }
        let width = HeaderWire.number(wire["width"]), height = HeaderWire.number(wire["height"])
        let content = HeaderWire.number(wire["contentHeight"]), offset = HeaderWire.number(wire["offset"])
        if kind == "layout" && !(width.map { $0 > 0 && $0 < 20000 } == true && height.map { $0 > 0 && $0 < 20000 } == true && content.map { $0 >= 0 && $0 < 100000000 } == true) { return nil }
        if (kind == "layout" || kind == "move") && (interaction == nil || geometry == nil) { return nil }
        if wire["offset"] != nil && !(offset.map { abs($0) < 100000000 } == true) { return nil }
        if kind == "move" && mode != "follow" && offset == nil { return nil }
        return Self(wire: wire, kind: kind, document: document, scope: scope, navigation: navigation, sequence: sequence,
                    interaction: interaction, geometry: geometry, mode: mode, suspended: suspended, width: width, height: height, contentHeight: content, offset: offset)
    }
}

struct NativeReaderSession {
    private(set) var document: String?
    private(set) var scope: String?
    private(set) var navigation = 0
    private(set) var sequence = 0
    private(set) var interaction = 0
    var mode = "follow"
    var suspended = false
    private var lastWire: [String: Any]?
    private var retired: [String] = []
    var bound: Bool { document != nil && scope != nil }
    mutating func reset() { self = Self() }
    mutating func release() {
        var retired = self.retired
        if let document { retired.append(document) }
        self = Self(); self.retired = Array(retired.suffix(8))
    }
    mutating func userBegan() { interaction += 1; mode = "reading" }
    func error(for packet: NativeReaderPacket) -> String? {
        if retired.contains(packet.document) { return "retired_document" }
        if let document, packet.document != document { return "stale_document" }
        if packet.kind == "bind" {
            if packet.navigation < navigation || (packet.navigation == navigation && scope != nil && packet.scope != scope) { return "stale_navigation" }
            if document != nil && packet.interaction != interaction { return "stale_interaction" }
        } else {
            if !bound || packet.scope != scope || packet.navigation != navigation { return "stale_navigation" }
            if packet.kind != "release" && packet.interaction != interaction { return "stale_interaction" }
        }
        if packet.sequence < sequence { return "stale_sequence" }
        if packet.sequence == sequence && !(lastWire.map { NSDictionary(dictionary: $0).isEqual(to: packet.wire) } ?? false) { return "changed_sequence" }
        return nil
    }
    func duplicate(_ packet: NativeReaderPacket) -> Bool { packet.sequence == sequence }
    mutating func accept(_ packet: NativeReaderPacket) {
        document = packet.document; scope = packet.scope; navigation = packet.navigation
        sequence = packet.sequence; lastWire = packet.wire
        if let mode = packet.mode { self.mode = mode }
        if let suspended = packet.suspended { self.suspended = suspended }
    }
}
