import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = await readFile(new URL('../apps/apple/Sources/NotificationService.swift', import.meta.url), 'utf8');
const attention = source.slice(source.indexOf('    private var viewedConversation:'), source.indexOf('    static var isAppVisibleAndActive:')).replace('UNNotification)', 'FakeNotification)');
const property = source.slice(source.indexOf('    static var isAppVisibleAndActive:'), source.indexOf('    let installationID:'));
const signature = source.indexOf('        willPresent notification:');
const bodyStart = source.indexOf('\n', signature) + 1;
const body = source.slice(bodyStart, source.indexOf('\n    }\n}', bodyStart));

for (const platform of ['macOS', 'iOS'] as const) {
  test(`production ${platform} presentation suppresses only a fresh matching conversation in an active app`, async () => {
    expect(property).toContain('static var isAppVisibleAndActive');
    expect(body).toContain('completionHandler');
    const prelude = platform === 'macOS' ? `
struct Visibility: OptionSet { let rawValue: Int; static let visible = Visibility(rawValue: 1) }
final class Window { var isVisible = true; var isMiniaturized = false; var occlusionState: Visibility = .visible }
final class Application { var isActive = true; var keyWindow: Window? = Window() }
let NSApp = Application()
` : `
enum AppState { case active, background }
enum SceneState { case foregroundActive, foregroundInactive, background }
class UIScene { var activationState: SceneState = .foregroundActive }
final class UIWindow { var isKeyWindow = true; var isHidden = false; var alpha = 1.0 }
final class UIWindowScene: UIScene { var windows = [UIWindow()] }
final class UIApplication { static let shared = UIApplication(); var applicationState: AppState = .active; var connectedScenes: [UIScene] = [UIWindowScene()] }
`;
    const cases = platform === 'macOS' ? `
await check(true, "active visible window including app panels");
NSApp.isActive = false; await check(false, "other app active"); NSApp.isActive = true
NSApp.keyWindow?.isMiniaturized = true; await check(false, "minimized"); NSApp.keyWindow?.isMiniaturized = false
NSApp.keyWindow?.isVisible = false; await check(false, "hidden window"); NSApp.keyWindow?.isVisible = true
NSApp.keyWindow?.occlusionState = []; await check(false, "occluded window"); NSApp.keyWindow?.occlusionState = .visible
NSApp.keyWindow = nil; await check(false, "no key window")
` : `
await check(true, "foreground active visible scene including app sheets");
UIApplication.shared.applicationState = .background; await check(false, "background app"); UIApplication.shared.applicationState = .active
let scene = UIApplication.shared.connectedScenes[0] as! UIWindowScene
scene.activationState = .foregroundInactive; await check(false, "inactive scene"); scene.activationState = .foregroundActive
scene.windows[0].isKeyWindow = false; await check(false, "no key window"); scene.windows[0].isKeyWindow = true
scene.windows[0].isHidden = true; await check(false, "hidden window"); scene.windows[0].isHidden = false
scene.windows[0].alpha = 0; await check(false, "invisible window"); scene.windows[0].alpha = 1
UIApplication.shared.connectedScenes = [UIScene()]; await check(false, "no window scene")
`;
    const selected = property.replace('#if os(iOS)', platform === 'iOS' ? '#if true' : '#if false');
    const swift = `import Foundation
import UserNotifications
struct FakeContent { var userInfo: [AnyHashable: Any] }
struct FakeRequest { var content: FakeContent }
struct FakeNotification { var request: FakeRequest }
enum AppConfiguration { static func resultURL(_ value: String) -> URL? { URL(string: value, relativeTo: URL(string: "https://fixture.invalid")!) } }
${prelude}
@MainActor final class NotificationService {
static let foregroundNotification = Notification.Name("AssistantForegroundNotification")
${attention}
${selected}
func present(notification: FakeNotification, completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
${body}
}
}
@main struct Main {
@MainActor static func main() async {
let service = NotificationService()
let conversation = UUID().uuidString, otherConversation = UUID().uuidString
var notification = FakeNotification(request: FakeRequest(content: FakeContent(userInfo: ["url": "/?conversation=" + conversation])))
var receipts = 0
let observer = NotificationCenter.default.addObserver(forName: NotificationService.foregroundNotification, object: nil, queue: nil) { _ in receipts += 1 }
var checks = 0
func check(_ suppressed: Bool, _ name: String) async {
let options = await withCheckedContinuation { continuation in service.present(notification: notification) { continuation.resume(returning: $0) } }
precondition(options == (suppressed ? [] : [.banner, .sound, .list]), name)
checks += 1; precondition(receipts == checks, "receipt lost or duplicated")
print("PASS ${platform}: \\(name); suppressed=\\(suppressed); receipts=\\(receipts)")
}
await check(false, "no attention heartbeat fails open")
_ = service.attention(conversation: conversation)
notification.request.content.userInfo["url"] = "/?conversation=" + otherConversation
await check(false, "another conversation alert remains visible")
notification.request.content.userInfo["url"] = "/?conversation=" + conversation
await check(true, "fresh matching conversation is suppressed")
_ = service.attention(conversation: nil)
await check(false, "explicit attention release fails open")
_ = service.attention(conversation: otherConversation)
await check(false, "switching conversation preserves old conversation alert")
_ = service.attention(conversation: conversation)
try? await Task.sleep(nanoseconds: 3_050_000_000)
await check(false, "stalled heartbeat expires")
_ = service.attention(conversation: conversation)
${cases}
NotificationCenter.default.removeObserver(observer)
}
}`;
    const dir = await mkdtemp(join(tmpdir(), 'assistant-notification-policy-'));
    try {
      const file = join(dir, 'main.swift'); await writeFile(file, swift);
      const compile = Bun.spawn(['swiftc', '-parse-as-library', '-swift-version', '5', file, '-o', join(dir, 'check')], { stdout: 'pipe', stderr: 'pipe' });
      const diagnostics = await new Response(compile.stderr).text();
      expect(await compile.exited, diagnostics).toBe(0);
      const run = Bun.spawn([join(dir, 'check')], { stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(run.stdout).text();
      console.log(output.trim());
      expect(await run.exited, await new Response(run.stderr).text()).toBe(0);
      expect(output.match(/PASS/g)?.length).toBe(platform === 'macOS' ? 12 : 13);
    } finally { await rm(dir, { recursive: true }); }
  }, 30000);
}
