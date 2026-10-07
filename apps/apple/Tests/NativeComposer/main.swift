import Foundation

let document = UUID().uuidString
let session = UUID().uuidString
func payload(text: String = "draft", ack: Int = 0) -> [String: Any] {
    ["version": 1, "document": document, "session": session, "scope": "workspace:conversation",
     "generation": 1, "text": text, "revision": "revision", "ack": ack, "visible": true,
     "editable": true, "sendEnabled": true, "attachEnabled": true, "placeholder": "메시지", "error": "",
     "theme": ["canvas": "#ffffff", "surface": "#ffffff", "ink": "#202329", "muted": "#656c77", "accent": "#225bd9"]]
}
func check(_ name: String, _ condition: Bool) {
    precondition(condition, name)
    print("PASS: \(name)")
}
let initial = NativeComposerState.parse(payload())!
check("valid negotiated state parses", initial.text == "draft")
check("UTF16 API limit rejects 50001 emoji", NativeComposerState.parse(payload(text: String(repeating: "🙂", count: 50_001))) == nil)
check("UTF16 API limit accepts 50000 emoji", NativeComposerState.parse(payload(text: String(repeating: "🙂", count: 50_000))) != nil)
var invalid = payload(); invalid["ack"] = -1
check("negative acknowledgment rejected", NativeComposerState.parse(invalid) == nil)
invalid = payload(); invalid["document"] = "other"
check("invalid document identity rejected", NativeComposerState.parse(invalid) == nil)
invalid = payload(); invalid["theme"] = ["canvas": "javascript:alert(1)"]
check("invalid theme rejected", NativeComposerState.parse(invalid) == nil)
var buffer = NativeComposerBuffer(text: "draft", sequence: 0, acknowledged: 0, selection: NSRange(location: 5, length: 0))
buffer.capture(text: "draft newer", selection: NSRange(location: 11, length: 0), composing: false)
check("stale clear cannot overwrite newer input", !buffer.reconcile(NativeComposerState.parse(payload(text: "", ack: 0))!, marked: false) && buffer.text == "draft newer")
buffer.acknowledge(9)
check("future acknowledgment cannot claim persisted", buffer.acknowledged == 0 && buffer.dirty)
buffer.acknowledge(1)
check("matching acknowledgment resolves pending edit", buffer.acknowledged == 1 && !buffer.dirty)
buffer.capture(text: "한", selection: NSRange(location: 1, length: 0), composing: true)
check("marked IME cannot be replaced", !buffer.reconcile(NativeComposerState.parse(payload(text: "", ack: 2))!, marked: true) && buffer.text == "한")
buffer.capture(text: "한", selection: NSRange(location: 1, length: 0), composing: false)
check("committed IME accepts matching canonical clear", buffer.reconcile(NativeComposerState.parse(payload(text: "", ack: 3))!, marked: false) && buffer.text.isEmpty)
let before = buffer.sequence
buffer.capture(text: "", selection: NSRange(location: 0, length: 0), composing: false)
check("identical capture does not create new edit", buffer.sequence == before)
buffer.capture(text: "🙂가", selection: NSRange(location: 2, length: 1), composing: false)
check("selection indices remain UTF16", buffer.selection == NSRange(location: 2, length: 1))
buffer.failure = true
buffer.acknowledge(buffer.sequence - 1)
check("stale acknowledgment cannot hide latest failure", buffer.failure)
buffer.acknowledge(buffer.sequence)
check("latest accepted acknowledgment clears recovery failure", !buffer.failure)
print("PASS: 15 native protocol and reconciliation scenarios")

let host = CGRect(x: 0, y: 0, width: 402, height: 812)
func geometry(_ keyboard: CGRect, safe: CGFloat = 778, tray: CGFloat = 104, top: CGFloat = 0) -> NativeKeyboardTransitionGeometry {
    NativeKeyboardTransitionGeometry.resolve(host: host, safeBottom: safe, keyboard: keyboard,
        trayHeight: tray, trayBottomConstant: -8, webTop: top)
}
let docked = geometry(CGRect(x: 0, y: 510, width: 402, height: 302))
check("docked target uses actual tray height and converted keyboard top", docked.docked && docked.height == 398)
let hidden = geometry(CGRect(x: 0, y: 812, width: 402, height: 302))
check("hidden keyboard uses actual host safe area", !hidden.docked && hidden.height == 666)
let floating = geometry(CGRect(x: 140, y: 400, width: 240, height: 200))
check("floating keyboard follows default guide safe area", !floating.docked && floating.height == 666)
let undocked = geometry(CGRect(x: 0, y: 300, width: 402, height: 300))
check("undocked full width keyboard does not impersonate docked guide", !undocked.docked && undocked.height == 666)
let clipped = geometry(CGRect(x: -49, y: 510, width: 500, height: 302))
check("keyboard covering narrower window is docked", clipped.docked && clipped.height == 398)
let inset = geometry(CGRect(x: 0, y: 812, width: 402, height: 302), safe: 767, tray: 160, top: 10)
check("changed safe area tray size and web top require no fixed keyboard constant", inset.height == 589)
let multiline = geometry(CGRect(x: 0, y: 510, width: 402, height: 302), tray: 160, top: 10)
check("multiline tray adjusts predicted content endpoint", multiline.height == 332)
let noSpace = geometry(CGRect(x: 0, y: 100, width: 402, height: 712), tray: 160)
check("covered viewport never predicts negative height", noSpace.height == 0)
print("PASS: 8 keyboard endpoint geometry scenarios (23 total native scenarios)")

check("3999 pasted UTF16 units remain text", !NativePastePolicy.needsAttachment(String(repeating: "a", count: 3999)))
check("4000 pasted UTF16 units become file", NativePastePolicy.needsAttachment(String(repeating: "a", count: 4000)))
check("emoji uses matching UTF16 boundary", NativePastePolicy.needsAttachment(String(repeating: "🙂", count: 2000)) && !NativePastePolicy.needsAttachment(String(repeating: "🙂", count: 1999)))
check("79 lines remain text", !NativePastePolicy.needsAttachment(Array(repeating: "line", count: 79).joined(separator: "\n")))
check("80 lines become file", NativePastePolicy.needsAttachment(Array(repeating: "line", count: 80).joined(separator: "\n")))
check("plain paste preserves literal formatting", NativePastePolicy.plainText("  # heading\r\n\r\n```ts\rlet x = \"한🙂\";  \r\n```\r\n") == "  # heading\n\n```ts\nlet x = \"한🙂\";  \n```\n")
print("PASS: 6 native paste policy scenarios (29 total native scenarios)")

check("overlay keeps full physical docked viewport", docked.viewportHeight == 510 && docked.bottomInset == 112)
check("overlay keeps full physical hidden viewport", hidden.viewportHeight == 812 && hidden.bottomInset == 146)
check("overlay latest endpoint equals prior unobscured endpoint", 2000 + docked.bottomInset - docked.viewportHeight == 2000 - docked.height)
let tallOverlay = geometry(CGRect(x: 0, y: 510, width: 402, height: 302), tray: 184)
check("growing input reserves only its new obstruction", tallOverlay.viewportHeight == docked.viewportHeight && tallOverlay.bottomInset == 192)
check("nonfloating footer adds exactly one reservation", 2000 + docked.bottomInset + 68 - docked.viewportHeight == 2000 - (docked.height - 68))
print("PASS: 5 physical overlay and logical bottom-inset scenarios")

check("home indicator extension preserves original readable endpoint", 2000 + hidden.bottomInset - hidden.viewportHeight == 2000 - hidden.height)
