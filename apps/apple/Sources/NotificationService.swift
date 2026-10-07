import Foundation
import Combine
import UserNotifications
import FirebaseCore
import FirebaseMessaging
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@MainActor
final class NotificationService: NSObject, ObservableObject {
    static let shared = NotificationService()
    @Published private(set) var permission = "default"
    private(set) var configured = false
    private(set) var token: String?
    var onStateChange: (() -> Void)?
    var onResult: ((URL) -> Void)?
    private var pendingResults: [URL] = []
    private var apnsReady = false
    private var requests: [(Result<[String: Any], NotificationError>) -> Void] = []
    private var timeout: Task<Void, Never>?
    static let foregroundNotification = Notification.Name("AssistantForegroundNotification")
    private var viewedConversation: UUID?
    private var viewingExpiresAt: TimeInterval = 0

    func attention(conversation: String?) -> Bool {
        let id = conversation.flatMap(UUID.init(uuidString:))
        let active = id != nil && Self.isAppVisibleAndActive
        viewedConversation = active ? id : nil
        viewingExpiresAt = active ? ProcessInfo.processInfo.systemUptime + 3 : 0
        return active
    }

    private func isViewing(_ notification: UNNotification) -> Bool {
        guard Self.isAppVisibleAndActive, ProcessInfo.processInfo.systemUptime < viewingExpiresAt,
              let value = notification.request.content.userInfo["url"] as? String,
              let url = AppConfiguration.resultURL(value),
              let conversation = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "conversation" })?.value,
              let id = UUID(uuidString: conversation) else { return false }
        return viewedConversation == id
    }

    static var isAppVisibleAndActive: Bool {
        #if os(iOS)
        guard UIApplication.shared.applicationState == .active else { return false }
        return UIApplication.shared.connectedScenes.contains { scene in
            guard let scene = scene as? UIWindowScene, scene.activationState == .foregroundActive else { return false }
            return scene.windows.contains { $0.isKeyWindow && !$0.isHidden && $0.alpha > 0 }
        }
        #else
        guard NSApp.isActive, let window = NSApp.keyWindow else { return false }
        return window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
        #endif
    }
    let installationID: String = {
        let key = "assistant.installationID"
        if let saved = UserDefaults.standard.string(forKey: key), UUID(uuidString: saved) != nil { return saved }
        let value = UUID().uuidString.lowercased()
        UserDefaults.standard.set(value, forKey: key)
        return value
    }()

    func configure() {
        UNUserNotificationCenter.current().delegate = self
        if let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
           let options = FirebaseOptions(contentsOfFile: path),
           options.bundleID == Bundle.main.bundleIdentifier,
           options.googleAppID.range(of: #"^1:[0-9]+:ios:[a-fA-F0-9]+$"#, options: .regularExpression) != nil,
           !options.gcmSenderID.isEmpty, let apiKey = options.apiKey, apiKey.hasPrefix("AIza"), apiKey.count == 39,
           let projectID = options.projectID, !projectID.isEmpty {
            FirebaseApp.configure(options: options)
            Messaging.messaging().delegate = self
            configured = true
        }
        refresh(registerIfGranted: true)
        #if DEBUG
        if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--notification-result"),
           ProcessInfo.processInfo.arguments.indices.contains(index + 1) {
            receiveResult(ProcessInfo.processInfo.arguments[index + 1])
        }
        #endif
    }

    var state: [String: Any] {
        #if os(iOS)
        let platform = "ios"
        #else
        let platform = "macos"
        #endif
        return ["version": 1, "platform": platform, "installation_id": installationID,
                "configured": configured, "permission": permission, "token": token as Any? ?? NSNull()]
    }

    func refresh(registerIfGranted: Bool = false, completion: (() -> Void)? = nil) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            Task { @MainActor in
                let previousPermission = self.permission
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral: self.permission = "granted"
                case .denied: self.permission = "denied"
                default: self.permission = "default"
                }
                if self.permission != previousPermission { self.onStateChange?() }
                if registerIfGranted && self.permission == "granted" && self.configured { self.register() }
                completion?()
            }
        }
    }

    func request(_ completion: @escaping (Result<[String: Any], NotificationError>) -> Void) {
        guard configured else { completion(.failure(NotificationError.unconfigured)); return }
        requests.append(completion)
        guard requests.count == 1 else { return }
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(45))
            guard !Task.isCancelled else { return }
            self?.finish(.failure(NotificationError.timedOut))
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            Task { @MainActor in
                if error != nil { self.finish(.failure(NotificationError.permissionFailed)); return }
                self.refresh {
                    guard granted else { self.finish(.success(self.state)); return }
                    self.register()
                }
            }
        }
    }

    private func register() {
        guard configured else { return }
        Messaging.messaging().isAutoInitEnabled = true
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #else
        NSApplication.shared.registerForRemoteNotifications()
        #endif
        if apnsReady { fetchToken() }
    }

    func registered(deviceToken: Data) {
        guard configured else { return }
        Messaging.messaging().apnsToken = deviceToken
        apnsReady = true
        fetchToken()
    }

    func registrationFailed() { finish(.failure(NotificationError.registrationFailed)) }

    private func fetchToken() {
        Messaging.messaging().token { token, error in
            Task { @MainActor in
                guard error == nil, let token, !token.isEmpty else {
                    self.finish(.failure(NotificationError.tokenFailed)); return
                }
                let changed = self.token != token
                self.token = token
                if changed { self.onStateChange?() }
                self.finish(.success(self.state))
            }
        }
    }

    private func finish(_ result: Result<[String: Any], NotificationError>) {
        timeout?.cancel()
        timeout = nil
        let callbacks = requests
        requests.removeAll()
        callbacks.forEach { $0(result) }
    }

    func receiveResult(_ value: String) {
        guard let url = AppConfiguration.resultURL(value) else { return }
        if let onResult { onResult(url) } else { pendingResults.append(url) }
    }

    func connectResults(_ handler: @escaping (URL) -> Void) {
        onResult = handler
        let pending = pendingResults
        pendingResults.removeAll()
        pending.forEach(handler)
    }

    func openSettings() {
        #if os(iOS)
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
        #else
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
        #endif
    }
}

extension NotificationService: MessagingDelegate, UNUserNotificationCenterDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        Task { @MainActor in
            let changed = self.token != fcmToken
            self.token = fcmToken
            if changed { self.onStateChange?() }
            if let fcmToken, !fcmToken.isEmpty, self.apnsReady { self.finish(.success(self.state)) }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let value = response.notification.request.content.userInfo["url"] as? String
        Task { @MainActor in
            if let value { self.receiveResult(value) }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            NotificationCenter.default.post(name: Self.foregroundNotification, object: nil)
            completionHandler(self.isViewing(notification) ? [] : [.banner, .sound, .list])
        }
    }
}

enum NotificationError: String, LocalizedError {
    case unconfigured
    case timedOut = "timed_out"
    case permissionFailed = "permission_failed"
    case registrationFailed = "registration_failed"
    case tokenFailed = "token_failed"
    var errorDescription: String? {
        switch self {
        case .unconfigured: return "이 앱에 Firebase 알림 설정이 없습니다. 앱 관리자에게 설정된 빌드를 요청하세요."
        case .timedOut: return "알림 등록 시간이 초과되었습니다. 인터넷 연결과 알림 권한을 확인한 뒤 다시 시도하세요."
        case .permissionFailed: return "알림 권한을 확인하지 못했습니다. 시스템 설정을 확인한 뒤 다시 시도하세요."
        case .registrationFailed: return "Apple 푸시 알림 등록에 실패했습니다. 서명과 APNs 설정을 확인해야 합니다."
        case .tokenFailed: return "알림 토큰을 받지 못했습니다. 네트워크와 Firebase APNs 설정을 확인한 뒤 다시 시도하세요."
        }
    }
}
