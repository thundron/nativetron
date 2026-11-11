import CoreFoundation
import Foundation
import Photos
import UniformTypeIdentifiers
import WebKit

#if os(iOS)
  import UIKit
  import PhotosUI
  typealias HostPresenter = UIViewController
#else
  import AppKit
  typealias HostPresenter = NSViewController
#endif

final class HostServices: NSObject, WKScriptMessageHandler {
  private weak var web: WKWebView?
  private weak var presenter: HostPresenter?
  private let scheme: String, host: String
  private var disposed = false, epoch = 0
  private var active = Set<String>(), transactions = Set<String>(), leases = Set<String>()
  private var cancelInteraction: (() -> Void)?
  private var pdfJob: HostPDFJob?
  private var shortcuts: [[String: Any]] = []
  private static var incoming: [[String: Any]] = []
  private static var observers: [UUID: (String, Any) -> Void] = [:]
  private let observerID = UUID()
  #if os(macOS)
    private var pageMenu: NSMenuItem?
    private var sharingCoordinator: HostMacShare?
  #endif
  init(web: WKWebView, presenter: HostPresenter, scheme: String, host: String) {
    self.web = web
    self.presenter = presenter
    self.scheme = scheme
    self.host = host
    super.init()
    web.configuration.userContentController.add(self, name: "ntHost")
    Self.observers[observerID] = { [weak self] event, value in self?.event(event, value) }
  }
  static func open(_ url: URL) {
    guard url.isFileURL, incoming.count < 32 else { return }
    let scoped = url.startAccessingSecurityScopedResource()
    DispatchQueue.global(qos: .userInitiated).async {
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      do {
        let file = try ArchiveStore.shared.get().importFile(url)
        DispatchQueue.main.async {
          incoming.append(file)
          for observer in observers.values { observer("open-file", file) }
        }
      } catch {
        DispatchQueue.main.async {
          for observer in observers.values {
            observer("open-file-error", String(describing: error))
          }
        }
      }
    }
  }
  private func emit(_ value: [String: Any]) {
    guard !disposed, let data = try? JSONSerialization.data(withJSONObject: value),
      let text = String(data: data, encoding: .utf8)
    else { return }
    web?.evaluateJavaScript("window.__ntHostReceive?.(\(text))", completionHandler: nil)
  }
  private func event(_ name: String, _ value: Any) {
    emit(["ntHost": 1, "event": name, "value": value])
  }
  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    if CommandLine.arguments.contains("--host-selftest") {
      FileHandle.standardOutput.write(
        Data(
          "NT_HOST_RECEIVE main=\(message.frameInfo.isMainFrame) origin=\(message.frameInfo.securityOrigin.protocol)://\(message.frameInfo.securityOrigin.host)\n"
            .utf8))
    }
    guard !disposed, message.webView === web, message.frameInfo.isMainFrame,
      message.frameInfo.securityOrigin.protocol == scheme,
      message.frameInfo.securityOrigin.host == host,
      let request = message.body as? [String: Any], integer(request["ntHost"]) == 1,
      let id = integer(request["id"]), id > 0, id <= 9_007_199_254_740_991,
      let session = request["session"] as? String, session.count <= 80,
      let method = request["method"] as? String, let args = request["args"] as? [String: Any],
      let encoded = try? JSONSerialization.data(withJSONObject: request),
      encoded.count <= 512 * 1024
    else { return }
    let key = "\(session):\(id)"
    let generation = epoch
    guard active.count < 16, !active.contains(key) else {
      emit([
        "ntHost": 1, "session": session, "id": id, "ok": false,
        "error": ["code": "busy", "message": "host request capacity exceeded"],
      ])
      return
    }
    active.insert(key)
    var completed = false
    let done: (Result<Any, Error>) -> Void = { [weak self] result in
      DispatchQueue.main.async {
        guard let self, !completed else { return }
        completed = true
        guard !self.disposed, generation == self.epoch else { return }
        self.active.remove(key)
        switch result {
        case .success(let value):
          self.emit(["ntHost": 1, "session": session, "id": id, "ok": true, "value": value])
        case .failure(let error):
          let failure = error as? HostServiceError
          self.emit([
            "ntHost": 1, "session": session, "id": id, "ok": false,
            "error": [
              "code": failure?.code ?? "io",
              "message": failure?.message ?? error.localizedDescription,
            ],
          ])
        }
      }
    }
    if CommandLine.arguments.contains("--host-selftest") {
      FileHandle.standardOutput.write(Data("NT_HOST_METHOD \(method)\n".utf8))
    }
    do { try perform(method, args, done) } catch { done(.failure(error)) }
  }
  private func string(_ args: [String: Any], _ name: String) throws -> String {
    guard let value = args[name] as? String else { throw hostError("missing \(name)") }
    return value
  }
  private func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return nil
    }
    let value = number.doubleValue
    guard value.isFinite, value >= 0, value <= 9_007_199_254_740_991, value.rounded() == value
    else { return nil }
    return Int(value)
  }
  private func number(_ args: [String: Any], _ name: String) throws -> Int {
    guard let value = integer(args[name]) else { throw hostError("invalid \(name)") }
    return value
  }
  private func perform(
    _ method: String, _ args: [String: Any], _ done: @escaping (Result<Any, Error>) -> Void
  ) throws {
    if method == "capabilities" {
      #if os(macOS)
        let layout = "continuous"
      #else
        let layout = "paper"
      #endif
      done(
        .success([
          "version": 1, "files": true, "share": true, "gallery": true, "pdf": true,
          "pdfOutput": "file", "pdfLayout": layout, "print": true, "archive": true,
          "shortcuts": true, "maxFileBytes": ArchiveStore.maxFile, "chunkBytes": ArchiveStore.chunk,
        ]))
      return
    }
    if method == "files.incoming" {
      done(.success(Self.incoming))
      return
    }
    if method == "shortcuts.set" {
      try setShortcuts(args)
      done(.success(true))
      return
    }
    let store = try ArchiveStore.shared.get()
    switch method {
    case "archive.begin":
      let id = try store.begin(key: string(args, "key"), size: number(args, "size"))
      transactions.insert(id)
      done(.success(id))
    case "archive.write":
      let id = try string(args, "transaction")
      guard transactions.contains(id), let data = Data(base64Encoded: try string(args, "data")),
        data.count <= ArchiveStore.chunk
      else { throw hostError("invalid archive transaction or bytes") }
      try store.write(id, offset: number(args, "offset"), data: data)
      done(.success(true))
    case "archive.commit":
      let id = try string(args, "transaction")
      guard transactions.contains(id) else { throw hostError("unknown transaction") }
      let result = try store.commit(id)
      transactions.remove(id)
      done(.success(result))
    case "archive.abort":
      let id = try string(args, "transaction")
      if transactions.remove(id) != nil { store.abort(id) }
      done(.success(true))
    case "archive.list": done(.success(try store.list()))
    case "archive.delete":
      try store.remove(string(args, "key"))
      done(.success(true))
    case "archive.stat":
      let file = try store.snapshot(string(args, "key"))
      leases.insert(file["file"] as! String)
      done(.success(file))
    case "files.read":
      let id = try string(args, "file")
      guard owns(id) else { throw hostError("unknown file lease") }
      done(
        .success(
          try store.read(id, offset: number(args, "offset"), length: number(args, "length"))
            .base64EncodedString()))
    case "files.release":
      let id = try string(args, "file")
      guard owns(id) else { throw hostError("unknown file lease") }
      leases.remove(id)
      Self.incoming.removeAll { $0["file"] as? String == id }
      store.release(id)
      done(.success(true))
    case "files.pick": try pick(args, gallery: false, done)
    case "gallery.pick": try pick(args, gallery: true, done)
    case "files.save", "files.share", "gallery.save":
      let id = try string(args, "file")
      guard owns(id) else { throw hostError("unknown file lease") }
      let source = try store.url(id)
      if method == "files.save" {
        try save(source, args, done)
      } else if method == "files.share" {
        try share(source, args, done)
      } else {
        saveGallery(source, args, done)
      }
    case "document.pdf", "document.print":
      guard pdfJob == nil, let web, let presenter else {
        throw hostError("document renderer busy", "busy")
      }
      let job = HostPDFJob(web: web, presenter: presenter, scheme: scheme, host: host)
      pdfJob = job
      try job.run(html: args["html"] as? String, printDocument: method == "document.print") {
        [weak self] result in
        self?.pdfJob = nil
        switch result {
        case .failure(let error): done(.failure(error))
        case .success(let url):
          guard let url else {
            done(.success(["status": "submitted"]))
            return
          }
          defer { try? FileManager.default.removeItem(at: url) }
          do {
            let file = try store.importFile(url, name: (args["name"] as? String) ?? "document.pdf")
            self?.leases.insert(file["file"] as! String)
            done(.success(file))
          } catch { done(.failure(error)) }
        }
      }
    default: throw hostError("unsupported host service: \(method)", "unsupported")
    }
  }
  private func owns(_ id: String) -> Bool {
    leases.contains(id) || Self.incoming.contains { $0["file"] as? String == id }
  }
  private func imported(_ urls: [URL], _ done: @escaping (Result<Any, Error>) -> Void) {
    guard urls.count <= 16 else {
      done(.failure(hostError("too many documents", "quota")))
      return
    }
    var result: [[String: Any]] = []
    do {
      let store = try ArchiveStore.shared.get()
      for url in urls {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let file = try store.importFile(url)
        leases.insert(file["file"] as! String)
        result.append(file)
      }
      done(.success(result))
    } catch {
      for item in result {
        let id = item["file"] as! String
        try? ArchiveStore.shared.get().release(id)
        leases.remove(id)
      }
      done(.failure(error))
    }
  }
  private func namedExport(_ source: URL, _ args: [String: Any]) throws -> (URL, URL) {
    let name = args["name"] as? String ?? "project.bin"
    guard !name.isEmpty, name.count <= 128, !name.contains("/"), !name.contains("\\"),
      !name.unicodeScalars.contains(where: { $0.value < 32 }), name != ".", name != ".."
    else { throw hostError("invalid export name") }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "nt-share-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent(name)
    do { try FileManager.default.copyItem(at: source, to: file) } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
    return (directory, file)
  }
  private func documentTypes(_ args: [String: Any]) -> [UTType] {
    var types = (args["types"] as? [String] ?? []).compactMap { UTType($0) }
    for mime in args["mimeTypes"] as? [String] ?? [] {
      if mime == "image/*" {
        types.append(.image)
      } else if mime == "video/*" {
        types.append(.movie)
      } else if mime == "text/*" {
        types.append(.text)
      } else if mime == "*/*" {
        types.append(.data)
      } else if let type = UTType(mimeType: mime) {
        types.append(type)
      }
    }
    types += (args["extensions"] as? [String] ?? []).compactMap { UTType(filenameExtension: $0) }
    return types.isEmpty ? [.data] : types
  }
  private func beginInteraction() throws {
    guard cancelInteraction == nil, presenter != nil else {
      throw hostError("another host interaction is open", "busy")
    }
  }
  #if os(iOS)
    private var picker: HostDocumentPicker?
    private var photoPicker: HostPhotoPicker?
    private func pick(
      _ args: [String: Any], gallery: Bool, _ done: @escaping (Result<Any, Error>) -> Void
    ) throws {
      let generation = epoch
      try beginInteraction()
      guard let presenter, presenter.viewIfLoaded?.window != nil else {
        throw hostError("host window unavailable", "unavailable")
      }
      if gallery {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.selectionLimit = args["multiple"] as? Bool == true ? 16 : 1
        config.filter = .any(of: [.images, .videos])
        let controller = PHPickerViewController(configuration: config)
        let delegate = HostPhotoPicker { [weak self] result in
          guard self?.epoch == generation, self?.disposed == false else {
            if case .success(let urls) = result {
              for url in urls { try? FileManager.default.removeItem(at: url) }
            }
            done(.failure(hostError("page replaced", "cancelled")))
            return
          }
          self?.cancelInteraction = nil
          self?.photoPicker = nil
          switch result {
          case .success(let urls):
            self?.imported(urls, done)
            for url in urls { try? FileManager.default.removeItem(at: url) }
          case .failure(let error): done(.failure(error))
          }
        }
        photoPicker = delegate
        controller.delegate = delegate
        cancelInteraction = { [weak controller] in
          controller?.dismiss(animated: false)
          done(.failure(hostError("cancelled", "cancelled")))
        }
        presenter.present(controller, animated: true)
      } else {
        let types = documentTypes(args)
        guard !types.isEmpty, types.count <= 16 else { throw hostError("invalid document types") }
        let controller = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        controller.allowsMultipleSelection = args["multiple"] as? Bool == true
        let delegate = HostDocumentPicker { [weak self] result in
          guard self?.epoch == generation, self?.disposed == false else {
            done(.failure(hostError("page replaced", "cancelled")))
            return
          }
          self?.cancelInteraction = nil
          self?.picker = nil
          switch result {
          case .success(let urls): self?.imported(urls, done)
          case .failure(let error): done(.failure(error))
          }
        }
        picker = delegate
        controller.delegate = delegate
        cancelInteraction = { [weak controller] in
          controller?.dismiss(animated: false)
          done(.failure(hostError("cancelled", "cancelled")))
        }
        presenter.present(controller, animated: true)
      }
    }
    private func save(
      _ source: URL, _ args: [String: Any], _ done: @escaping (Result<Any, Error>) -> Void
    ) throws {
      let generation = epoch
      try beginInteraction()
      guard let presenter else { throw hostError("host window unavailable") }
      let name = (args["name"] as? String) ?? "project.bin"
      guard name.count <= 128, !name.contains("/"), !name.contains("\\"), name != ".", name != "..",
        !name.isEmpty
      else { throw hostError("invalid export name") }
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let file = directory.appendingPathComponent(name)
      do { try FileManager.default.copyItem(at: source, to: file) } catch {
        try? FileManager.default.removeItem(at: directory)
        throw error
      }
      let controller = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
      let delegate = HostDocumentPicker { [weak self] result in
        try? FileManager.default.removeItem(at: directory)
        guard self?.epoch == generation, self?.disposed == false else {
          done(.failure(hostError("page replaced", "cancelled")))
          return
        }
        self?.cancelInteraction = nil
        self?.picker = nil
        switch result {
        case .success: done(.success(true))
        case .failure(let error): done(.failure(error))
        }
      }
      picker = delegate
      controller.delegate = delegate
      cancelInteraction = { [weak controller] in
        controller?.dismiss(animated: false)
        try? FileManager.default.removeItem(at: directory)
        done(.failure(hostError("cancelled", "cancelled")))
      }
      presenter.present(controller, animated: true)
    }
    private func share(
      _ source: URL, _ args: [String: Any], _ done: @escaping (Result<Any, Error>) -> Void
    ) throws {
      let generation = epoch
      try beginInteraction()
      guard let presenter else { throw hostError("host window unavailable") }
      let (directory, file) = try namedExport(source, args)
      let controller = UIActivityViewController(activityItems: [file], applicationActivities: nil)
      controller.popoverPresentationController?.sourceView = presenter.view
      controller.popoverPresentationController?.sourceRect = CGRect(
        x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
      controller.completionWithItemsHandler = { [weak self] _, completed, _, error in
        try? FileManager.default.removeItem(at: directory)
        guard self?.epoch == generation, self?.disposed == false else {
          done(.failure(hostError("page replaced", "cancelled")))
          return
        }
        self?.cancelInteraction = nil
        if let error {
          done(.failure(error))
        } else if !completed {
          done(.failure(hostError("cancelled", "cancelled")))
        } else {
          done(.success(true))
        }
      }
      cancelInteraction = { [weak controller] in
        controller?.dismiss(animated: false)
        try? FileManager.default.removeItem(at: directory)
        done(.failure(hostError("cancelled", "cancelled")))
      }
      presenter.present(controller, animated: true)
    }
    var keyCommands: [UIKeyCommand] {
      shortcuts.map { item in
        var flags: UIKeyModifierFlags = []
        let mods = item["modifiers"] as! [String]
        if mods.contains("meta") { flags.insert(.command) }
        if mods.contains("ctrl") { flags.insert(.control) }
        if mods.contains("alt") { flags.insert(.alternate) }
        if mods.contains("shift") { flags.insert(.shift) }
        return UIKeyCommand(
          title: item["title"] as! String, image: nil,
          action: NSSelectorFromString("ntHostShortcut:"), input: item["key"] as! String,
          modifierFlags: flags, propertyList: item["id"])
      }
    }
    func shortcut(_ command: UIKeyCommand) {
      if let id = command.propertyList as? String { event("shortcut", ["id": id]) }
    }
  #else
    private func pick(
      _ args: [String: Any], gallery: Bool, _ done: @escaping (Result<Any, Error>) -> Void
    ) throws {
      let generation = epoch
      try beginInteraction()
      let panel = NSOpenPanel()
      panel.canChooseDirectories = false
      panel.allowsMultipleSelection = args["multiple"] as? Bool == true
      if gallery {
        panel.allowedContentTypes = [.image, .movie]
      } else {
        panel.allowedContentTypes = documentTypes(args)
      }
      cancelInteraction = {
        panel.cancel(nil)
        done(.failure(hostError("cancelled", "cancelled")))
      }
      panel.begin { [weak self] response in
        guard self?.epoch == generation, self?.disposed == false else {
          done(.failure(hostError("page replaced", "cancelled")))
          return
        }
        self?.cancelInteraction = nil
        if response == .OK {
          self?.imported(panel.urls, done)
        } else {
          done(.failure(hostError("cancelled", "cancelled")))
        }
      }
    }
    private func save(
      _ source: URL, _ args: [String: Any], _ done: @escaping (Result<Any, Error>) -> Void
    ) throws {
      let generation = epoch
      try beginInteraction()
      let panel = NSSavePanel()
      panel.nameFieldStringValue = args["name"] as? String ?? "project.bin"
      cancelInteraction = {
        panel.cancel(nil)
        done(.failure(hostError("cancelled", "cancelled")))
      }
      panel.begin { [weak self] response in
        guard self?.epoch == generation, self?.disposed == false else {
          done(.failure(hostError("page replaced", "cancelled")))
          return
        }
        self?.cancelInteraction = nil
        guard response == .OK, let target = panel.url else {
          done(.failure(hostError("cancelled", "cancelled")))
          return
        }
        do {
          let data = try Data(contentsOf: source)
          try data.write(to: target, options: .atomic)
          done(.success(true))
        } catch { done(.failure(error)) }
      }
    }
    private func share(
      _ source: URL, _ args: [String: Any], _ done: @escaping (Result<Any, Error>) -> Void
    ) throws {
      try beginInteraction()
      guard let view = web else { throw hostError("host window unavailable") }
      let (directory, file) = try namedExport(source, args)
      let coordinator = HostMacShare(file: file) { [weak self] result in
        self?.cancelInteraction = nil
        self?.sharingCoordinator = nil
        try? FileManager.default.removeItem(at: directory)
        done(result)
      }
      sharingCoordinator = coordinator
      cancelInteraction = { coordinator.cancel() }
      coordinator.show(view)
    }
    @objc private func menuShortcut(_ sender: NSMenuItem) {
      if let id = sender.representedObject as? String { event("shortcut", ["id": id]) }
    }
  #endif
  private func saveGallery(
    _ source: URL, _ args: [String: Any], _ done: @escaping (Result<Any, Error>) -> Void
  ) {
    PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
      guard status == .authorized || status == .limited else {
        done(.failure(hostError("photo library permission denied", "permission-denied")))
        return
      }
      var created = false
      PHPhotoLibrary.shared().performChanges({
        if (args["mime"] as? String)?.hasPrefix("video/") == true {
          created = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: source) != nil
        } else {
          created = PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: source) != nil
        }
      }) { ok, error in
        if let error {
          done(.failure(error))
        } else if ok && created {
          done(.success(true))
        } else {
          done(.failure(hostError("photo import failed", "io")))
        }
      }
    }
  }
  private func setShortcuts(_ args: [String: Any]) throws {
    guard let items = args["shortcuts"] as? [[String: Any]], items.count <= 32 else {
      throw hostError("invalid shortcut list")
    }
    var ids = Set<String>()
    var chords = Set<String>()
    for item in items {
      guard let id = item["id"] as? String,
        id.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil,
        let title = item["title"] as? String, !title.isEmpty, title.count <= 80,
        let key = item["key"] as? String,
        key.range(of: "^[a-z0-9]$", options: .regularExpression) != nil,
        let modifiers = item["modifiers"] as? [String], !modifiers.isEmpty,
        Set(modifiers).count == modifiers.count,
        modifiers.allSatisfy({ ["meta", "ctrl", "alt", "shift"].contains($0) }),
        !((modifiers.contains("meta") || modifiers.contains("ctrl"))
          && ["q", "w", "c", "v", "x", "z", "a", "r"].contains(key)), ids.insert(id).inserted,
        chords.insert(key + modifiers.sorted().joined()).inserted
      else { throw hostError("invalid, duplicate or reserved shortcut") }
    }
    shortcuts = items
    #if os(iOS)
      UIMenuSystem.main.setNeedsRebuild()
    #else
      if let old = pageMenu { NSApp.mainMenu?.removeItem(old) }
      let item = NSMenuItem(title: "Page", action: nil, keyEquivalent: "")
      let menu = NSMenu(title: "Page")
      for spec in items {
        let command = NSMenuItem(
          title: spec["title"] as! String, action: #selector(menuShortcut(_:)),
          keyEquivalent: spec["key"] as! String)
        command.target = self
        command.representedObject = spec["id"]
        var mask: NSEvent.ModifierFlags = []
        for modifier in spec["modifiers"] as! [String] {
          switch modifier {
          case "meta": mask.insert(.command)
          case "ctrl": mask.insert(.control)
          case "alt": mask.insert(.option)
          default: mask.insert(.shift)
          }
        }
        command.keyEquivalentModifierMask = mask
        menu.addItem(command)
      }
      item.submenu = menu
      NSApp.mainMenu?.addItem(item)
      pageMenu = item
    #endif
  }
  func reset() {
    epoch += 1
    active.removeAll()
    shortcuts.removeAll()
    #if os(iOS)
      UIMenuSystem.main.setNeedsRebuild()
    #endif
    cancelInteraction?()
    cancelInteraction = nil
    pdfJob?.cancel()
    pdfJob = nil
    if let store = try? ArchiveStore.shared.get() {
      for id in transactions { store.abort(id) }
      for id in leases { store.release(id) }
    }
    transactions.removeAll()
    leases.removeAll()
    #if os(macOS)
      if let menu = pageMenu { NSApp.mainMenu?.removeItem(menu) }
      pageMenu = nil
      sharingCoordinator = nil
    #endif
  }
  func dispose() {
    guard !disposed else { return }
    reset()
    disposed = true
    Self.observers.removeValue(forKey: observerID)
    web?.configuration.userContentController.removeScriptMessageHandler(forName: "ntHost")
  }
}

#if os(iOS)
  private final class HostDocumentPicker: NSObject, UIDocumentPickerDelegate {
    let done: (Result<[URL], Error>) -> Void
    init(_ done: @escaping (Result<[URL], Error>) -> Void) { self.done = done }
    func documentPicker(
      _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
    ) { done(.success(urls)) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
      done(.failure(hostError("cancelled", "cancelled")))
    }
  }
  private final class HostPhotoPicker: NSObject, PHPickerViewControllerDelegate {
    let done: (Result<[URL], Error>) -> Void
    init(_ done: @escaping (Result<[URL], Error>) -> Void) { self.done = done }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
      picker.dismiss(animated: true)
      guard !results.isEmpty, results.count <= 16 else {
        done(.failure(hostError("cancelled", "cancelled")))
        return
      }
      let group = DispatchGroup()
      let lock = NSLock()
      var urls: [URL] = []
      var failure: Error?
      for result in results {
        let provider = result.itemProvider
        guard let type = provider.registeredTypeIdentifiers.first else { continue }
        group.enter()
        provider.loadFileRepresentation(forTypeIdentifier: type) { source, error in
          defer { group.leave() }
          lock.lock()
          defer { lock.unlock() }
          do {
            guard let source else { throw error ?? hostError("photo unavailable", "io") }
            let target = FileManager.default.temporaryDirectory.appendingPathComponent(
              UUID().uuidString)
            try FileManager.default.copyItem(at: source, to: target)
            urls.append(target)
          } catch { failure = error }
        }
      }
      group.notify(queue: .main) {
        if let failure {
          for url in urls { try? FileManager.default.removeItem(at: url) }
          self.done(.failure(failure))
        } else {
          self.done(.success(urls))
        }
      }
    }
  }
#endif

#if os(macOS)
  private final class HostMacShare: NSObject, NSSharingServicePickerDelegate,
    NSSharingServiceDelegate
  {
    private let picker: NSSharingServicePicker
    private var completion: ((Result<Any, Error>) -> Void)?
    init(file: URL, done: @escaping (Result<Any, Error>) -> Void) {
      picker = NSSharingServicePicker(items: [file])
      completion = done
      super.init()
      picker.delegate = self
    }
    func show(_ view: NSView) {
      picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    }
    func sharingServicePicker(
      _ picker: NSSharingServicePicker, didChoose service: NSSharingService?
    ) { if let service { service.delegate = self } else { cancel() } }
    func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
      finish(.success(true))
    }
    func sharingService(
      _ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error
    ) { finish(.failure(error)) }
    private func finish(_ result: Result<Any, Error>) {
      guard let done = completion else { return }
      completion = nil
      done(result)
    }
    func cancel() { finish(.failure(hostError("share cancelled", "cancelled"))) }
  }
#endif
