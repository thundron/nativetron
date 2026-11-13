// Window-less CAMetalLayer for ntgpu-executor-driver --metal-layer: exercises the executor's surface path (configure,
// acquire, present, reconfigure on resize). It proves nothing about on-screen composition or pacing.
#import <QuartzCore/CAMetalLayer.h>

#include <cstdint>

extern "C" void *ntgpu_executor_driver_layer(uint32_t width, uint32_t height) {
  @autoreleasepool {
    CAMetalLayer *layer = [CAMetalLayer layer];
    layer.drawableSize = CGSizeMake(width, height);
    return (void *)CFBridgingRetain(layer);
  }
}

extern "C" void ntgpu_executor_driver_layer_release(void *layer) {
  if (layer) CFRelease(layer);
}
