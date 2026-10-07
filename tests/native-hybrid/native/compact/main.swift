import Foundation
func check(_ value: Bool, _ name: String) { precondition(value, name); print("PASS " + name) }
check(NativeComposerLayout.compact(width: 874, height: 402, safeWidth: 750), "reproduced short landscape chooses horizontal composer")
check(!NativeComposerLayout.compact(width: 402, height: 840, safeWidth: 402), "portrait restores existing vertical composer")
check(!NativeComposerLayout.compact(width: 1024, height: 768, safeWidth: 1024), "roomy tablet does not acquire short-height mode")
check(!NativeComposerLayout.compact(width: 568, height: 320, safeWidth: 319), "insufficient editor/control width retains original constraints")
check(!NativeComposerLayout.compact(width: .nan, height: 402, safeWidth: 750), "nonfinite bounds rejected")
check(NativeComposerLayout.compact(width: 568, height: 320, safeWidth: 360), "minimum safe width retains120pt editor beside160pt controls and40pt spacing")
