import SwiftUI

struct CrackerLoadingView: View {
    var label: String = "연결 중…"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 14) {
            TimelineView(.animation(paused: reduceMotion)) { context in
                CrackerMark(time: reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate)
                    .frame(width: 64, height: 64)
            }
            Text(label).font(.subheadline).foregroundStyle(.secondary)
        }
        .padding(24)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

private struct CrackerMark: View {
    let time: TimeInterval
    private static let body = Color(red: 0xea / 255, green: 0xae / 255, blue: 0x60 / 255)
    private static let base = Color(red: 0xc0 / 255, green: 0x81 / 255, blue: 0x39 / 255)
    private static let ink = Color(red: 0x2a / 255, green: 0x21 / 255, blue: 0x1c / 255)

    var body: some View {
        let bob = sin(time * 2.4) * 1.6
        let glance = sin(time * 1.2) * 2.2
        let blink = time.truncatingRemainder(dividingBy: 4.2) < 0.12 ? 0.12 : 1.0
        Canvas { context, size in
            let unit = size.width / 100
            let shape = Path(roundedRect: CGRect(x: 15 * unit, y: 15 * unit, width: 70 * unit, height: 68 * unit), cornerRadius: 17 * unit)
            context.fill(shape.offsetBy(dx: 0, dy: 3.5 * unit), with: .color(Self.base))
            context.fill(shape, with: .color(Self.body))
            for x in [30.0, 50, 70] {
                context.fill(Path(ellipseIn: CGRect(x: (x - 2.6) * unit, y: 26.4 * unit, width: 5.2 * unit, height: 5.2 * unit)), with: .color(Self.base.opacity(0.55)))
            }
            for x in [35.0, 65] {
                let height = 8 * unit * blink
                context.fill(Path(ellipseIn: CGRect(x: (x - 4 + glance) * unit, y: 54 * unit - height / 2, width: 8 * unit, height: height)), with: .color(Self.ink))
            }
        }
        .offset(y: bob)
    }
}
