import Foundation

@main struct ArchiveStoreTests {
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
    print(
      "Apple archive: atomic replacement, stable snapshots, persistence, bounds and cleanup passed")
  }
}
