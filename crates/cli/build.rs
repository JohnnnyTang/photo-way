// Statically link the VC runtime on Windows MSVC (same as Tauri's default), so the binary
// does not need the VC++ redistributable. Pairs with the /MT vcpkg triplet for libheif.
fn main() {
    static_vcruntime::metabuild();
}
