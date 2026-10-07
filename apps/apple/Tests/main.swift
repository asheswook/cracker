import Foundation

let conversation = "11111111-1111-4111-8111-111111111111"
let message = "22222222-2222-4222-8222-222222222222"
let relative = "/?conversation=\(conversation)&message=\(message)"
let cases: [(String, String, Bool)] = [
    ("actual FCM relative URL", relative, true),
    ("absolute application result", AppConfiguration.origin.absoluteString + "?conversation=\(conversation)", true),
    ("external origin", "https://evil.example\(relative)", false),
    ("protocol-relative external", "//evil.example\(relative)", false),
    ("incorrect path", "/v1/notifications?conversation=\(conversation)", false),
    ("duplicate conversation", relative + "&conversation=\(conversation)", false),
    ("duplicate message", relative + "&message=\(message)", false),
    ("missing conversation", "/?message=\(message)", false),
    ("invalid UUID", "/?conversation=bad", false),
    ("unexpected token query", relative + "&token=secret", false),
    ("javascript URL", "javascript:alert(1)", false),
    ("embedded username", "https://user@assistant.example.com\(relative)", false),
    ("wrong port", "https://assistant.example.com:444\(relative)", false),
    ("HTTP downgrade", "http://assistant.example.com\(relative)", false)
]
for (name, input, expected) in cases {
    let result = AppConfiguration.resultURL(input)
    guard (result != nil) == expected else { fatalError("FAIL: \(name)") }
    if let result { precondition(result.host == AppConfiguration.origin.host && result.scheme == "https") }
    print("PASS: \(name)")
}
print("PASS: \(cases.count) result URL boundary scenarios")
