#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#include <string>
#include "assets.generated.h"

static NSURL *assetRoot;
static NSString *assetEntry;
static BOOL isolationHeaders;

@interface NativetronAssets : NSObject <WKURLSchemeHandler>
@end

@implementation NativetronAssets
- (void)webView:(WKWebView *)view startURLSchemeTask:(id<WKURLSchemeTask>)task {
  (void)view;
  NSURL *url = task.request.URL;
  if (![url.host isEqualToString:@"local"] || ![url.scheme isEqualToString:@"app"]) {
    [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadURL userInfo:nil]];
    return;
  }
  NSString *path = url.path;
  if (!path.length || [path isEqualToString:@"/"]) path = assetEntry;
  while ([path hasPrefix:@"/"]) path = [path substringFromIndex:1];
  NSURL *file = [[assetRoot URLByAppendingPathComponent:path] URLByResolvingSymlinksInPath];
  NSString *prefix = [assetRoot.path stringByAppendingString:@"/"];
  const char *utf8 = path.UTF8String;
  const char *mime = utf8 ? nt_asset_mime(utf8) : nullptr;
  NSData *data = nil;
  if (mime && [file.path hasPrefix:prefix]) data = [NSData dataWithContentsOfURL:file options:NSDataReadingMappedIfSafe error:nil];
  NSMutableDictionary *headers = [@{@"Content-Type": mime ? [NSString stringWithUTF8String:mime] : @"text/plain", @"Access-Control-Allow-Origin": @"*", @"Cache-Control": @"no-store"} mutableCopy];
  if (isolationHeaders) {
    headers[@"Cross-Origin-Opener-Policy"] = @"same-origin";
    headers[@"Cross-Origin-Embedder-Policy"] = @"require-corp";
  }
  NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:data ? 200 : 404 HTTPVersion:@"HTTP/1.1" headerFields:headers];
  [task didReceiveResponse:response];
  if (data) [task didReceiveData:data];
  [task didFinish];
}
- (void)webView:(WKWebView *)view stopURLSchemeTask:(id<WKURLSchemeTask>)task {
  (void)view; (void)task;
}
@end

extern "C" int32_t nt_assets_configure(const uint8_t *root, size_t rootLength, const uint8_t *entry, size_t entryLength, int32_t isolated) {
  NSString *directory = [[NSString alloc] initWithBytes:root length:rootLength encoding:NSUTF8StringEncoding];
  NSString *page = [[NSString alloc] initWithBytes:entry length:entryLength encoding:NSUTF8StringEncoding];
  BOOL isDirectory = NO;
  if (!directory.length || !page.length || !nt_asset_mime(page.UTF8String) || ![[NSFileManager defaultManager] fileExistsAtPath:directory isDirectory:&isDirectory] || !isDirectory) return 0;
  assetRoot = [[[NSURL fileURLWithPath:directory isDirectory:YES] URLByResolvingSymlinksInPath] copy];
  assetEntry = [page copy];
  isolationHeaders = isolated != 0;
  return 1;
}

extern "C" void nt_assets_install(void *raw) {
  if (!assetRoot) return;
  WKWebViewConfiguration *configuration = (__bridge WKWebViewConfiguration *)raw;
  [configuration setURLSchemeHandler:[NativetronAssets new] forURLScheme:@"app"];
}

extern "C" const char *nt_assets_entry(void) {
  if (!assetRoot) return "about:blank";
  return [[@"app://local/" stringByAppendingString:assetEntry] UTF8String];
}
