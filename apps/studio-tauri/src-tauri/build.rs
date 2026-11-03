fn main() {
    // A release build embeds whatever is in dist. Refuse a bundle that still has the test pages.
    let test_build = std::env::var_os("CARGO_FEATURE_WEBKIT_TESTS").is_some();
    if !test_build && std::env::var("PROFILE").as_deref() == Ok("release") && std::path::Path::new("../dist/phase1.html").exists() {
        panic!("dist has the test pages: run `pnpm build:web` without VITE_TEST_PAGES before a release build");
    }
    println!("cargo:rerun-if-changed=../dist/phase1.html");
    let mut attrs = tauri_build::Attributes::new();
    // The loopback capability the bench driver needs exists only in test builds.
    if std::env::var_os("CARGO_FEATURE_WEBKIT_TESTS").is_some() {
        attrs = attrs.capabilities_path_pattern("./capabilities*/*");
    } else {
        attrs = attrs.capabilities_path_pattern("./capabilities/*");
    }
    tauri_build::try_build(attrs).expect("error while running tauri-build");
}
