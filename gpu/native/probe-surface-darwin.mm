// CAMetalLayer surface probe for ntgpu-probe (macOS). The layer is not attached to a window: this verifies surface
// creation, capability negotiation, configure, texture acquisition, a clear pass and present through webgpu.h. It
// does not prove on-screen composition, frame pacing or occlusion behaviour.
#include "ntgpu.h"

#import <QuartzCore/CAMetalLayer.h>

#include <cstdio>
#include <string>

static const char *SurfaceStatusName(WGPUSurfaceGetCurrentTextureStatus status) {
  switch (status) {
    case WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal: return "success-optimal";
    case WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal: return "success-suboptimal";
    case WGPUSurfaceGetCurrentTextureStatus_Timeout: return "timeout";
    case WGPUSurfaceGetCurrentTextureStatus_Outdated: return "outdated";
    case WGPUSurfaceGetCurrentTextureStatus_Lost: return "lost";
    case WGPUSurfaceGetCurrentTextureStatus_Error: return "error";
    default: return "other";
  }
}

extern "C" const char *ntgpu_probe_format_name(uint32_t format);

extern "C" int ntgpu_probe_surface(NtGpuContext *ctx, std::string *report) {
  @autoreleasepool {
    CAMetalLayer *layer = [CAMetalLayer layer];
    layer.drawableSize = CGSizeMake(64, 64);
    WGPUSurface surface = nullptr;
    char buf[512];
    if (ntgpu_surface_from_metal_layer(ctx, (__bridge void *)layer, &surface) != NTGPU_OK) {
      *report = "{\"ok\":false,\"error\":\"surface creation failed\"}";
      return 0;
    }
    WGPUTextureFormat format = WGPUTextureFormat_Undefined;
    NtGpuStatus st = ntgpu_surface_configure(ctx, surface, WGPUTextureFormat_Undefined, 64, 64, WGPUPresentMode_Fifo,
                                             WGPUCompositeAlphaMode_Auto, &format);
    if (st != NTGPU_OK) {
      std::snprintf(buf, sizeof buf, "{\"ok\":false,\"error\":\"configure: %s\"}", ntgpu_status_name(st));
      *report = buf;
      wgpuSurfaceRelease(surface);
      return 0;
    }
    int presented = 0;
    std::string statuses;
    const int kFrames = 3;
    for (int frame = 0; frame < kFrames; ++frame) {
      WGPUSurfaceTexture st_tex = WGPU_SURFACE_TEXTURE_INIT;
      wgpuSurfaceGetCurrentTexture(surface, &st_tex);
      if (!statuses.empty()) statuses += ",";
      statuses += std::string("\"") + SurfaceStatusName(st_tex.status) + "\"";
      if (st_tex.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
          st_tex.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
        if (st_tex.texture) wgpuTextureRelease(st_tex.texture);
        continue;
      }
      WGPUTextureView view = wgpuTextureCreateView(st_tex.texture, nullptr);
      WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
      color.view = view;
      color.loadOp = WGPULoadOp_Clear;
      color.storeOp = WGPUStoreOp_Store;
      color.clearValue = {0.0, 0.5, 1.0, 1.0};
      WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
      rp.colorAttachmentCount = 1;
      rp.colorAttachments = &color;
      WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(ntgpu_device(ctx), nullptr);
      WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
      wgpuRenderPassEncoderEnd(pass);
      wgpuRenderPassEncoderRelease(pass);
      WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
      wgpuCommandEncoderRelease(enc);
      wgpuQueueSubmit(ntgpu_queue(ctx), 1, &cmd);
      wgpuCommandBufferRelease(cmd);
      if (wgpuSurfacePresent(surface) == WGPUStatus_Success) ++presented;
      wgpuTextureViewRelease(view);
      wgpuTextureRelease(st_tex.texture);
    }
    wgpuSurfaceUnconfigure(surface);
    wgpuSurfaceRelease(surface);
    NtGpuEvent ev;
    int uncaptured = 0;
    while (ntgpu_next_event(ctx, &ev)) uncaptured += ev.kind == NTGPU_EVENT_UNCAPTURED_ERROR;
    std::snprintf(buf, sizeof buf,
                  "{\"layer\":\"CAMetalLayer (not in a window)\",\"format\":\"%s\",\"presentMode\":\"fifo\","
                  "\"frames\":%d,\"presented\":%d,\"uncapturedErrors\":%d,\"acquire\":[%s],"
                  "\"ok\":%s}",
                  ntgpu_probe_format_name(format), kFrames, presented, uncaptured, statuses.c_str(),
                  presented == kFrames && uncaptured == 0 ? "true" : "false");
    *report = buf;
    return presented == kFrames && uncaptured == 0;
  }
}
