import Foundation
import PDFKit
import UIKit
import WebKit

// Opt-in simulator/device probe. No Photos writes, pickers or print dialogs.
@MainActor enum ServiceProbe {
  static let enabled = CommandLine.arguments.contains("--nt-service-probe")
  static func run(_ web: WKWebView, done: @escaping (Bool, String) -> Void) {
    let script = """
      for(let i=0;!window.nativetronHost&&i<200;i++) await new Promise(r=>setTimeout(r,25));
      const host=window.nativetronHost;
      if(!host) throw Error('host API unavailable');
      const power=await host.powerState();
      if(typeof power.lowPowerMode!=='boolean'||!Number.isSafeInteger(power.revision)) throw Error('bad power state');
      const html='<style>@page{size:A4;margin:0}body{margin:0}.print{display:none}@media print{.print{display:block}.screen{display:none}}</style><div class="print" style="width:0;height:0;border:48px solid rgb(255,0,0)"></div><div class="screen">SCREEN_SENTINEL</div>';
      const pdf=await host.pdf({html,name:'scale-probe.pdf'});
      return {file:pdf.file};
      """
    web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
      switch result {
      case .failure(let error): done(false, error.localizedDescription)
      case .success(let value):
        do {
          guard let data = value as? [String: Any], let id = data["file"] as? String else {
            throw hostError("missing PDF result")
          }
          let store = try ArchiveStore.shared.get()
          defer { store.release(id) }
          guard let pdf = PDFDocument(url: try store.url(id)), pdf.pageCount == 1,
            let page = pdf.page(at: 0), let reference = page.pageRef
          else { throw hostError("invalid PDF page count") }
          let rect = page.bounds(for: .mediaBox)
          guard abs(rect.width - 595.28) < 1, abs(rect.height - 841.89) < 1 else {
            throw hostError("PDF paper size is not A4 points")
          }
          let width = Int(ceil(rect.width))
          let height = Int(ceil(rect.height))
          var pixels = [UInt8](repeating: 255, count: width * height * 4)
          let measured: (Int, Int) = try pixels.withUnsafeMutableBytes { raw in
            guard
              let context = CGContext(
                data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
                  | CGImageAlphaInfo.premultipliedLast.rawValue)
            else { throw hostError("cannot rasterize PDF") }
            context.setFillColor(UIColor.white.cgColor)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.drawPDFPage(reference)
            let bytes = raw.bindMemory(to: UInt8.self)
            var minX = width
            var maxX = -1
            var minY = height
            var maxY = -1
            for y in 0..<height {
              for x in 0..<width {
                let at = (y * width + x) * 4
                if bytes[at] > 220 && bytes[at + 1] < 40 && bytes[at + 2] < 40 {
                  minX = min(minX, x)
                  maxX = max(maxX, x)
                  minY = min(minY, y)
                  maxY = max(maxY, y)
                }
              }
            }
            return (maxX - minX + 1, maxY - minY + 1)
          }
          guard abs(measured.0 - 72) <= 2, abs(measured.1 - 72) <= 2 else {
            throw hostError(
              "96 CSS px rendered as \(measured.0)x\(measured.1) PDF points; expected 72x72; screen scale \(UIScreen.main.scale)"
            )
          }
          done(
            true,
            "A4 print CSS: 96 CSS px = \(measured.0)x\(measured.1) PDF points; native power snapshot passed"
          )
        } catch { done(false, String(describing: error)) }
      }
    }
  }
}
