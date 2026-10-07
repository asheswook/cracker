import Foundation

let body = UUID().uuidString
let header = UUID().uuidString
func state(_ generation: Int = 1, visible: Bool = true, scope: String = "workspace:conversation", name: String = "Assistant") -> [String: Any] {
    ["v": 1, "kind": "state", "document": body, "generation": generation, "scope": scope, "visible": visible,
     "props": ["name": name, "archiveTitle": NSNull(), "connected": true, "computerOpen": false, "working": false,
       "scheme": "light", "appearance": ["version": 1, "shape": "flower", "color": "coral", "eyes": "oval", "eyewear": "monocle", "accessory": "none"],
       "time": ["available": true, "pinned": false]]]
}
func geometry(_ generation: Int = 1, document: String = header, scope: String = "workspace:conversation") -> [String: Any] {
    ["v": 1, "kind": "geometry", "document": document, "mainDocument": body, "generation": generation,
     "scope": scope, "height": 140, "rects": [["x": 20, "y": 12, "width": 44, "height": 44]]]
}
func active(_ generation: Int = 1) -> [String: Any] {
    ["v": 1, "kind": "active", "document": body, "headerDocument": header, "generation": generation]
}
func action(_ generation: Int = 1, id: String = UUID().uuidString, scope: String = "workspace:conversation") -> [String: Any] {
    ["v": 1, "kind": "action", "document": header, "mainDocument": body, "generation": generation, "scope": scope,
     "commandId": id, "action": "time-toggle"]
}
var count = 0
func check(_ label: String, _ value: Bool) { guard value else { print("FAIL \(label)"); exit(1) }; count += 1; print("PASS \(label)") }
let parsed = IndependentHeaderState.parse(state())!
check("accepted action reply", IndependentHeaderReply.parse(["ok": true]) == .accepted)
check("stale action reply does not require fallback", IndependentHeaderReply.parse(["ok": false, "error": "stale_event"]) == .stale)
check("thrown action reply requires fallback", IndependentHeaderReply.parse(["ok": false, "error": "action_failed"]) == .failed)
check("missing or malformed reply requires fallback", IndependentHeaderReply.parse(nil) == .failed && IndependentHeaderReply.parse(["ok": 1]) == .failed)
check("wire accepts a bounded canonical header state", HeaderWire.object(state()) != nil)
var bad = state(); bad["v"] = true
check("boolean cannot masquerade as protocol version", HeaderWire.object(bad) == nil)
bad = state(); bad["padding"] = String(repeating: "x", count: 33000)
check("oversized packet rejected", HeaderWire.object(bad) == nil)
check("legacy overlimit name requires fallback rather than truncation", IndependentHeaderState.parse(state(name: String(repeating: "x", count: 81))) == nil)
bad = state(); bad["generation"] = 1.5
check("fractional generation rejected", IndependentHeaderState.parse(bad) == nil)
var session = IndependentHeaderSession()
check("first body state accepted", session.accept(parsed))
check("identical state retransmission idempotent", session.accept(parsed))
check("same generation with changed content rejected", !session.accept(IndependentHeaderState.parse(state(name: "Changed"))!))
session.ready(header)
check("header cannot appear before geometry and body commit", !session.visible && !session.activate(active()))
check("fresh measured geometry accepted", session.geometry(IndependentHeaderGeometry.parse(geometry())!))
check("body commit activates exactly that header generation", session.activate(active()) && session.visible)
let command = UUID().uuidString
check("current action accepted", session.action(action(id: command)))
check("duplicate toggle rejected", !session.action(action(id: command)))
check("prior-scope action rejected", !session.action(action(scope: "old:scope")))
check("new generation accepted while ready surface remains visible", session.accept(IndependentHeaderState.parse(state(2))!) && session.visible)
check("old render generation rejected", !session.accept(parsed))
check("old geometry cannot activate the new state", !session.geometry(IndependentHeaderGeometry.parse(geometry())!))
check("old-generation action rejected", !session.action(action()))
check("new geometry/commit refreshes ready state", session.geometry(IndependentHeaderGeometry.parse(geometry(2))!) && session.activate(active(2)))
var scoped = session
check("scope change invalidates old active surface", scoped.accept(IndependentHeaderState.parse(state(3, scope: "workspace:archive"))!) && !scoped.visible)
check("scope change requires fresh scoped geometry and commit", scoped.geometry(IndependentHeaderGeometry.parse(geometry(3, scope: "workspace:archive"))!) && scoped.activate(active(3)) && scoped.visible)
check("panel visibility immediately hides header and gates action", session.accept(IndependentHeaderState.parse(state(3, visible: false))!) && !session.visible && !session.action(action(3)))
session.resetHeader()
check("header failure retains canonical latest state but disables surface", session.state?.generation == 3 && session.headerDocument == nil && !session.visible)
let nextHeader = UUID().uuidString
session.ready(nextHeader)
check("reload rejects old header document geometry", !session.geometry(IndependentHeaderGeometry.parse(geometry(3))!))
check("reload accepts its new document geometry", session.geometry(IndependentHeaderGeometry.parse(geometry(3, document: nextHeader))!))
session.resetMain()
check("main navigation clears state and action history", session.state == nil && !session.visible)
bad = geometry(); bad["height"] = 0
check("zero geometry rejected", IndependentHeaderGeometry.parse(bad) == nil)
bad = geometry(); bad["rects"] = Array(repeating: ["x": 1, "y": 1, "width": 1, "height": 1], count: 17)
check("unbounded hit target list rejected", IndependentHeaderGeometry.parse(bad) == nil)
bad = geometry(); bad["rects"] = [["x": 1, "y": 130, "width": 1, "height": 44]]
check("hit target beyond measured header rejected", IndependentHeaderGeometry.parse(bad) == nil)
print("\(count) native header protocol checks passed")
var observedFailure = geometry()
observedFailure["height"] = 52
observedFailure["rects"] = [["x": 20, "y": 48, "width": 44, "height": 44]]
check("actual v5 stacked clock packet remains rejected, contract not weakened", IndependentHeaderGeometry.parse(observedFailure) == nil)
let path = CommandLine.arguments[1]
let results = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [[String: Any]]
for value in results.prefix(2) {
    var packet = geometry()
    packet["height"] = value["height"]
    packet["rects"] = value["rects"]
    check("actual browser \(value["scenario"]!) geometry accepted by unchanged Swift parser", IndependentHeaderGeometry.parse(packet) != nil)
}
print("\(count) total native header checks passed")
