# Patched wgpu-native build

The pinned variant carries two generic Naga fixes: WGSL behavior analysis for valid non-void function termination, and runtime semantics for let-bound override expressions. Consumer shaders are not rewritten. The patches and regression fixtures live here; dependency revisions and hashes are in `wgpu-native-patched.lock`.

```sh
gpu/native/compiler/build-patched-wgpu.sh
gpu/native/compiler/build-patched-wgpu.sh --offline
gpu/native/fetch-deps.sh --variant patched
NTGPU_WGPU_VARIANT=patched node gpu/native/compiler/compiler.test.mjs
node gpu/native/compiler/corpus/corpus.mjs --wgpu patched --corpus /path/to/captured-corpus
```

The builder prints the verified dependency prefix. `--offline` verifies cached artifacts without downloading. Keep the matching headers/library, provenance, notices and patch hashes together. Compiler-only and corpus tests do not establish renderer performance or cross-platform support.

Corpus replay needs captured modules, entry points, constants and layouts; fixtures are not copied from application repositories into this project. Keep captures and results outside the source tree. Translation, Metal compilation, pipeline creation and actual rendering are separate checks.
