import Foundation
import CoreGraphics

func check(_ name: String, _ condition: Bool) {
    precondition(condition, name)
    print("PASS: \(name)")
}

check("portrait empty text retains the text row", NativeComposerLayout.editorHeight(measured: 0, compact: false) == 35)
let measurements: [CGFloat] = [35, 57, 123, 210, 57, 35]
check("multiline grows caps and shrinks back to the reference", measurements.map { NativeComposerLayout.editorHeight(measured: $0, compact: false) } == [35, 57, 123, 180, 57, 35])
check("larger text expands rather than clipping at the minimum", NativeComposerLayout.editorHeight(measured: 65, compact: false) == 65)

let visual = CGRect(x: 0, y: 0, width: NativeComposerLayout.controlSize, height: NativeComposerLayout.controlSize)
let hit = NativeComposerLayout.hitBounds(visual)
check("36pt visual button receives a centered 44pt activation region", hit == CGRect(x: -4, y: -4, width: 44, height: 44))
check("activation accepts extension outside the visible button", hit.contains(CGPoint(x: -3, y: 18)) && hit.contains(CGPoint(x: 18, y: 39)))
check("activation rejects points outside its 44pt region", !hit.contains(CGPoint(x: -5, y: 18)) && !hit.contains(CGPoint(x: 18, y: 41)))
check("already large activation regions are never reduced", NativeComposerLayout.hitBounds(CGRect(x: 0, y: 0, width: 60, height: 50)) == CGRect(x: 0, y: 0, width: 60, height: 50))

check("portrait keeps two rows", !NativeComposerLayout.compact(width: 375, height: 812, safeWidth: 375))
check("short landscape retains compact layout", NativeComposerLayout.compact(width: 812, height: 375, safeWidth: 724))
check("narrow landscape keeps portrait fallback", !NativeComposerLayout.compact(width: 500, height: 375, safeWidth: 359))
check("large landscape preserves existing noncompact behavior", !NativeComposerLayout.compact(width: 1024, height: 768, safeWidth: 1024))
check("invalid geometry cannot activate compact layout", !NativeComposerLayout.compact(width: .nan, height: 375, safeWidth: 724))
print("PASS: 12 native composer geometry scenarios")
