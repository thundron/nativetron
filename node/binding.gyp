{
  "targets": [
    {
      "target_name": "nativetron",
      "sources": ["addon.cc", "../native/nativetron_core.cc"],
      "include_dirs": ["../native/vendor/webview/include"],
      "cflags_cc": ["-std=c++17"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CPLUSPLUSFLAGS": ["-Wno-unused-parameter"]
          },
          "link_settings": {
            "libraries": ["-framework WebKit", "-framework Cocoa"]
          }
        }]
      ]
    }
  ]
}
