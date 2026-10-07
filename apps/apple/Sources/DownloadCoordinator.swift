import WebKit
#if os(macOS)
import AppKit
#endif

@MainActor
final class DownloadCoordinator: NSObject, WKDownloadDelegate {
    var onFinished: ((URL) -> Void)?
    var onFailure: (() -> Void)?
    private var destinations: [ObjectIdentifier: URL] = [:]
    private var saveTargets: [ObjectIdentifier: URL] = [:]

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let filename = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        #if os(macOS)
        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename.isEmpty ? "download" : filename
        panel.canCreateDirectories = true
        panel.begin { [weak self] result in
            guard result == .OK, let url = panel.url else { completionHandler(nil); return }
            guard let self else { completionHandler(nil); return }
            do {
                let staged = try self.temporaryDestination(filename: filename)
                self.destinations[ObjectIdentifier(download)] = staged
                self.saveTargets[ObjectIdentifier(download)] = url
                completionHandler(staged)
            } catch { completionHandler(nil); self.onFailure?() }
        }
        #else
        do {
            let url = try temporaryDestination(filename: filename)
            destinations[ObjectIdentifier(download)] = url
            completionHandler(url)
        } catch { completionHandler(nil); onFailure?() }
        #endif
    }
    private func temporaryDestination(filename: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("AssistantDownloads/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(filename.isEmpty ? "download" : filename)
    }
    func downloadDidFinish(_ download: WKDownload) {
        let identifier = ObjectIdentifier(download)
        guard let url = destinations.removeValue(forKey: identifier) else { return }
        if let target = saveTargets.removeValue(forKey: identifier) {
            do {
                if FileManager.default.fileExists(atPath: target.path) {
                    _ = try FileManager.default.replaceItemAt(target, withItemAt: url)
                } else { try FileManager.default.moveItem(at: url, to: target) }
                onFinished?(target)
            } catch { onFailure?() }
        } else { onFinished?(url) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        destinations.removeValue(forKey: ObjectIdentifier(download))
        saveTargets.removeValue(forKey: ObjectIdentifier(download))
        if (error as NSError).code != NSURLErrorCancelled { onFailure?() }
    }
}
