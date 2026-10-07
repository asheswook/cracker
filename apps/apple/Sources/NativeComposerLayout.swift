import Foundation
import CoreGraphics

enum NativeComposerLayout {
    static let padding: CGFloat = 8
    static let cornerRadius: CGFloat = 28
    static let editorMinimum: CGFloat = 35
    static let editorMaximum: CGFloat = 180
    static let controlSize: CGFloat = 36
    static let hitSize: CGFloat = 44
    static let textTopInset: CGFloat = 5
    static let textBottomInset: CGFloat = 8
    static let lineHeight: CGFloat = 22

    static func editorHeight(measured: CGFloat, compact: Bool) -> CGFloat {
        min(editorMaximum, max(compact ? controlSize : editorMinimum, measured))
    }

    static func hitBounds(_ bounds: CGRect) -> CGRect {
        let horizontal: CGFloat = max(0, (hitSize - bounds.width) / 2)
        let vertical: CGFloat = max(0, (hitSize - bounds.height) / 2)
        return bounds.insetBy(dx: -horizontal, dy: -vertical)
    }

    static func compact(width: Double, height: Double, safeWidth: Double) -> Bool {
        width.isFinite && height.isFinite && safeWidth.isFinite && height > 0 &&
            width > height && height <= 500 && safeWidth >= 360
    }
}
