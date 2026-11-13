import CoreGraphics
import Foundation
import ImageIO

@main struct MediaPowerPDFTests {
  static func rejected(_ fn: () throws -> Void) {
    do {
      try fn()
      fatalError("expected rejection")
    } catch {}
  }
  static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "nt-media-power-pdf-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let input = root.appendingPathComponent("extensionless")
    let png = Data(
      base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII="
    )!
    try png.write(to: input)
    let image = try HostMediaResource.prepare(input, mime: "image/png")
    precondition(image.url.pathExtension == "png" && !image.isVideo)
    let imageBytes = try Data(contentsOf: image.url)
    precondition(imageBytes == png)
    let imageURL = image.url
    image.dispose()
    precondition(!FileManager.default.fileExists(atPath: imageURL.path))
    let actualType = try HostMediaResource.prepare(input, mime: "image/jpeg")
    precondition(actualType.url.pathExtension == "png")
    actualType.dispose()
    let video = try HostMediaResource.prepare(input, mime: "video/mp4")
    precondition(video.isVideo && video.url.pathExtension == "mp4")
    video.dispose()
    rejected { _ = try HostMediaResource.prepare(input, mime: "application/pdf") }
    precondition(
      HostFileNames.suffix("../../x.PNG") == "png" && HostFileNames.suffix("x.evil/part") == nil)
    let store = try ArchiveStore(root: root.appendingPathComponent("store"))
    let imported = try store.importFile(input, name: "photo.png")
    let token = imported["file"] as! String
    let preserved = try store.url(token)
    precondition(preserved.pathExtension == "png")
    store.release(token)

    var facts: HostPowerState.Facts = (false, 0)
    var events: [[String: Any]] = []
    let power = HostPowerState(read: { facts }, observe: false) { events.append($0) }
    let first = power.snapshot()
    precondition(first["revision"] as? Int == 1 && first["thermalState"] as? String == "nominal")
    facts = (true, 2)
    power.refresh()
    precondition(
      events.last?["lowPowerMode"] as? Bool == true
        && events.last?["thermalState"] as? String == "serious"
        && events.last?["revision"] as? Int == 2)
    power.refresh()
    precondition(events.last?["revision"] as? Int == 2)
    facts = (true, 99)
    power.refresh()
    precondition(events.last?["thermalState"] as? String == "unknown")
    let count = events.count
    power.dispose()
    power.refresh()
    precondition(events.count == count)

    var notifications = 0
    let observed = HostPowerState(read: { facts }) { _ in notifications += 1 }
    NotificationCenter.default.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
    precondition(notifications == 1)
    observed.dispose()
    NotificationCenter.default.post(
      name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
    precondition(notifications == 1, "power observers survived disposal")

    for pixelScale: CGFloat in [1, 2, 3] {
      let css = CGSize(width: 730, height: 3000)
      let data = NSMutableData()
      var bounds = CGRect(
        x: 0, y: 0, width: css.width * pixelScale, height: css.height * pixelScale)
      let consumer = CGDataConsumer(data: data as CFMutableData)!
      let drawing = CGContext(consumer: consumer, mediaBox: &bounds, nil)!
      drawing.beginPDFPage(nil)
      drawing.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
      drawing.fill(
        CGRect(
          x: 10 * pixelScale, y: (css.height - 106) * pixelScale, width: 96 * pixelScale,
          height: 96 * pixelScale))
      drawing.endPDFPage()
      drawing.closePDF()
      let output = root.appendingPathComponent("scale-\(Int(pixelScale)).pdf")
      try HostPDFLayout.write(snapshot: data as Data, cssSize: css, to: output)
      let pdf = CGPDFDocument(output as CFURL)!
      precondition(pdf.numberOfPages == 3)
      let page = pdf.page(at: 1)!
      let paper = page.getBoxRect(.mediaBox)
      precondition(abs(paper.width - 595.28) < 1 && abs(paper.height - 841.89) < 1)
      let width = 596
      let height = 842
      var bytes = [UInt8](repeating: 255, count: width * height * 4)
      let size: (Int, Int) = bytes.withUnsafeMutableBytes { raw in
        let context = CGContext(
          data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
          bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
            | CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.drawPDFPage(page)
        let p = raw.bindMemory(to: UInt8.self)
        var minX = width
        var minY = height
        var maxX = -1
        var maxY = -1
        for y in 0..<height {
          for x in 0..<width {
            let i = (y * width + x) * 4
            if p[i] > 220 && p[i + 1] < 40 && p[i + 2] < 40 {
              minX = min(minX, x)
              maxX = max(maxX, x)
              minY = min(minY, y)
              maxY = max(maxY, y)
            }
          }
        }
        return (maxX - minX + 1, maxY - minY + 1)
      }
      precondition(
        abs(size.0 - 72) <= 1 && abs(size.1 - 72) <= 1, "PDF scale depends on pixel scale")
    }
    rejected {
      try HostPDFLayout.write(
        snapshot: Data(), cssSize: CGSize(width: 1, height: 1),
        to: root.appendingPathComponent("bad.pdf"))
    }
    print(
      "Apple media/power/PDF: typed resources and cleanup; power revisions/disposal; 1x/2x/3x CSS-to-point geometry and pagination passed"
    )
  }
}
