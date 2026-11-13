import Foundation
import PDFKit
import WebKit

// Explicit opt-in probe: no file dialogs, printers, Photos permissions or
// persistent user data. The runner supplies a private archive directory.
@MainActor func runHostSelfTest(_ web: WKWebView, done: @escaping (Bool, String) -> Void) {
  let key = "selftest-" + UUID().uuidString
  let script = """
    for (let i=0; !window.nativetronHost && i<200; i++) await new Promise(r=>setTimeout(r,25));
    const client=window.nativetronHost;
    if (!client) throw Error('host client not installed');
    const capabilities=await client.capabilities();
    const observed=[];const watch=client.watchPowerState(s=>observed.push(s));
    const power=await watch.ready;watch.dispose();
    if(typeof power.lowPowerMode!=='boolean'||!Number.isSafeInteger(power.revision)||observed.length!==1)throw Error('native power snapshot failed');
    const data=new TextEncoder().encode('archive round trip: \\u03bb \\ud83d\\ude80');
    try {
      await client.archive.put(key,data);
      const result=await client.archive.get(key);
      if (result.length!==data.length || result.some((x,i)=>x!==data[i])) throw Error('archive mismatch');
      await client.registerShortcuts([{id:'selftest',title:'Self test',key:'9',modifiers:['ctrl','shift']}]);
      await client.registerShortcuts([]);
      const file=await client.pdf({html:'<style>.print{display:none}@media print{.print{display:block}.screen{display:none}}</style><div class="print">NT_PRINT_SENTINEL</div><div class="screen">NT_SCREEN_SENTINEL</div>'});
      return {file:file.file,size:file.size,pdfMode:capabilities.pdfOutput,archive:true};
    } finally { await client.archive.remove(key); }
    """
  var finished = false
  let finish: (Bool, String) -> Void = { ok, message in
    guard !finished else { return }
    finished = true
    try? ArchiveStore.shared.get().remove(key)
    done(ok, message)
  }
  web.callAsyncJavaScript(script, arguments: ["key": key], in: nil, in: .page) { result in
    switch result {
    case .failure(let error): finish(false, error.localizedDescription)
    case .success(let value):
      do {
        guard let object = value as? [String: Any], let id = object["file"] as? String else {
          throw hostError("missing PDF result")
        }
        let store = try ArchiveStore.shared.get()
        defer { store.release(id) }
        guard let pdf = PDFDocument(url: try store.url(id)), pdf.pageCount > 0,
          let text = pdf.string, text.contains("NT_PRINT_SENTINEL"),
          !text.contains("NT_SCREEN_SENTINEL")
        else { throw hostError("PDF did not apply print CSS") }
        finish(
          true,
          "archive round-trip, lease release, shortcuts, power snapshot and print-CSS PDF passed")
      } catch { finish(false, String(describing: error)) }
    }
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + 45) { finish(false, "host self-test timed out") }
}
