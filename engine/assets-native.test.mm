#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <cstdint>
#include <cstdio>

extern "C" int32_t nt_assets_configure(const uint8_t *, size_t, const uint8_t *, size_t, int32_t);
extern "C" void nt_assets_install(void *);

@interface AssetProbe : NSObject <WKNavigationDelegate>
@property(nonatomic) BOOL done;
@property(nonatomic) BOOL passed;
@property(nonatomic) BOOL isolated;
@end
@implementation AssetProbe
- (void)webView:(WKWebView *)web didFinishNavigation:(WKNavigation *)navigation {
  (void)navigation;
  NSString *script = @"const paths=['gpu/.scriptc/demo.wasm','engine/worker.js','host/dom-host.js','private.txt','engine/../../private.txt']; const results=[]; for (const path of paths) { const r=await fetch('app://local/'+path); results.push({path,status:r.status,mime:r.headers.get('Content-Type'),coop:r.headers.get('Cross-Origin-Opener-Policy'),coep:r.headers.get('Cross-Origin-Embedder-Policy'),length:(await r.arrayBuffer()).byteLength}); } return results;";
  [web callAsyncJavaScript:script arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *error) {
    self.passed = !error && [result isKindOfClass:NSArray.class] && [result count] == 5;
    if (self.passed) {
      NSArray *rows = result;
      NSArray *mimes = @[@"application/wasm", @"text/javascript"];
      for (NSUInteger index = 0; index < rows.count; index++) {
        NSDictionary *row = rows[index];
        NSInteger expected = index < 2 ? 200 : 404;
        if ([row[@"status"] integerValue] != expected) self.passed = NO;
        if (index < 2 && (![row[@"mime"] isEqual:mimes[index]] || [row[@"length"] integerValue] == 0)) self.passed = NO;
        if (index >= 2 && [row[@"length"] integerValue] != 0) self.passed = NO;
        if (self.isolated && (![row[@"coop"] isEqual:@"same-origin"] || ![row[@"coep"] isEqual:@"require-corp"])) self.passed = NO;
        if (!self.isolated && (row[@"coop"] != NSNull.null || row[@"coep"] != NSNull.null)) self.passed = NO;
      }
    }
    if (!self.passed) NSLog(@"asset probe failure: %@ %@", result, error);
    self.done = YES;
  }];
}
- (void)webView:(WKWebView *)web didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  (void)web; (void)navigation; NSLog(@"asset navigation failed: %@", error); self.done = YES;
}
- (void)webView:(WKWebView *)web didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  [self webView:web didFailNavigation:navigation withError:error];
}
@end

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSString *parent = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString *root = [parent stringByAppendingPathComponent:@"bundle"];
    NSFileManager *files = NSFileManager.defaultManager;
    for (NSString *directory in @[@"engine", @"gpu/.scriptc", @"host"]) [files createDirectoryAtPath:[root stringByAppendingPathComponent:directory] withIntermediateDirectories:YES attributes:nil error:nil];
    [@"<!doctype html><body>native asset probe</body>" writeToFile:[root stringByAppendingPathComponent:@"engine/page.html"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    [@"export {};" writeToFile:[root stringByAppendingPathComponent:@"engine/worker.js"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    const uint8_t wasm[] = {0,97,115,109,1,0,0,0};
    [[NSData dataWithBytes:wasm length:sizeof(wasm)] writeToFile:[root stringByAppendingPathComponent:@"gpu/.scriptc/demo.wasm"] atomically:YES];
    NSString *secret = [parent stringByAppendingPathComponent:@"secret.js"];
    [@"must not be served" writeToFile:secret atomically:YES encoding:NSUTF8StringEncoding error:nil];
    [files createSymbolicLinkAtPath:[root stringByAppendingPathComponent:@"host/dom-host.js"] withDestinationPath:secret error:nil];
    [@"must not be served" writeToFile:[root stringByAppendingPathComponent:@"private.txt"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    BOOL passed = YES;
    for (int isolated = 0; isolated <= 1; isolated++) {
      NSData *directory = [root dataUsingEncoding:NSUTF8StringEncoding], *entry = [@"engine/page.html" dataUsingEncoding:NSUTF8StringEncoding];
      if (!nt_assets_configure((const uint8_t *)directory.bytes, directory.length, (const uint8_t *)entry.bytes, entry.length, isolated)) { passed = NO; break; }
      WKWebViewConfiguration *config = [WKWebViewConfiguration new]; nt_assets_install((__bridge void *)config);
      WKWebView *web = [[WKWebView alloc] initWithFrame:NSMakeRect(0,0,200,200) configuration:config];
      AssetProbe *probe = [AssetProbe new]; probe.isolated = isolated; web.navigationDelegate = probe;
      [web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"app://local/engine/page.html"]]];
      NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
      while (!probe.done && deadline.timeIntervalSinceNow > 0) [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
      passed = passed && probe.done && probe.passed;
      web.navigationDelegate = nil; [web stopLoading];
    }
    [files removeItemAtPath:parent error:nil];
    if (!passed) return 1;
    puts("WKWebView assets: MIME, unknown paths, symlink/traversal refusal and optional isolation headers passed");
    return 0;
  }
}
