import Foundation

@main struct ArchiveStoreTests {
  static func tryURLSuffix(_ store: ArchiveStore, _ token: String) -> String {
    (try? store.url(token).pathExtension) ?? ""
  }
  static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "nt-archive-test-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    var store: ArchiveStore? = try ArchiveStore(root: root)
    func rejected(_ fn: () throws -> Void) {
      do {
        try fn()
        fatalError("expected rejection")
      } catch {}
    }
    for key in ["../escape", "a/b", "", ".hidden", "a..b"] {
      rejected { _ = try store!.begin(key: key, size: 1) }
    }
    let transaction = try store!.begin(key: "project.ntproject", size: 3)
    rejected { try store!.write(transaction, offset: 1, data: Data([1])) }
    rejected { _ = try store!.commit(transaction) }
    try store!.write(transaction, offset: 0, data: Data([1, 2, 3]))
    _ = try store!.commit(transaction)
    let snapshot = try store!.snapshot("project.ntproject")
    let token = snapshot["file"] as! String
    let originalInfo = try FileManager.default.attributesOfItem(
      atPath: root.appendingPathComponent("archives/project.ntproject").path)
    let snapshotInfo = try FileManager.default.attributesOfItem(atPath: store!.url(token).path)
    precondition(
      (originalInfo[.systemFileNumber] as! NSNumber)
        != (snapshotInfo[.systemFileNumber] as! NSNumber), "snapshot must not require a hard link")
    precondition(tryURLSuffix(store!, token) == "ntproject")
    let replacement = try store!.begin(key: "project.ntproject", size: 3)
    try store!.write(replacement, offset: 0, data: Data([4, 5, 6]))
    _ = try store!.commit(replacement)
    let oldBytes = try store!.read(token, offset: 0, length: 3)
    precondition(oldBytes == Data([1, 2, 3]), "snapshot changed during replacement")
    store!.release(token)
    rejected { _ = try store!.read(token, offset: 0, length: 1) }
    let abandoned = try store!.begin(key: "aborted", size: 1)
    store!.abort(abandoned)
    let firstList = try store!.list()
    precondition(firstList.count == 1)
    store = nil
    store = try ArchiveStore(root: root)
    let reopened = try store!.snapshot("project.ntproject")
    let reopenedID = reopened["file"] as! String
    let currentBytes = try store!.read(reopenedID, offset: 0, length: 3)
    precondition(currentBytes == Data([4, 5, 6]), "archive did not survive reopening")
    rejected { _ = try store!.read(reopenedID, offset: 2, length: 2) }
    store!.release(reopenedID)
    try store!.remove("project.ntproject")
    let finalList = try store!.list()
    precondition(finalList.isEmpty)
    store = nil
    let limitedRoot = root.appendingPathComponent("limited")
    let limited = try ArchiveStore(root: limitedRoot, quota: 6)
    let write = try limited.begin(key: "project", size: 3)
    try limited.write(write, offset: 0, data: Data([1, 2, 3]))
    _ = try limited.commit(write)
    let lease = try limited.snapshot("project")["file"] as! String
    rejected { _ = try limited.snapshot("project") }
    limited.release(lease)
    let retry = try limited.snapshot("project")["file"] as! String
    limited.release(retry)
    print(
      "Apple archive: atomic replacement, stable snapshots, persistence, bounds and cleanup passed")
  }
}
