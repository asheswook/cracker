import Foundation

@MainActor
enum HybridLatestTrace {
    static var enabled: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--qa-hybrid-latest-trace")
        #else
        false
        #endif
    }
    private static let run = UUID().uuidString
    private static var rows: [[String: Any]] = []
    private static var dropped = 0
    private static var flush: DispatchWorkItem?
    static func record(_ phase: Int, _ values: [Double] = []) {
        guard enabled else { return }
        if rows.count < 256 {
            rows.append(["epoch": Date().timeIntervalSince1970 * 1000, "phase": phase, "values": values])
        } else { dropped += 1 }
        flush?.cancel()
        let work = DispatchWorkItem {
            guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
            let file = directory.appendingPathComponent("hybrid-latest-\(run).json")
            do {
                let data = try JSONSerialization.data(withJSONObject: ["version": 1, "run": run, "finalized": true,
                    "endEpoch": Date().timeIntervalSince1970 * 1000, "dropped": dropped, "rows": rows], options: [.sortedKeys])
                try data.write(to: file, options: .atomic)
                NSLog("HYBRID_LATEST_FINAL run=%@ count=%d dropped=%d", run, rows.count, dropped)
            } catch { NSLog("HYBRID_LATEST_FLUSH_FAILED") }
        }
        flush = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }
}
