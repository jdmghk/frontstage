//! Provider API keys and Morphic tokens, in the macOS Keychain or Windows Credential Manager. They
//! never reach the renderer.
//!
//! Electron's safeStorage files are encrypted with Electron's own Keychain item and can't be read
//! here, so those users re-enter keys. `legacy_secrets_present` only looks at whether the old files
//! exist; it never opens them.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

/// Windows Credential Manager blobs top out at 2560 bytes (1280 UTF-16 units) and OAuth tokens can
/// be longer, so long values are stored in numbered parts on every platform.
const CHUNK_CHARS: usize = 1000;
const CHUNKED_PREFIX: &str = "frontstage-chunks:";

pub const SERVICE: &str = "studio.frontstage.tauri";

pub trait RawStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

pub struct SecretStore {
    raw: Box<dyn RawStore>,
}

impl SecretStore {
    pub fn new(raw: Box<dyn RawStore>) -> Self {
        SecretStore { raw }
    }

    pub fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.delete(account)?;
        let chars: Vec<char> = value.chars().collect();
        if chars.len() <= CHUNK_CHARS && !value.starts_with(CHUNKED_PREFIX) {
            return self.raw.set(account, value);
        }
        let parts: Vec<String> = chars.chunks(CHUNK_CHARS).map(|c| c.iter().collect()).collect();
        for (i, p) in parts.iter().enumerate() {
            self.raw.set(&format!("{account}#{i}"), p)?;
        }
        self.raw.set(account, &format!("{CHUNKED_PREFIX}{}", parts.len()))
    }

    pub fn get(&self, account: &str) -> Result<Option<String>, String> {
        let Some(head) = self.raw.get(account)? else { return Ok(None) };
        let Some(n) = head.strip_prefix(CHUNKED_PREFIX) else { return Ok(Some(head)) };
        let n: usize = n.parse().map_err(|_| "corrupt secret".to_string())?;
        let mut out = String::new();
        for i in 0..n {
            out.push_str(&self.raw.get(&format!("{account}#{i}"))?.ok_or("corrupt secret: a part is missing")?);
        }
        Ok(Some(out))
    }

    pub fn has(&self, account: &str) -> bool {
        // A locked or unavailable store reads as "no key", which leads to the key entry field.
        matches!(self.raw.get(account), Ok(Some(_)))
    }

    pub fn delete(&self, account: &str) -> Result<(), String> {
        if let Ok(Some(head)) = self.raw.get(account) {
            if let Some(n) = head.strip_prefix(CHUNKED_PREFIX).and_then(|n| n.parse::<usize>().ok()) {
                for i in 0..n {
                    let _ = self.raw.delete(&format!("{account}#{i}"));
                }
            }
        }
        self.raw.delete(account)
    }
}

#[cfg(any(target_os = "macos", windows))]
pub struct OsStore {
    service: String,
}

#[cfg(any(target_os = "macos", windows))]
impl OsStore {
    pub fn new(service: impl Into<String>) -> Self {
        OsStore { service: service.into() }
    }
    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, account).map_err(|e| e.to_string())
    }
}

#[cfg(any(target_os = "macos", windows))]
impl RawStore for OsStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match self.entry(account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("couldn't read from the system keychain: {e}")),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.entry(account)?.set_password(value).map_err(|e| format!("couldn't save to the system keychain: {e}"))
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("couldn't delete from the system keychain: {e}")),
        }
    }
}

/// Linux isn't a target of this migration. Saving fails clearly rather than storing nothing.
#[cfg(not(any(target_os = "macos", windows)))]
pub struct OsStore;

#[cfg(not(any(target_os = "macos", windows)))]
impl OsStore {
    pub fn new(_service: impl Into<String>) -> Self {
        OsStore
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
impl RawStore for OsStore {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    fn set(&self, _account: &str, _value: &str) -> Result<(), String> {
        Err("secure key storage isn't available on this OS yet".into())
    }
    fn delete(&self, _account: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Used by unit tests that don't exercise the OS store, and by the smoke run.
#[derive(Default)]
pub struct MemoryStore(pub Mutex<HashMap<String, String>>);

impl RawStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

/// Unknown or missing providers fall back to openrouter, as Electron's keyFiles did.
pub fn provider_account(provider: Option<&str>) -> &'static str {
    match provider {
        Some("fal") => "fal-key",
        Some("anthropic") => "anthropic-key",
        _ => "openrouter-key",
    }
}

pub const MORPHIC_ACCOUNT: &str = "morphic-tokens";

/// Whether the Electron app left encrypted keys or tokens behind. Existence only.
pub fn legacy_secrets_present(electron_user_data: &Path) -> bool {
    ["openrouter-key.bin", "fal-key.bin", "anthropic-key.bin", "morphic-tokens.bin"].iter().any(|f| electron_user_data.join(f).exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;

    fn mem() -> SecretStore {
        SecretStore::new(Box::new(MemoryStore::default()))
    }

    #[test]
    fn set_get_has_delete_round_trip() {
        let s = mem();
        assert!(!s.has("a"));
        assert_eq!(s.get("a").unwrap(), None);
        s.set("a", "k").unwrap();
        assert!(s.has("a"));
        assert_eq!(s.get("a").unwrap().unwrap(), "k");
        s.delete("a").unwrap();
        assert!(!s.has("a"));
        s.delete("a").unwrap();
    }

    #[test]
    fn long_values_split_into_parts_small_enough_for_windows_and_reassemble() {
        let raw = std::sync::Arc::new(MemoryStore::default());
        struct Shared(std::sync::Arc<MemoryStore>);
        impl RawStore for Shared {
            fn get(&self, a: &str) -> Result<Option<String>, String> { self.0.get(a) }
            fn set(&self, a: &str, v: &str) -> Result<(), String> { self.0.set(a, v) }
            fn delete(&self, a: &str) -> Result<(), String> { self.0.delete(a) }
        }
        let s = SecretStore::new(Box::new(Shared(raw.clone())));
        let long: String = "tökén".repeat(1000);
        s.set("t", &long).unwrap();
        assert_eq!(s.get("t").unwrap().unwrap(), long);
        for v in raw.0.lock().unwrap().values() {
            assert!(v.encode_utf16().count() * 2 <= 2560, "part of {} UTF-16 units", v.encode_utf16().count());
        }
        // Replacing with something short leaves no parts behind.
        s.set("t", "short").unwrap();
        assert_eq!(raw.0.lock().unwrap().len(), 1);
        s.delete("t").unwrap();
        assert!(raw.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_missing_part_is_an_error_not_a_truncated_secret() {
        let s = mem();
        s.raw.set("t", "frontstage-chunks:2").unwrap();
        s.raw.set("t#0", "a").unwrap();
        assert!(s.get("t").is_err());
    }

    #[test]
    fn providers_map_to_their_own_accounts() {
        assert_eq!(provider_account(None), "openrouter-key");
        assert_eq!(provider_account(Some("openrouter")), "openrouter-key");
        assert_eq!(provider_account(Some("fal")), "fal-key");
        assert_eq!(provider_account(Some("anthropic")), "anthropic-key");
        assert_eq!(provider_account(Some("../evil")), "openrouter-key");
    }

    #[test]
    fn legacy_detection_only_needs_the_file_to_exist() {
        let d = TempDir::new("legacy");
        assert!(!legacy_secrets_present(d.path()));
        // Garbage content: the check must not depend on reading or decrypting it.
        std::fs::write(d.path().join("fal-key.bin"), [0xff, 0x00]).unwrap();
        assert!(legacy_secrets_present(d.path()));
    }

    // A real Keychain round trip, under a service name only this test uses. Removes what it adds.
    #[cfg(target_os = "macos")]
    #[test]
    fn real_keychain_round_trip_under_a_test_only_service() {
        let service = format!("studio.frontstage.cargo-test.{}", uuid::Uuid::new_v4());
        let s = SecretStore::new(Box::new(OsStore::new(service)));
        let account = "unit-test-key";
        assert!(!s.has(account));
        s.set(account, "value-1").unwrap();
        assert_eq!(s.get(account).unwrap().unwrap(), "value-1");
        s.set(account, "value-2").unwrap();
        assert_eq!(s.get(account).unwrap().unwrap(), "value-2");
        let long = "x".repeat(3500);
        s.set(account, &long).unwrap();
        assert_eq!(s.get(account).unwrap().unwrap(), long);
        s.delete(account).unwrap();
        assert!(!s.has(account));
        assert_eq!(s.get(&format!("{account}#0")).unwrap(), None);
    }
}
