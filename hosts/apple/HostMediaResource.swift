import Foundation
import ImageIO
import UniformTypeIdentifiers

// PhotoKit consumes file URLs, not the page's MIME metadata. Always provide an
// owned URL with a suitable extension; never rename a live archive/file lease.
final class HostMediaResource {
  let url: URL
  let isVideo: Bool
  private let directory: URL
  private init(url: URL, directory: URL, isVideo: Bool) {
    self.url = url
    self.directory = directory
    self.isVideo = isVideo
  }
  static func prepare(_ source: URL, mime: String) throws -> HostMediaResource {
    guard let declared = UTType(mimeType: mime),
      declared.conforms(to: .image) || declared.conforms(to: .movie)
    else {
      throw hostError("gallery requires a concrete image/video MIME type")
    }
    let video = declared.conforms(to: .movie)
    let type: UTType
    if video {
      // A provider-supplied movie extension carries container information that
      // a generic video MIME can lose. Otherwise use the declared container.
      type =
        HostFileNames.suffix(source.lastPathComponent).flatMap { UTType(filenameExtension: $0) }
        .flatMap { $0.conforms(to: .movie) ? $0 : nil } ?? declared
    } else {
      guard
        let image = CGImageSourceCreateWithURL(
          source as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
        let identifier = CGImageSourceGetType(image), let actual = UTType(identifier as String),
        actual.conforms(to: .image)
      else {
        throw hostError("gallery source is not a supported encoded image")
      }
      type = actual
    }
    guard let ext = type.preferredFilenameExtension, HostFileNames.suffix("resource." + ext) != nil
    else {
      throw hostError("media type has no supported file extension")
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "nt-photos-" + UUID().uuidString)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let target = directory.appendingPathComponent("resource").appendingPathExtension(ext)
    do { try FileManager.default.copyItem(at: source, to: target) } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
    return HostMediaResource(url: target, directory: directory, isVideo: video)
  }
  func dispose() { try? FileManager.default.removeItem(at: directory) }
  deinit { dispose() }
}
