fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.prod.json");
    println!("cargo:rerun-if-changed=Entitlements.plist");
    if let Ok(profile) = std::env::var("PROFILE") {
        if profile == "release" {
            if let Ok(content) = std::fs::read_to_string("tauri.conf.prod.json") {
                std::env::set_var("TAURI_CONFIG", content);
            }
        }
    }
    tauri_build::build()
}
