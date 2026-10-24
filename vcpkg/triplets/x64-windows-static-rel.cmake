# Static libs AND static CRT (/MT), release only. Use with Rust `+crt-static`
# or with Tauri's default static VC runtime (static_vcruntime: libcmt + libvcruntime
# static, UCRT dynamic). Avoids a runtime dependency on MSVCP140.dll from libheif's C++.
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE static)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_BUILD_TYPE release)
