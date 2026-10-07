import Foundation
var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { fatalError("FAIL: \(name)") }
    checks += 1; print("PASS \(checks): \(name)")
}
let main = UUID().uuidString, footer = UUID().uuidString
func packet(_ generation: Int = 1, scope: String = "live") -> [String: Any] {
    ["v": 1, "kind": "state", "document": main, "scope": scope, "generation": generation, "visible": true,
     "props": ["scheme": "light", "readOnly": false, "latest": true, "error": "", "task": NSNull(),
               "storage": ["failed": false, "retrying": false], "drafts": []]]
}
var session = IndependentFooterSession()
let initial = IndependentFooterState.parse(packet())!
check(initial.latestOnly, "latest alone floats without reserving a full-width band")
for (key, value) in [("readOnly", true as Any), ("error", "failure" as Any),
                     ("storage", ["failed": true, "retrying": false] as Any), ("latest", false as Any)] {
    var valuePacket = packet()
    var valueProps = valuePacket["props"] as! [String: Any]
    valueProps[key] = value; valuePacket["props"] = valueProps
    check(!IndependentFooterState.parse(valuePacket)!.latestOnly, "footer content reserves space: \(key)")
}
check(session.accept(initial), "first scoped state accepted")
session.ready(footer)
func geometry(_ generation: Int = 1, revision: Int = 1, scope: String = "live") -> [String: Any] {
    ["v": 1, "kind": "geometry", "document": footer, "mainDocument": main, "scope": scope,
     "generation": generation, "geometryRevision": revision, "width": 402, "intrinsicHeight": 0]
}
check(!session.visible, "no hiding canonical footer before geometry/activation")
check(session.geometry(geometry()), "empty geometry accepted")
var activation = session.event("activate")!
activation["kind"] = "active"
check(session.activate(activation), "matching activation revision accepted")
let staleActivation = activation
activation = session.event("activate")!; activation["kind"] = "active"
check(!session.activate(staleActivation), "superseded same-generation activation ACK rejected")
check(HeaderWire.integer(staleActivation["revision"]) != session.activationRevision, "superseded callback fails current activation guard")
check(session.activate(activation), "new activation survives older ACK rejection")
check(session.visible, "active footer visible even with empty geometry")
check(!session.geometry(geometry()), "repeated geometry revision rejected")
let action: [String: Any] = ["v": 1, "kind": "action", "document": footer, "mainDocument": main,
    "scope": "live", "generation": 1, "commandId": UUID().uuidString, "action": "latest"]
check(session.action(action), "valid latest action accepted")
check(session.accept(IndependentFooterState.parse(packet(2, scope: "archive"))!), "new scope accepted")
check(!session.visible, "scope change invalidates active sibling")
check(!session.action(action), "prior-scope action rejected")
check(!session.activate(activation), "old async activation cannot reactivate new scope")
check(!session.geometry(geometry(2, revision: 2)), "old-scope geometry rejected")
check(session.geometry(geometry(2, revision: 2, scope: "archive")), "current scoped geometry accepted")
activation = session.event("activate")!; activation["kind"] = "active"
_ = session.event("action")
check(session.activate(activation), "intervening action revision does not invalidate pending activation")
let current = IndependentFooterState.parse(packet(3, scope: "archive"))!
check(session.accept(current) && session.visible, "same-scope props preserve surface while geometry updates")
check(!session.accept(initial), "stale generation rejected")
session.resetFooter()
check(!session.visible, "surface failure hides native pane")
check(IndependentFooterLayout.height(requested: 0, available: 600, header: 122) == 0, "empty footer uses zero and no hit area")
check(IndependentFooterLayout.height(requested: 80, available: 600, header: 122) == 80, "short footer intrinsic height preserved")
check(IndependentFooterLayout.height(requested: 9000, available: 600, header: 122) == 220, "long reason has finite scroll viewport")
check(IndependentFooterLayout.height(requested: 9000, available: 270, header: 122) == 104, "landscape reserves actual header plus44 feed")
check(IndependentFooterLayout.height(requested: 80, available: 209, header: 122) == 0, "under44 capacity collapses for explicit tray recovery")
check(IndependentFooterLayout.height(requested: 80, available: 210, header: 122) == 44, "44pt boundary remains usable")
check(IndependentFooterLayout.height(requested: 80, available: 600, header: 122) == 80, "dismiss recovery recalculates without prior viewport feedback")
var oversized = packet()
var props = oversized["props"] as! [String: Any]
props["task"] = ["id": UUID().uuidString, "state": "failed", "reason": String(repeating: "x", count: 2001), "reasonTruncated": true]
oversized["props"] = props
check(IndependentFooterState.parse(oversized) == nil, "wire task preview bound enforced")
props["task"] = ["id": UUID().uuidString, "state": "failed", "reason": String(repeating: "x", count: 2000), "reasonTruncated": true]
oversized["props"] = props
check(IndependentFooterState.parse(oversized) != nil, "explicit truncated preview accepted")
var envelope = packet(); envelope["excess"] = String(repeating: "x", count: 262144)
check(HeaderWire.object(envelope, limit: 262144) == nil, "UTF8 envelope bounded")
print("RESULT: \(checks) native footer checks passed")
