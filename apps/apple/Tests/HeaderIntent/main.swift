import Foundation

var failures = 0
var checks = 0
func check(_ condition: Bool, _ scenario: String) {
    checks += 1
    if !condition { failures += 1; print("FAIL \(scenario)") }
}
struct Fixture {
    var session = IndependentHeaderSession()
    var document = UUID().uuidString
    var header = UUID().uuidString
    var scope = "same-conversation"
    init() { session.ready(header); update(1); activate(1) }
    mutating func update(_ generation: Int, visible: Bool = true, working: Bool = false,
                         archive: Bool = true, time: Bool = true) {
        let wire: [String: Any] = ["v": 1, "kind": "state", "document": document, "generation": generation,
            "scope": scope, "visible": visible, "props": ["name": "Assistant", "archiveTitle": archive ? "Archive" as Any : NSNull(),
            "connected": true, "working": working, "computerOpen": false, "scheme": "light", "appearance": ["test": true],
            "time": ["available": time, "pinned": false]]]
        guard let state = IndependentHeaderState.parse(wire) else { fatalError("Invalid fixture state") }
        check(session.accept(state), "fixture state accepted")
    }
    mutating func activate(_ generation: Int) {
        let wire: [String: Any] = ["document": header, "mainDocument": document, "scope": scope,
            "generation": generation, "height": 120, "rects": [["x": 12, "y": 20, "width": 44, "height": 44]]]
        guard let geometry = IndependentHeaderGeometry.parse(wire) else { fatalError("Invalid fixture geometry") }
        check(session.geometry(geometry), "fixture geometry accepted")
        check(session.activate(["document": document, "headerDocument": header, "generation": generation]), "fixture activation accepted")
    }
    func command(_ action: String, generation: Int = 1) -> [String: Any] {
        ["v": 1, "kind": "action", "document": header, "mainDocument": document, "scope": scope,
         "generation": generation, "commandId": UUID().uuidString, "action": action]
    }
}
for action in ["menu", "settings", "computer", "time-toggle", "archive-return"] {
    var f = Fixture()
    let command = f.command(action)
    f.update(2, working: true)
    check(f.session.visible, "same-context header remains visible")
    check(f.session.action(command), "\(action) admitted across cosmetic generation")
    check(!f.session.action(command), "\(action) duplicate never admitted twice")
}
for action in ["menu", "settings", "computer", "time-toggle", "archive-return"] {
    for scopeChange in [false, true] {
        var f = Fixture()
        let command = f.command(action)
        if scopeChange { f.scope = "other-conversation" }
        f.update(2, visible: scopeChange)
        f.scope = "same-conversation"
        f.update(3); f.activate(3)
        check(!f.session.action(command), "\(action) rejected across context ABA")
    }
}
do {
    var f = Fixture()
    let menu = f.command("menu"), settings = f.command("settings")
    f.update(2, working: true)
    check(f.session.action(menu), "first old intent executes")
    check(f.session.action(settings), "second distinct old intent executes")
    f.update(3, visible: false); f.update(4); f.activate(4)
    check(!f.session.action(menu) && !f.session.action(settings), "neither pre-hide action revives")
    let current = f.command("menu", generation: 4)
    check(f.session.action(current), "new post-hide intent executes")
    check(!f.session.action(current), "new post-hide intent deduplicated")
}
do {
    var f = Fixture()
    let oldTime = f.command("time-toggle"), oldArchive = f.command("archive-return")
    f.update(2, archive: false, time: false)
    check(!f.session.action(oldTime) && !f.session.action(oldArchive), "old intents respect latest availability")
    check(!f.session.action(f.command("time-toggle", generation: 2)), "current unavailable time rejected")
    check(!f.session.action(f.command("archive-return", generation: 2)), "current unavailable archive rejected")
    check(!f.session.action(f.command("menu", generation: 99)), "future generation rejected")
}
do {
    var f = Fixture(); let old = f.command("menu")
    f.update(2, working: true)
    f.header = UUID().uuidString; f.session.ready(f.header); f.activate(2)
    check(!f.session.action(old), "old header document rejected")
    check(!f.session.action(f.command("menu", generation: 1)), "new header cannot use preceding header generation")
    check(f.session.action(f.command("menu", generation: 2)), "fresh header current action accepted")
}
do {
    var f = Fixture(); let old = f.command("menu")
    f.session.resetMain(); f.document = UUID().uuidString; f.update(1); f.activate(1)
    check(!f.session.action(old), "old main document rejected")
    check(f.session.action(f.command("menu")), "new main document action accepted")
}
do {
    var f = Fixture(); f.update(2, working: true)
    check(!f.session.activate(["document": f.document, "headerDocument": f.header, "generation": 1]), "activation still requires latest generation")
    let wire: [String: Any] = ["document": f.header, "mainDocument": f.document, "scope": f.scope,
        "generation": 1, "height": 120, "rects": [["x": 12, "y": 20, "width": 44, "height": 44]]]
    guard let old = IndependentHeaderGeometry.parse(wire) else { fatalError("Invalid old geometry") }
    check(!f.session.geometry(old), "geometry still requires latest generation")
}
print("checks=\(checks) failures=\(failures)")
exit(failures == 0 ? 0 : 1)
