//! Link fix for x86_64-apple-darwin + libheif (see docs/spikes/S1-heic.md).
//!
//! libde265's x86 SIMD dispatch uses `__builtin_cpu_supports`, which needs `___cpu_model` and
//! `___cpu_indicator_init` from clang's compiler-rt. rustc links Apple targets with
//! `-nodefaultlibs`, so the static compiler-rt has to be requested explicitly. This lives in a
//! library crate, where `rustc-link-arg` would not reach the final binary; `rustc-link-search`
//! and `rustc-link-lib` do propagate.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target = env::var("TARGET").unwrap_or_default();
    // The /MT vcpkg libs meet the default /MD Rust CRT in core's own test and bench binaries
    // (the CLI and app link the static VC runtime instead). The mix works; silence the notice.
    if target.ends_with("windows-msvc") && env::var("CARGO_FEATURE_HEIC").is_ok() {
        println!("cargo:rustc-link-arg-tests=/IGNORE:4098");
        println!("cargo:rustc-link-arg-benches=/IGNORE:4098");
    }
    if target == "x86_64-apple-darwin" && env::var("CARGO_FEATURE_HEIC").is_ok() {
        let out = Command::new("xcrun")
            .args(["clang", "-print-resource-dir"])
            .output()
            .expect("xcrun clang -print-resource-dir");
        let dir = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()).join("lib/darwin");
        assert!(
            dir.join("libclang_rt.osx.a").exists(),
            "compiler-rt not found in {}",
            dir.display()
        );
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
