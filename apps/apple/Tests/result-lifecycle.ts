import { mkdir } from 'node:fs/promises';

// Compile the production queue methods verbatim; replace only the WebKit dispatch boundary.
// This deterministically controls callback order without adding a test seam to the app.
const source = await Bun.file('apps/apple/Sources/WebShell.swift').text();
const start = source.indexOf('    func enqueueResult(');
const end = source.indexOf('    private func dispatch(', start);
if (start < 0 || end < 0) throw new Error('WebShell method boundaries changed');
const directory = '.omo/evidence/native-lifecycle-fix';
await mkdir(directory, { recursive: true });
await Bun.write(`${directory}/main.swift`, `
import Foundation
final class NotificationService {
    static let shared = NotificationService()
    let state: [String: Any] = [:]
}
final class Harness {
    var webReady = false
    var documentID = UUID()
    var results: [URL] = []
    var delivering = false
    var callbacks: [(Bool) -> Void] = []
    var deliveries = 0
    var conversation: String?
    var pendingResultConversation: String?
    var resultRevision = 0
${source.slice(start, end)}
    func dispatch(_ event: String, detail: [String: Any], completion: ((Bool) -> Void)? = nil) {
        if let completion { deliveries += 1; callbacks.append(completion) }
    }
    func commit() { webReady = false; documentID = UUID() }
    func complete(_ success: Bool) { callbacks.removeFirst()(success) }
}
var failures = 0
func check(_ condition: Bool, _ name: String) {
    print("\\(condition ? "PASS" : "FAIL"): \\(name)")
    if !condition { failures += 1 }
}
let url = URL(string: "https://assistant.example.com/?conversation=11111111-1111-4111-8111-111111111111")!
let stale = Harness()
stale.ready(); stale.enqueueResult(url); stale.commit(); stale.ready()
check(stale.deliveries == 1, "new ready waits for old in-flight callback")
stale.complete(false)
check(stale.deliveries == 2, "stale failed completion retries in ready new document")
if !stale.callbacks.isEmpty { stale.complete(true) }
check(stale.results.isEmpty, "new document receives queued result exactly once")
let waiting = Harness()
waiting.ready(); waiting.enqueueResult(url); waiting.commit(); waiting.complete(false)
check(waiting.deliveries == 1, "stale completion waits until new document is ready")
waiting.ready(); waiting.complete(true)
check(waiting.results.isEmpty, "later ready drains preserved result")
let failed = Harness()
failed.ready(); failed.enqueueResult(url); failed.complete(false)
check(failed.deliveries == 1 && failed.callbacks.isEmpty && failed.results.count == 1,
      "same-document script failure is retained without a retry loop")
let ordered = Harness()
ordered.ready(); ordered.enqueueResult(url); ordered.enqueueResult(url)
ordered.complete(true); ordered.complete(true)
check(ordered.results.isEmpty && ordered.deliveries == 2, "normal queue drains sequentially")
let invalid = Harness()
invalid.enqueueResult(URL(string: "https://other.example/?conversation=11111111-1111-4111-8111-111111111111")!)
check(invalid.results.isEmpty && invalid.resultRevision == 0, "foreign results cannot navigate native shell")
check(ordered.pendingResultConversation == "11111111-1111-4111-8111-111111111111" && ordered.resultRevision == 0,
      "notification navigation waits for the body to confirm its destination")
exit(failures == 0 ? 0 : 1)
`);
const compile = Bun.spawn(['swiftc', `${directory}/main.swift`, 'apps/apple/Sources/AppConfiguration.swift', '-o', `${directory}/result-lifecycle`], { stdout: 'inherit', stderr: 'inherit' });
if (await compile.exited !== 0) process.exit(1);
const run = Bun.spawn([`${directory}/result-lifecycle`], { stdout: 'inherit', stderr: 'inherit' });
process.exit(await run.exited);
