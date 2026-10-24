use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=HEIC_SPIKE_STATIC_VCRUNTIME");
    let target = env::var("TARGET").unwrap_or_default();

    // HEIC_SPIKE_STATIC_VCRUNTIME=1 mimics Tauri's default `build.windows.staticVCRuntime = true`
    // (tauri-build calls static_vcruntime::metabuild(): static libcmt + libvcruntime, dynamic UCRT).
    if env::var("HEIC_SPIKE_STATIC_VCRUNTIME").as_deref() == Ok("1") {
        static_vcruntime::metabuild();
    }

    // libde265's x86 SIMD dispatch (sse.cc) uses __builtin_cpu_supports(), which needs
    // ___cpu_model / ___cpu_indicator_init from clang's compiler-rt. rustc links Apple
    // targets with -nodefaultlibs, so add libclang_rt.osx.a explicitly.
    if target == "x86_64-apple-darwin" && env::var("CARGO_FEATURE_HEIC").is_ok() {
        let out = Command::new("xcrun")
            .args(["clang", "-print-resource-dir"])
            .output()
            .expect("xcrun clang -print-resource-dir");
        let dir = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        let rt = dir.join("lib/darwin/libclang_rt.osx.a");
        assert!(rt.exists(), "compiler-rt not found at {}", rt.display());
        println!("cargo:rustc-link-arg={}", rt.display());
    }
}
