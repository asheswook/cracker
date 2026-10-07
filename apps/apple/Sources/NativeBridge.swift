import WebKit

@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var shell: WebShell?
    init(shell: WebShell) { self.shell = shell }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard let shell, message.webView === shell.webView, message.frameInfo.isMainFrame,
              origin.protocol == AppConfiguration.origin.scheme,
              origin.host == AppConfiguration.origin.host,
              AppConfiguration.matchesOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
              let currentURL = shell.webView.url, AppConfiguration.isAppURL(currentURL),
              let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "Native bridge is available only to the application main frame."); return
        }
        let notifications = NotificationService.shared
        switch method {
        case "modelLoginCapabilities":
            #if os(macOS)
            replyHandler(["version": 1, "platform": "macos", "local": true], nil)
            #else
            replyHandler(["version": 1, "platform": "ios", "local": false], nil)
            #endif
        #if os(macOS)
        case "modelLoginPrepare": shell.modelLogin.prepare(reply: replyHandler)
        case "modelLoginAuthorize":
            guard let id = body["session_id"] as? String, let url = body["authorization_url"] as? String else { replyHandler(nil, "Invalid local login request."); return }
            shell.modelLogin.authorize(id: id, value: url, reply: replyHandler)
        case "modelLoginCancel":
            guard let id = body["session_id"] as? String else { replyHandler(nil, "Invalid local login request."); return }
            shell.modelLogin.cancel(id: id); replyHandler(NSNull(), nil)
        #endif
        case "getNotificationAttention":
            guard shell.webView.window?.isKeyWindow == true else { replyHandler(false, nil); return }
            replyHandler(notifications.attention(conversation: body["conversation_id"] as? String), nil)
        case "getNotificationState": notifications.refresh { replyHandler(notifications.state, nil) }
        case "requestNotifications":
            notifications.request { result in
                switch result {
                case .success(let state): replyHandler(state, nil)
                case .failure(let error): replyHandler(["version": 1, "error": ["code": error.rawValue]], nil)
                }
            }
        case "openNotificationSettings": notifications.openSettings(); replyHandler(NSNull(), nil)
        case "ready": shell.ready(); replyHandler(NSNull(), nil)
        #if os(iOS)
        case "panelTransition": shell.panelTransition.receive(body, reply: replyHandler)
        case "hybridConnect":
            guard body["version"] as? Int == 1, let document = body["document"] as? String,
                  shell.connectHybrid(document: document) else { replyHandler(nil, "Invalid hybrid document."); return }
            replyHandler(["version": 1, "platform": "ios", "document": document,
                          "composer": 1, "reader": 1, "header": 1, "footer": 1], nil)
        case "composerConnect":
            guard body["version"] as? Int == 1, let document = body["document"] as? String,
                  shell.connectComposer(document: document) else { replyHandler(nil, "Invalid composer document."); return }
            replyHandler(["version": 1, "platform": "ios", "document": document], nil)
        case "composerState":
            guard let value = body["state"], let state = NativeComposerState.parse(value),
                  shell.receiveComposer(state) else { replyHandler(nil, "Invalid composer state."); return }
            replyHandler(NSNull(), nil)
        case "composerHide":
            guard let document = body["document"] as? String, let session = body["session"] as? String else {
                replyHandler(nil, "Invalid composer session."); return
            }
            shell.hideComposer(document: document, session: session)
            replyHandler(NSNull(), nil)
        #endif
        default: replyHandler(nil, "Unknown native bridge method.")
        }
    }
}
