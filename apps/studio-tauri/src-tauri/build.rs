fn main() {
    let mut attrs = tauri_build::Attributes::new();
    // The loopback capability the bench driver needs exists only in test builds.
    if std::env::var_os("CARGO_FEATURE_WEBKIT_TESTS").is_some() {
        attrs = attrs.capabilities_path_pattern("./capabilities*/*");
    } else {
        attrs = attrs.capabilities_path_pattern("./capabilities/*");
    }
    tauri_build::try_build(attrs).expect("error while running tauri-build");
}
