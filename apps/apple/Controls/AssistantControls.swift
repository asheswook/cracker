import AppIntents
import SwiftUI
import WidgetKit

@main
struct AssistantControlsBundle: WidgetBundle {
    var body: some Widget {
        OpenAssistantControl()
    }
}

struct OpenAssistantControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "dev.assistant.controls.open") {
            ControlWidgetButton(action: OpenAssistantIntent()) {
                Label("어시스턴트", systemImage: "bubble.left.and.text.bubble.right.fill")
            }
        }
        .displayName("어시스턴트 열기")
        .description("어시스턴트와의 대화를 바로 열어요.")
    }
}
