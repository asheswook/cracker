import { mkdir } from 'node:fs/promises';

const source = await Bun.file('apps/apple/Sources/WebShell.swift').text();
const start = source.indexOf('    private func failed(');
const end = source.indexOf('    func webView(', start);
if (start < 0 || end < 0) throw new Error('Navigation failure method boundary changed');
const directory = '.omo/evidence/native-download-fix';
await mkdir(directory, { recursive: true });
await Bun.write(`${directory}/main.swift`, `
import Foundation
final class Harness {
    var loading = true
    var failure: String?
    func receive(_ error: NSError) { failed(error) }
${source.slice(start, end)}
}
var failures = 0
let cases: [(String, String, Int, Bool)] = [
    ("actual download policy interruption keeps page visible", "WebKitErrorDomain", 102, false),
    ("same numeric code from another domain remains a failure", "FixtureDomain", 102, true),
    ("other WebKit error remains a failure", "WebKitErrorDomain", 103, true),
    ("offline network error remains a failure", NSURLErrorDomain, NSURLErrorNotConnectedToInternet, true),
    ("lost network connection remains a failure", NSURLErrorDomain, NSURLErrorNetworkConnectionLost, true),
    ("cancelled navigation remains ignored", NSURLErrorDomain, NSURLErrorCancelled, false)
]
for (name, domain, code, expectedFailure) in cases {
    let shell = Harness()
    shell.receive(NSError(domain: domain, code: code))
    let passed = (shell.failure != nil) == expectedFailure
    print("\\(passed ? "PASS" : "FAIL"): \\(name)")
    if !passed { failures += 1 }
    if domain == "WebKitErrorDomain" && code == 102 {
        print("\\(!shell.loading ? "PASS" : "FAIL"): policy interruption ends loading")
        if shell.loading { failures += 1 }
    }
}
exit(failures == 0 ? 0 : 1)
`);
const compile = Bun.spawn(['swiftc', `${directory}/main.swift`, '-o', `${directory}/navigation-failure`], { stdout: 'inherit', stderr: 'inherit' });
if (await compile.exited !== 0) process.exit(1);
const run = Bun.spawn([`${directory}/navigation-failure`], { stdout: 'inherit', stderr: 'inherit' });
process.exit(await run.exited);
