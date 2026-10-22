import Foundation
import Security

enum CredentialStore {
    private static let service = "\(Bundle.main.bundleIdentifier ?? "assistant").access-token"
    private static let account = "default"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func save(_ token: String) -> Bool {
        guard let data = token.data(using: .utf8) else { return false }
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        return SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil) == errSecSuccess
    }

    static func load() -> String? {
        var result: AnyObject?
        let lookup = query.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { $1 }
        guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func clear() { SecItemDelete(query as CFDictionary) }
}
