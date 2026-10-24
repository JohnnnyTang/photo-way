# Static libs, dynamic CRT (/MD, matches Rust's default MSVC target), release only.
# Name must contain "-static" so the vcpkg crate links it statically.
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_BUILD_TYPE release)
