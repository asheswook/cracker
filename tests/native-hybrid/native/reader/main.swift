import Foundation
var checks = 0
func check(_ label: String, _ value: Bool) { guard value else { print("FAIL \(label)"); exit(1) }; checks += 1; print("PASS \(label)") }
let document = UUID().uuidString
func packet(_ sequence: Int, _ kind: String = "bind", scope: String = "assistant", navigation: Int = 1, interaction: Int = 0, mode: String = "follow", suspended: Bool = false) -> [String: Any] {
    ["v": 1, "kind": kind, "document": document, "scope": scope, "navigation": navigation, "sequence": sequence,
     "interaction": interaction, "geometry": 0, "mode": mode, "suspended": suspended, "width": 750, "height": 270, "contentHeight": 4700, "offset": 4430]
}
func parse(_ wire: [String: Any]) -> NativeReaderPacket { NativeReaderPacket.parse(wire)! }
var session = NativeReaderSession()
let first = parse(packet(1))
check("fresh bind accepted", session.error(for: first) == nil)
session.accept(first)
check("identical sequence idempotent", session.error(for: first) == nil && session.duplicate(first))
check("changed same sequence rejected", session.error(for: parse(packet(1, mode: "reading"))) == "changed_sequence")
session.userBegan()
check("native drag immediately invalidates queued follow", session.interaction == 1 && session.mode == "reading" && session.error(for: parse(packet(2, "move"))) == "stale_interaction")
check("higher navigation cannot bypass physical drag epoch", session.error(for: parse(packet(2, scope: "archive", navigation: 2))) == "stale_interaction")
let read = parse(packet(3, "move", interaction: 1, mode: "reading"))
check("current interaction read command accepted", session.error(for: read) == nil)
session.accept(read)
let hide = parse(packet(4, interaction: 1, mode: "reading", suspended: true))
session.accept(hide)
check("panel suspension retains reading mode and binding", session.bound && session.suspended && session.mode == "reading")
let archive = parse(packet(5, scope: "archive", navigation: 2, interaction: 1, mode: "reading"))
check("read-only archive has independent reader lifetime", session.error(for: archive) == nil)
session.accept(archive)
check("late prior conversation command rejected", session.error(for: parse(packet(6, "move", interaction: 1))) == "stale_navigation")
session.release()
check("released document cannot late rebind", !session.bound && session.error(for: parse(packet(7, navigation: 3, interaction: 1))) == "retired_document")
var next = packet(1); next["document"] = UUID().uuidString
check("fresh document after release accepted", session.error(for: parse(next)) == nil)
var bad = packet(1); bad["navigation"] = true
check("boolean navigation rejected", NativeReaderPacket.parse(bad) == nil)
bad = packet(1); bad["sequence"] = 1.2
check("fractional sequence rejected", NativeReaderPacket.parse(bad) == nil)
bad = packet(1, "layout"); bad["width"] = -1
check("invalid layout geometry rejected", NativeReaderPacket.parse(bad) == nil)
bad = packet(1, "move", mode: "reading"); bad.removeValue(forKey: "offset")
check("reading move requires target", NativeReaderPacket.parse(bad) == nil)
bad = packet(1); bad["scope"] = String(repeating: "x", count: 513)
check("scope length bound enforced", NativeReaderPacket.parse(bad) == nil)
bad = packet(1); bad["padding"] = String(repeating: "x", count: 33000)
check("packet bound enforced", NativeReaderPacket.parse(bad) == nil)
let landscape = parse(packet(9, "layout"))
check("mixed old viewport cannot reconcile rotation", !landscape.matchesGeometry(width: 402, height: 666, contentHeight: 4700))
check("matching settled viewport accepts rotation reconciliation", landscape.matchesGeometry(width: 750, height: 270, contentHeight: 4700))
check("stale content extent cannot restore anchor", !landscape.matchesGeometry(width: 750, height: 270, contentHeight: 4898))
check("rotate away and back rejects old geometry epoch despite matching dimensions", landscape.matchesGeometry(width: 750, height: 270, contentHeight: 4700) && !landscape.matchesGeometryRevision(2))
check("current geometry epoch accepted", landscape.matchesGeometryRevision(0))
var gate = NativeReaderMovementGate()
gate.keyboardWill()
check("keyboard begun during drag stays busy after drag ends", !gate.allows(suspended: false, dragging: true) && !gate.allows(suspended: false, dragging: false))
check("keyboard begun with hidden composer stays busy when reader resumes", !gate.allows(suspended: true, dragging: false) && !gate.allows(suspended: false, dragging: false))
gate.keyboardDid()
check("only keyboard completion releases independent movement gate", gate.allows(suspended: false, dragging: false))
print("\(checks) native reader protocol checks passed")
