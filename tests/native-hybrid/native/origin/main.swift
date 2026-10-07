import Foundation
func check(_ value: Bool, _ message: String) { precondition(value, message); print("PASS " + message) }
check(AppConfiguration.normalizedPort(nil, scheme: "https") == 443, "HTTPS default port")
check(AppConfiguration.normalizedPort(0, scheme: "http") == 80, "HTTP securityOrigin default port")
check(AppConfiguration.normalizedPort(50050, scheme: "http") == 50050, "explicit development port")
check(AppConfiguration.matchesOrigin(scheme: "https", host: AppConfiguration.origin.host!, port: 0), "HTTPS native securityOrigin zero accepted")
check(!AppConfiguration.matchesOrigin(scheme: "http", host: AppConfiguration.origin.host!, port: 0), "scheme mismatch rejected")
check(!AppConfiguration.matchesOrigin(scheme: "https", host: "untrusted.example", port: 0), "foreign origin rejected")
check(!AppConfiguration.isAppURL(URL(string: "https://user:password@" + AppConfiguration.origin.host! + "/")!), "URL credentials rejected")
