import AppIntents

/// Shared by the app and the Controls extension so the system can launch the app from a control.
#if os(iOS)
@available(iOS 18.0, *)
struct OpenAssistantIntent: AppIntent {
    static let title: LocalizedStringResource = "어시스턴트 열기"
    static let description = IntentDescription("어시스턴트와의 대화를 바로 열어요.")
    static let openAppWhenRun = true
    static let isDiscoverable = true

    @MainActor
    func perform() async throws -> some IntentResult { .result() }
}
#endif
