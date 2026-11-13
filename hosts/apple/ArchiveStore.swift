import Foundation

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif

struct HostServiceError: Error {
  let code: String
  let message: String
}
func hostError(_ message: String, _ code: String = "invalid-request") -> HostServiceError {
  HostServiceError(code: code, message: message)
}

// Native storage is independent of WebKit's ephemeral website data store.
// Tokens never expose paths; staging and committed files stay in our sandbox.
final class ArchiveStore {
  static let shared: Result<ArchiveStore, Error> = Result {
    let probe =
      CommandLine.arguments.contains("--host-selftest")
      ? ProcessInfo.processInfo.environment["NT_HOST_ARCHIVE_ROOT"] : nil
    let root =
      (CommandLine.arguments.contains("--nt-service-probe")
        ? FileManager.default.temporaryDirectory.appendingPathComponent("nt-service-probe") : nil)
      ?? probe.map { URL(fileURLWithPath: $0, isDirectory: true) }
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("dev.nativetron.documents")
    return try ArchiveStore(root: root)
  }
  static let maxFile = 256 * 1024 * 1024
  static let chunk = 192 * 1024
  private let root: URL, archives: URL, staging: URL
  private let quota: Int
  private let lock = NSRecursiveLock()
  private var lockFD: Int32 = -1
  private var files: [String: URL] = [:]
  private struct Write {
    let url: URL
    let key: String
    let expected: Int
    let handle: FileHandle
    var offset: Int
  }
  private var writes: [String: Write] = [:]
  init(root: URL, quota: Int = 1024 * 1024 * 1024) throws {
    guard quota >= 0 else { throw hostError("invalid archive quota") }
    self.quota = quota
    self.root = root
    archives = root.appendingPathComponent("archives")
    staging = root.appendingPathComponent("staging")
    for directory in [root, archives, staging] {
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    lockFD = open(root.appendingPathComponent(".lock").path, O_RDWR | O_CREAT, 0o600)
    guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
      if lockFD >= 0 {
        close(lockFD)
        lockFD = -1
      }
      throw hostError("archive store is locked", "busy")
    }
    // Exclusive process ownership makes crash leftovers safe to remove.
    for url in try FileManager.default.contentsOfDirectory(
      at: staging, includingPropertiesForKeys: nil)
    { try FileManager.default.removeItem(at: url) }
  }
  private func key(_ value: String) throws -> String {
    guard value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil,
      !value.contains("..")
    else { throw hostError("invalid archive key") }
    return value
  }
  private func size(_ url: URL) throws -> Int {
    (try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
  }
  private func capacity(_ extra: Int) throws {
    let urls = FileManager.default.enumerator(
      at: root, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey])
    var used = 0
    while let url = urls?.nextObject() as? URL {
      let info = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
      if info.isRegularFile == true { used += info.fileSize ?? 0 }
    }
    used += writes.values.reduce(0) { $0 + $1.expected - $1.offset }
    guard extra >= 0, extra <= quota, used <= quota - extra else {
      throw hostError("native archive quota exceeded", "quota")
    }
  }
  deinit {
    for id in Array(writes.keys) { abort(id) }
    for id in Array(files.keys) { release(id) }
    if lockFD >= 0 {
      flock(lockFD, LOCK_UN)
      close(lockFD)
    }
  }
  func begin(key name: String, size expected: Int) throws -> String {
    lock.lock()
    defer { lock.unlock() }

    let name = try key(name)
    guard expected >= 0, expected <= Self.maxFile, writes.count < 16,
      !writes.values.contains(where: { $0.key == name })
    else { throw hostError("invalid or busy archive write") }
    guard
      try FileManager.default.contentsOfDirectory(atPath: archives.path).count < 128
        || FileManager.default.fileExists(atPath: archives.appendingPathComponent(name).path)
    else { throw hostError("archive count exceeded", "quota") }
    try capacity(expected)
    let id = UUID().uuidString
    let url = staging.appendingPathComponent(UUID().uuidString)
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw hostError("cannot stage archive", "io")
    }
    writes[id] = Write(
      url: url, key: name, expected: expected, handle: try FileHandle(forWritingTo: url), offset: 0)
    return id
  }
  func write(_ id: String, offset: Int, data: Data) throws {
    lock.lock()
    defer { lock.unlock() }

    guard var item = writes[id], offset == item.offset, data.count <= Self.chunk,
      data.count <= item.expected - item.offset
    else { throw hostError("invalid archive chunk or offset") }
    try item.handle.write(contentsOf: data)
    item.offset += data.count
    writes[id] = item
  }
  func commit(_ id: String) throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }

    guard let item = writes[id], item.offset == item.expected else {
      throw hostError("incomplete archive")
    }
    try item.handle.synchronize()
    try item.handle.close()
    let target = archives.appendingPathComponent(item.key)
    guard rename(item.url.path, target.path) == 0 else {
      throw hostError("cannot atomically commit archive", "io")
    }
    writes.removeValue(forKey: id)
    return ["key": item.key, "size": item.expected]
  }
  func abort(_ id: String) {
    lock.lock()
    defer { lock.unlock() }
    if let item = writes.removeValue(forKey: id) {
      try? item.handle.close()
      try? FileManager.default.removeItem(at: item.url)
    }
  }
  func list() throws -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return try FileManager.default.contentsOfDirectory(
      at: archives, includingPropertiesForKeys: [.fileSizeKey]
    ).sorted { $0.lastPathComponent < $1.lastPathComponent }.map {
      ["key": $0.lastPathComponent, "size": try size($0)]
    }
  }
  func remove(_ name: String) throws {
    lock.lock()
    defer { lock.unlock() }
    try FileManager.default.removeItem(at: archives.appendingPathComponent(try key(name)))
  }
  func snapshot(_ name: String) throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }

    let source = archives.appendingPathComponent(try key(name))
    guard files.count < 32 else { throw hostError("file lease capacity exceeded", "busy") }
    let id = UUID().uuidString
    let bytes = try size(source)
    try capacity(bytes)
    let url = HostFileNames.stagingURL(in: staging, name: name)
    // Snapshot under the store lock. Copies work on mobile filesystems that
    // deny hard links and still pin a version across atomic replacement.
    do { try FileManager.default.copyItem(at: source, to: url) } catch {
      try? FileManager.default.removeItem(at: url)
      throw error
    }
    files[id] = url
    return ["file": id, "name": name, "size": try size(url)]
  }
  func importFile(_ source: URL, name: String? = nil) throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }

    guard files.count < 32 else { throw hostError("file lease capacity exceeded", "busy") }
    let properties = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard properties.isRegularFile == true, properties.isSymbolicLink != true else {
      throw hostError("only regular documents can be imported")
    }
    let fd = open(source.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw hostError("cannot open document", "io") }
    let input = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? input.close() }
    var metadata = stat()
    guard fstat(fd, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size >= 0,
      metadata.st_size <= Self.maxFile
    else { throw hostError("invalid document size/type", "quota") }
    let bytes = Int(metadata.st_size)
    try capacity(bytes)
    let id = UUID().uuidString
    let typedName =
      name.flatMap { HostFileNames.suffix($0) != nil ? $0 : nil } ?? source.lastPathComponent
    let url = HostFileNames.stagingURL(in: staging, name: typedName)
    guard
      FileManager.default.createFile(
        atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
    else { throw hostError("cannot stage document", "io") }
    do {
      let output = try FileHandle(forWritingTo: url)
      defer { try? output.close() }
      var copied = 0
      while let chunk = try input.read(upToCount: Self.chunk), !chunk.isEmpty {
        guard chunk.count <= bytes - copied else {
          throw hostError("document changed during import", "io")
        }
        try output.write(contentsOf: chunk)
        copied += chunk.count
      }
      guard copied == bytes else { throw hostError("document changed during import", "io") }
      try output.synchronize()
      files[id] = url
      return ["file": id, "name": name ?? source.lastPathComponent, "size": bytes]
    } catch {
      try? FileManager.default.removeItem(at: url)
      throw error
    }
  }

  func url(_ id: String) throws -> URL {
    lock.lock()
    defer { lock.unlock() }
    guard let url = files[id] else { throw hostError("unknown file token") }
    return url
  }
  func read(_ id: String, offset: Int, length: Int) throws -> Data {
    lock.lock()
    defer { lock.unlock() }

    let url = try self.url(id)
    let count = try size(url)
    guard offset >= 0, length >= 0, length <= Self.chunk, offset <= count, length <= count - offset
    else { throw hostError("invalid file range") }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    try handle.seek(toOffset: UInt64(offset))
    return try handle.read(upToCount: length) ?? Data()
  }
  func release(_ id: String) {
    lock.lock()
    defer { lock.unlock() }
    if let url = files.removeValue(forKey: id) { try? FileManager.default.removeItem(at: url) }
  }
}
