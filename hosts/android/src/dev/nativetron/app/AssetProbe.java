package dev.nativetron.app;

// Debug acceptance only. Runs in the real WebView; headers/MIME are not inferred from Java policy.
final class AssetProbe {
  private AssetProbe() {}
  static final String SCRIPT = """
    (async () => {
      const get = async (path, method = 'GET') => {
        try {
          const response = await fetch(path, {method});
          return {status:response.status, type:response.headers.get('content-type') || '',
            coop:response.headers.get('cross-origin-opener-policy'), coep:response.headers.get('cross-origin-embedder-policy'),
            nosniff:response.headers.get('x-content-type-options'), bytes:(await response.arrayBuffer()).byteLength};
        } catch (error) { return {status:0, error:String(error)}; }
      };
      const result = {secure:isSecureContext, isolated:crossOriginIsolated,
        page:await get('/engine/page.html'), wasm:await get('/engine/.scriptc/ui.wasm'),
        module:await get('/engine/host.js'), head:await get('/engine/host.js','HEAD'),
        post:await get('/engine/host.js','POST'), missing:await get('/engine/unknown.js'),
        manifest:await get('/asset-manifest.json'), encoded:await get('/engine%2fhost.js'),
        external:await get('https://example.invalid/nativetron-offline-probe')};
      const has = (entry, type) => entry.status === 200 && entry.type.startsWith(type) && entry.coep === 'require-corp' && entry.coop === 'same-origin' && entry.nosniff === 'nosniff';
      const ok = result.secure && has(result.page,'text/html') && has(result.wasm,'application/wasm') && has(result.module,'text/javascript') &&
        has(result.head,'text/javascript') && result.head.bytes === 0 && result.post.status === 405 && result.missing.status === 404 &&
        result.manifest.status === 404 && [400,404].includes(result.encoded.status) && [0,403].includes(result.external.status);
      console.log('NT_ANDROID_ASSET_' + (ok ? 'OK ' : 'FAIL ') + JSON.stringify(result));
    })().catch(error => console.log('NT_ANDROID_ASSET_FAIL ' + String(error)))
    """;
}
