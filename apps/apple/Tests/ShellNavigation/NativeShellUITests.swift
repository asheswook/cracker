import XCTest

/// Run against an installed QA build with a read-only API proxy. Never sends.
final class NativeShellUITests: XCTestCase {
    func testNativeNavigationAndPanels() throws {
        let app = XCUIApplication(bundleIdentifier: "com.example.assistant.ios")
        app.launch()
        let tools = app.buttons["shell-tools"].firstMatch
        XCTAssertTrue(tools.waitForExistence(timeout: 30))
        let conversation = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'conversation-'")).firstMatch
        XCTAssertTrue(conversation.waitForExistence(timeout: 30))
        capture("ios-conversations")
        conversation.tap()
        XCTAssertTrue(app.webViews.buttons["크래커 페르소나 설정"].firstMatch.waitForExistence(timeout: 20))
        let editor = app.textViews["native-composer-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["상태와 첨부 화면을 연결하지 못해 기본 대화 화면으로 돌아왔어요."].exists)
        sleep(3)
        capture("ios-conversation")
        editor.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        capture("ios-keyboard")
        tools.tap()
        app.buttons["예약"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["예약"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        sleep(3)
        capture("ios-schedules")
        app.buttons["닫기"].firstMatch.tap()
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)))
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        tools.tap()
        app.buttons["맡긴 일"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["맡긴 일"].waitForExistence(timeout: 10))
        sleep(3)
        capture("ios-tasks")
        let sheetTop = app.navigationBars["맡긴 일"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        sheetTop.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        XCTAssertTrue(app.navigationBars["맡긴 일"].waitForNonExistence(timeout: 5))
        capture("ios-after-sheet-swipe")
    }

    private func capture(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? screenshot.pngRepresentation.write(to: directory.appendingPathComponent(name + ".png"))
    }
}
