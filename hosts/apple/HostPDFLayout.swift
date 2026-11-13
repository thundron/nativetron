import CoreGraphics
import Foundation

// PDF points are 1/72 inch; CSS reference pixels are 1/96 inch. Neither is a
// device pixel. Normalize WebKit's snapshot coordinates explicitly, then clip
// its continuous print-media layout into paper pages with fixed point margins.
enum HostPDFLayout {
  static let paper = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)
  static let printable = paper.insetBy(dx: 24, dy: 24)
  static let pointsPerCSSPixel: CGFloat = 72.0 / 96.0
  static func write(snapshot: Data, cssSize: CGSize, to output: URL) throws {
    guard cssSize.width.isFinite, cssSize.height.isFinite, cssSize.width > 0, cssSize.height > 0,
      cssSize.width <= 16384, cssSize.height <= 1_000_000,
      let provider = CGDataProvider(data: snapshot as CFData), let pdf = CGPDFDocument(provider),
      pdf.numberOfPages == 1, let page = pdf.page(at: 1)
    else { throw hostError("invalid PDF snapshot", "quota") }
    let box = page.getBoxRect(.mediaBox)
    guard box.width > 0, box.height > 0 else { throw hostError("invalid snapshot bounds") }
    let scale = cssSize.width * pointsPerCSSPixel / box.width
    let height = cssSize.height * pointsPerCSSPixel
    guard abs(box.height * scale - height) <= max(1, height * 0.001) else {
      throw hostError("nonuniform PDF snapshot scale")
    }
    let pages = Int(ceil(height / printable.height))
    guard pages > 0, pages <= 4096 else { throw hostError("PDF page limit exceeded", "quota") }
    var media = paper
    guard let context = CGContext(output as CFURL, mediaBox: &media, nil) else {
      throw hostError("cannot create PDF", "io")
    }
    for index in 0..<pages {
      context.beginPDFPage(nil)
      context.saveGState()
      context.clip(to: printable)
      context.translateBy(
        x: printable.minX - box.minX * scale,
        y: printable.maxY - height + CGFloat(index) * printable.height - box.minY * scale)
      context.scaleBy(x: scale, y: scale)
      context.drawPDFPage(page)
      context.restoreGState()
      context.endPDFPage()
    }
    context.closePDF()
  }
}
