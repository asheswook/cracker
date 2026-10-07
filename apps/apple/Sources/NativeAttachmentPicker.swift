#if os(iOS)
import UIKit
import WebKit
import PhotosUI
import UniformTypeIdentifiers

@MainActor
final class NativeAttachmentPicker: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIAdaptivePresentationControllerDelegate {
    static var enabled: Bool { true }
    private weak var host: UIViewController?
    private weak var presented: UIViewController?
    private var completion: (([URL]?) -> Void)?
    private var request: UUID?
    private var directories: [URL] = []
    private var selected: [Int: URL] = [:]
    private var expected = 0
    private var failed = false

    deinit {
        completion?(nil)
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
    }

    @available(iOS 18.4, *)
    func begin(parameters: WKOpenPanelParameters, host: UIViewController, anchor: UIView, completion: @escaping ([URL]?) -> Void) {
        guard self.completion == nil, host.presentedViewController == nil, anchor.window != nil else { completion(nil); return }
        self.host = host; self.completion = completion; request = UUID()
        selected = [:]; expected = 0; failed = false
        let chooser = UIAlertController(title: "파일 첨부", message: nil, preferredStyle: .actionSheet)
        chooser.addAction(UIAlertAction(title: "사진 보관함", style: .default) { [weak self, weak chooser] _ in
            guard let chooser else { return }
            var configuration = PHPickerConfiguration()
            configuration.selectionLimit = parameters.allowsMultipleSelection ? 0 : 1
            configuration.filter = .any(of: [.images, .videos])
            let picker = PHPickerViewController(configuration: configuration)
            picker.delegate = self
            self?.replace(chooser, with: picker)
        })
        let camera = UIAlertAction(title: "사진 또는 동영상 촬영", style: .default) { [weak self, weak chooser] _ in
            guard let chooser else { return }
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            picker.mediaTypes = UIImagePickerController.availableMediaTypes(for: .camera) ?? [UTType.image.identifier]
            picker.delegate = self
            self?.replace(chooser, with: picker)
        }
        camera.isEnabled = UIImagePickerController.isSourceTypeAvailable(.camera)
        chooser.addAction(camera)
        chooser.addAction(UIAlertAction(title: "파일 선택", style: .default) { [weak self, weak chooser] _ in
            guard let chooser else { return }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: parameters.allowsDirectories ? [.item, .folder] : [.item], asCopy: true)
            picker.allowsMultipleSelection = parameters.allowsMultipleSelection
            picker.delegate = self
            self?.replace(chooser, with: picker)
        })
        chooser.addAction(UIAlertAction(title: "취소", style: .cancel) { [weak self] _ in self?.finish(nil) })
        chooser.popoverPresentationController?.sourceView = anchor
        chooser.popoverPresentationController?.sourceRect = anchor.bounds
        chooser.popoverPresentationController?.permittedArrowDirections = [.up, .down]
        presented = chooser
        host.present(chooser, animated: true)
        chooser.presentationController?.delegate = self
    }

    private func replace(_ old: UIViewController, with next: UIViewController) {
        let identity = request
        old.dismiss(animated: true) { [weak self] in
            guard let self, let identity, self.request == identity, let host = self.host, host.view.window != nil else { return }
            self.presented = next
            host.present(next, animated: true)
            next.presentationController?.delegate = self
        }
    }
    func cancel() { finish(nil) }
    private func finish(_ urls: [URL]?) {
        guard let callback = completion else { return }
        completion = nil; request = nil; selected = [:]
        let controller = presented; presented = nil
        if controller?.presentingViewController != nil { controller?.dismiss(animated: true) }
        callback(urls)
    }
    private func failSelection() {
        guard completion != nil else { return }
        let owner = host, controller = presented
        completion?(nil); completion = nil; request = nil; selected = [:]; presented = nil
        controller?.dismiss(animated: true) {
            guard let owner, owner.view.window != nil, owner.presentedViewController == nil else { return }
            let alert = UIAlertController(title: "파일을 선택하지 못했어요.", message: "다시 선택해 주세요.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "확인", style: .default))
            owner.present(alert, animated: true)
        }
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        if presentationController.presentedViewController === presented { finish(nil) }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if controller === presented { finish(nil) }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === presented else { return }
        finish(urls)
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("assistant-attachment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directories.append(url)
        return url
    }
    nonisolated private static func copy(_ source: URL, to directory: URL) throws -> URL {
        let destination = directory.appendingPathComponent(source.lastPathComponent)
        try FileManager.default.copyItem(at: source, to: destination)
        return destination
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard picker === presented, let identity = request else { return }
        guard !results.isEmpty else { finish(nil); return }
        expected = results.count
        for (index, result) in results.enumerated() {
            let provider = result.itemProvider
            let type = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? UTType.movie.identifier : UTType.image.identifier
            do {
                let destination = try directory()
                provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] url, _ in
                    let copied: URL?
                    if let url { copied = try? Self.copy(url, to: destination) } else { copied = nil }
                    Task { @MainActor [weak self] in self?.received(copied, index: index, identity: identity) }
                }
            } catch { received(nil, index: index, identity: identity) }
        }
    }
    private func received(_ url: URL?, index: Int, identity: UUID) {
        guard request == identity else { return }
        if let url { selected[index] = url } else { failed = true }
        expected -= 1
        if expected == 0 {
            if failed { failSelection() }
            else { finish(selected.sorted { $0.key < $1.key }.map(\.value)) }
        }
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        if picker === presented { finish(nil) }
    }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        guard picker === presented else { return }
        do {
            let destination = try directory()
            if let url = info[.mediaURL] as? URL ?? info[.imageURL] as? URL {
                finish([try Self.copy(url, to: destination)])
            } else if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.95) {
                let url = destination.appendingPathComponent("photo.jpg")
                try data.write(to: url, options: .atomic)
                finish([url])
            } else { failSelection() }
        } catch { failSelection() }
    }
}
#endif
