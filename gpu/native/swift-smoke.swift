// Swift host smoke test: the facade imports as a Clang module and drives a CAMetalLayer surface from Swift.
import NtGpu
import QuartzCore

func check(_ ok: Bool, _ what: String) {
  if !ok { FileHandle.standardError.write("swift-smoke: \(what) failed\n".data(using: .utf8)!); exit(1) }
}

var options = NtGpuContextOptions()
options.api_version = NTGPU_API_VERSION
var ctx: OpaquePointer?
check(ntgpu_context_create(&options, &ctx) == NTGPU_OK, "context")
defer { ntgpu_context_destroy(ctx) }
check(ntgpu_request_adapter(ctx, 1, WGPUPowerPreference_LowPower) == NTGPU_OK, "adapter")
check(ntgpu_request_device(ctx, 2, nil, 0, nil) == NTGPU_OK, "device")
var caps = NtGpuCapabilities()
check(ntgpu_device_capabilities(ctx, &caps) == NTGPU_OK, "capabilities")
check(caps.limits.maxStorageBuffersPerShaderStage == 8, "default limits")
var event = NtGpuEvent()
var kinds: [UInt32] = []
while ntgpu_next_event(ctx, &event) != 0 { kinds.append(event.kind) }
check(kinds == [NTGPU_EVENT_ADAPTER.rawValue, NTGPU_EVENT_DEVICE.rawValue], "events \(kinds)")
let layer = CAMetalLayer()
layer.drawableSize = CGSize(width: 32, height: 32)
var surface: WGPUSurface?
check(ntgpu_surface_from_metal_layer(ctx, Unmanaged.passUnretained(layer).toOpaque(), &surface) == NTGPU_OK, "surface")
var format = WGPUTextureFormat_Undefined
check(ntgpu_surface_configure(ctx, surface, WGPUTextureFormat_Undefined, 32, 32, WGPUPresentMode_Fifo,
                              WGPUCompositeAlphaMode_Auto, &format) == NTGPU_OK, "configure")
wgpuSurfaceUnconfigure(surface)
wgpuSurfaceRelease(surface)
print("swift-smoke: \(String(cString: caps.device)) \(String(cString: ntgpu_backend_name(caps.backend))) format \(format.rawValue)")
