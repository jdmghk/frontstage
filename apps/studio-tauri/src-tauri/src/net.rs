//! HTTP clients and the SSRF guard. Port of index.cjs's isAllowedImportHost, isPrivateAddress,
//! checkHostResolution, validateImportTarget, createPinnedDispatcher.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

use ureq::config::Config;
use ureq::http::Uri;
use ureq::tls::{TlsConfig, TlsProvider};
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};
use ureq::Agent;
use url::Url;

fn base_config() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    Agent::config_builder().http_status_as_error(false).tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).build()).user_agent("Frontstage")
}

/// For provider APIs with fixed hosts. Follows redirects like fetch, and drops auth on the way.
pub fn agent(timeout: Option<Duration>) -> Agent {
    base_config().timeout_global(timeout).build().into()
}

// ── Syntax ──────────────────────────────────────────────────────────────────

/// Fast pre-filter for a general https origin: no credentials, not localhost, not a literal IP.
/// Doesn't stop DNS rebinding by itself; `validate_target` does.
pub fn is_allowed_import_host(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = host.to_ascii_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") {
        return false;
    }
    // url::Url has already normalised decimal, hex and octal IPv4 spellings into dotted form.
    if matches!(url.host(), Some(url::Host::Ipv4(_) | url::Host::Ipv6(_))) {
        return false;
    }
    true
}

// ── Private ranges ──────────────────────────────────────────────────────────

pub fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 0                                   // 0.0.0.0/8
        || a == 127                          // loopback
        || a == 10                           // 10.0.0.0/8
        || (a == 172 && (16..=31).contains(&b)) // 172.16.0.0/12
        || (a == 192 && b == 168)            // 192.168.0.0/16
        || (a == 169 && b == 254)            // link-local, incl. cloud metadata
        || (a == 100 && (64..=127).contains(&b)) // CGNAT
        || (a == 192 && b == 0 && c == 0)    // IETF protocol assignments
        || (a == 198 && (18..=19).contains(&b)) // benchmarking
        || a >= 224                          // multicast and reserved
}

pub fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    let g = ip.segments();
    if g[..5] == [0; 5] && g[5] == 0xffff {
        let o = ip.octets();
        return is_private_ipv4(Ipv4Addr::new(o[12], o[13], o[14], o[15]));
    }
    let o = ip.octets();
    // NAT64 and 6to4 reach the IPv4 address they embed.
    if g[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_private_ipv4(Ipv4Addr::new(o[12], o[13], o[14], o[15]));
    }
    if g[0] == 0x2002 {
        return is_private_ipv4(Ipv4Addr::new(o[2], o[3], o[4], o[5]));
    }
    g[..6] == [0; 6] // includes :: and ::1; the rest is deprecated IPv4-compatible
        || (g[0] & 0xfe00) == 0xfc00 // unique local
        || (g[0] & 0xffc0) == 0xfe80 // link-local
        || (g[0] & 0xffc0) == 0xfec0 // deprecated site-local
        || (g[0] & 0xff00) == 0xff00 // multicast
}

pub fn is_private_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_ipv4(v4),
        IpAddr::V6(v6) => is_private_ipv6(v6),
    }
}

// ── Resolution and pinning ──────────────────────────────────────────────────

/// DNS and dialing, so tests can answer lookups themselves. Production is `SystemNet`.
pub trait Net: Send + Sync {
    fn lookup(&self, host: &str) -> std::io::Result<Vec<IpAddr>>;
    /// The socket actually connected to. Tests map a public-looking pin onto the mock server here.
    fn dial(&self, pinned: SocketAddr) -> SocketAddr {
        pinned
    }
    /// Tests only, since a local TLS server would add a whole stack just for this.
    fn allow_plain_http(&self) -> bool {
        false
    }
    /// Connection settings for the pinned agent.
    fn agent(&self, addr: SocketAddr, timeout: Option<Duration>) -> Agent {
        pinned_agent(addr, timeout)
    }
}

pub struct SystemNet;

impl Net for SystemNet {
    fn lookup(&self, host: &str) -> std::io::Result<Vec<IpAddr>> {
        Ok((host, 443u16).to_socket_addrs()?.map(|a| a.ip()).collect())
    }
}

/// Rejects if ANY returned address is private. DNS failure also denies.
pub fn check_host_resolution(net: &dyn Net, host: &str) -> Option<Vec<IpAddr>> {
    let addrs = net.lookup(host).ok()?;
    if addrs.is_empty() || addrs.iter().any(|a| is_private_address(*a)) {
        return None;
    }
    Some(addrs)
}

/// Syntax + resolution + private-range check; returns the address to pin the connection to.
pub fn validate_target(net: &dyn Net, url: &Url) -> Option<SocketAddr> {
    let syntax_ok = if net.allow_plain_http() && url.scheme() == "http" {
        let mut as_https = url.clone();
        as_https.set_scheme("https").ok()?;
        is_allowed_import_host(&as_https)
    } else {
        is_allowed_import_host(url)
    };
    if !syntax_ok {
        return None;
    }
    let host = url.host_str()?;
    let addrs = check_host_resolution(net, host)?;
    let port = url.port_or_known_default()?;
    Some(SocketAddr::new(*addrs.first()?, port))
}

/// Answers every lookup with the validated address, closing the gap between the check and connect.
/// TLS still verifies the certificate against the URL's hostname.
#[derive(Clone, Copy)]
struct PinnedResolver(SocketAddr);

impl fmt::Debug for PinnedResolver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PinnedResolver({})", self.0)
    }
}

impl Resolver for PinnedResolver {
    fn resolve(&self, _uri: &Uri, _config: &Config, _timeout: NextTimeout) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut out = self.empty();
        out.push(self.0);
        Ok(out)
    }
}

fn pinned_agent(addr: SocketAddr, timeout: Option<Duration>) -> Agent {
    Agent::with_parts(base_config().timeout_global(timeout).max_redirects(0).build(), DefaultConnector::default(), PinnedResolver(addr))
}

pub enum GuardedError {
    /// The URL or a redirect failed validation. `redirect` picks the message.
    HostNotAllowed { redirect: bool },
    TooManyRedirects,
    Http(ureq::Error),
    BadLocation,
}

impl GuardedError {
    pub fn message(&self) -> String {
        match self {
            GuardedError::HostNotAllowed { redirect: false } => "url host not allowed".into(),
            GuardedError::HostNotAllowed { redirect: true } => "redirect host not allowed".into(),
            GuardedError::TooManyRedirects => "too many redirects".into(),
            GuardedError::Http(e) => e.to_string(),
            GuardedError::BadLocation => "invalid redirect location".into(),
        }
    }
}

/// GET with every hop re-resolved, re-validated and re-pinned. Follows up to 3 redirects.
pub fn guarded_get(net: &dyn Net, start: &Url, timeout: Option<Duration>) -> Result<ureq::http::Response<ureq::Body>, GuardedError> {
    let mut pin = validate_target(net, start).ok_or(GuardedError::HostNotAllowed { redirect: false })?;
    let mut target = start.clone();
    let mut hop = 0;
    loop {
        let agent = net.agent(net.dial(pin), timeout);
        let res = agent.get(target.as_str()).call().map_err(GuardedError::Http)?;
        let status = res.status().as_u16();
        if !(300..400).contains(&status) {
            return Ok(res);
        }
        let Some(loc) = res.headers().get("location").and_then(|l| l.to_str().ok()) else {
            // Electron's loop breaks on a redirect with no Location, then fails it as too many.
            return Err(GuardedError::TooManyRedirects);
        };
        if hop == 3 {
            return Err(GuardedError::TooManyRedirects);
        }
        let next = target.join(loc).map_err(|_| GuardedError::BadLocation)?;
        pin = validate_target(net, &next).ok_or(GuardedError::HostNotAllowed { redirect: true })?;
        target = next;
        hop += 1;
    }
}

const DOWNLOAD_CAP: u64 = 5 * 1024 * 1024 * 1024;

/// Provider result downloads (fal, Morphic). Electron had no guard on these; the URLs come through
/// the renderer, so they now get the same one.
pub fn guarded_download(net: &dyn Net, url: &str) -> Result<Vec<u8>, String> {
    let parsed = Url::parse(url).map_err(|_| "invalid url".to_string())?;
    let mut res = guarded_get(net, &parsed, Some(Duration::from_secs(15 * 60))).map_err(|e| e.message())?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        let text = res.body_mut().read_to_string().unwrap_or_default();
        return Err(format!("{status} {text}"));
    }
    res.body_mut().with_config().limit(DOWNLOAD_CAP).read_to_vec().map_err(|e| e.to_string())
}

/// Streams a guarded GET to `dest`, through a .part file that any failure removes.
pub fn download_to_file(net: &dyn Net, url: &str, dest: &Path, cap: u64, timeout: Duration) -> Result<u64, String> {
    let target = Url::parse(url).map_err(|_| "invalid url".to_string())?;
    let mut res = guarded_get(net, &target, Some(timeout)).map_err(|e| e.message())?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("server returned HTTP {status}"));
    }
    if res.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).is_some_and(|n| n > cap) {
        return Err("remote file exceeds the size cap".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = std::path::PathBuf::from(part);
    let result = (|| {
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut reader = res.body_mut().as_reader();
        let mut buf = vec![0u8; 256 * 1024];
        let mut total = 0u64;
        loop {
            let n = std::io::Read::read(&mut reader, &mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > cap {
                return Err("remote file exceeds the size cap".to_string());
            }
            std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| e.to_string())?;
        }
        Ok(total)
    })();
    match result {
        Ok(total) => match std::fs::rename(&part, dest) {
            Ok(()) => Ok(total),
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                Err(e.to_string())
            }
        },
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::util::testutil::{mock, Reply, TempDir};
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A fake DNS. "public" names answer with a public-looking IP which `dial` sends to the mock.
    pub struct FakeNet {
        pub dns: HashMap<String, Vec<IpAddr>>,
        pub mock_port: u16,
        pub lookups: Mutex<Vec<String>>,
        pub dialed: Mutex<Vec<SocketAddr>>,
    }

    impl FakeNet {
        pub fn new(mock_port: u16, dns: &[(&str, &[&str])]) -> Self {
            FakeNet {
                dns: dns.iter().map(|(h, ips)| (h.to_string(), ips.iter().map(|i| i.parse().unwrap()).collect())).collect(),
                mock_port,
                lookups: Mutex::new(vec![]),
                dialed: Mutex::new(vec![]),
            }
        }
    }

    impl Net for FakeNet {
        fn lookup(&self, host: &str) -> std::io::Result<Vec<IpAddr>> {
            self.lookups.lock().unwrap().push(host.to_string());
            self.dns.get(host).cloned().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "NXDOMAIN"))
        }
        fn dial(&self, pinned: SocketAddr) -> SocketAddr {
            self.dialed.lock().unwrap().push(pinned);
            SocketAddr::new("127.0.0.1".parse().unwrap(), self.mock_port)
        }
        fn allow_plain_http(&self) -> bool {
            true
        }
    }

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn syntax_filter_denies_non_https_credentials_localhost_and_literal_ips() {
        for bad in [
            "http://example.com/a.mp4",
            "ftp://example.com/a.mp4",
            "file:///etc/passwd",
            "https://user:pw@example.com/a.mp4",
            "https://user@example.com/a.mp4",
            "https://localhost/a.mp4",
            "https://LOCALHOST/a.mp4",
            "https://foo.localhost/a.mp4",
            "https://127.0.0.1/a.mp4",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/a.mp4",
            "https://[fe80::1]/a.mp4",
            // Other spellings of 127.0.0.1, which the URL parser normalises to an IPv4 host.
            "https://2130706433/a.mp4",
            "https://0x7f.0.0.1/a.mp4",
            "https://0177.0.0.1/a.mp4",
            "https://127.1/a.mp4",
        ] {
            assert!(!is_allowed_import_host(&u(bad)), "{bad}");
        }
        assert!(is_allowed_import_host(&u("https://cdn.example.com/a.mp4")));
    }

    #[test]
    fn every_private_ipv4_range_is_caught_at_its_edges() {
        for bad in [
            "0.0.0.0", "0.255.255.255", "127.0.0.1", "127.255.255.255", "10.0.0.0", "10.255.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.255",
            "169.254.0.0", "169.254.169.254", "169.254.255.255", "100.64.0.0", "100.127.255.255",
            "192.0.0.1", "198.18.0.0", "198.19.255.255", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
        ] {
            assert!(is_private_address(bad.parse().unwrap()), "{bad}");
        }
        for ok in ["1.1.1.1", "9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "169.253.255.255", "169.255.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0", "8.8.8.8"] {
            assert!(!is_private_address(ok.parse().unwrap()), "{ok}");
        }
    }

    #[test]
    fn every_private_ipv6_range_is_caught_including_mapped_ipv4() {
        for bad in [
            "::", "::1", "::2", "::7f00:1", "fc00::1", "fdff:ffff::1", "fe80::1", "febf::1", "fec0::1", "ff02::1",
            "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2002:a9fe:a9fe::1",
            "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:192.168.1.1", "::ffff:172.16.0.1", "::ffff:100.64.0.1", "::ffff:0.0.0.0", "::ffff:7f00:1",
        ] {
            assert!(is_private_address(bad.parse().unwrap()), "{bad}");
        }
        for ok in ["2606:4700:4700::1111", "fbff::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"] {
            assert!(!is_private_address(ok.parse().unwrap()), "{ok}");
        }
    }

    #[test]
    fn resolution_denies_a_private_answer_any_private_answer_no_answer_and_dns_failure() {
        let net = FakeNet::new(0, &[("meta.evil", &["169.254.169.254"]), ("mixed.evil", &["93.184.216.34", "127.0.0.1"]), ("empty.evil", &[]), ("ok.example", &["93.184.216.34"])]);
        assert!(check_host_resolution(&net, "meta.evil").is_none());
        assert!(check_host_resolution(&net, "mixed.evil").is_none());
        assert!(check_host_resolution(&net, "empty.evil").is_none());
        assert!(check_host_resolution(&net, "nxdomain.evil").is_none());
        assert!(check_host_resolution(&net, "ok.example").is_some());
        assert!(validate_target(&net, &u("https://mixed.evil/a")).is_none());
        assert_eq!(validate_target(&net, &u("https://ok.example:8443/a")).unwrap().to_string(), "93.184.216.34:8443");
    }

    #[test]
    fn production_net_never_accepts_plain_http() {
        // No network: refused before any lookup.
        assert!(validate_target(&SystemNet, &u("http://example.com/a")).is_none());
        assert!(!SystemNet.allow_plain_http());
    }

    #[test]
    fn a_rebinding_host_connects_to_the_pinned_address_with_one_lookup() {
        let m = mock(|_| Reply::new(200, "body"));
        let net = FakeNet::new(m.port, &[("rebind.example", &["93.184.216.34"])]);
        let mut res = guarded_get(&net, &u("http://rebind.example/a"), None).map_err(|e| e.message()).unwrap();
        assert_eq!(res.body_mut().read_to_string().unwrap(), "body");
        // The name was never looked up again at connect time.
        assert_eq!(*net.lookups.lock().unwrap(), ["rebind.example"]);
        assert_eq!(net.dialed.lock().unwrap()[0].to_string(), "93.184.216.34:80");
        // The Host header stayed the original name, so TLS and vhosts see the right host.
        assert_eq!(m.seen()[0].header("host").unwrap(), "rebind.example");
    }

    #[test]
    fn a_redirect_to_a_private_host_is_refused_before_connecting() {
        let m = mock(|_| Reply::new(302, "").with("location", "http://internal.evil/secret"));
        let net = FakeNet::new(m.port, &[("start.example", &["93.184.216.34"]), ("internal.evil", &["10.0.0.5"])]);
        let e = guarded_get(&net, &u("http://start.example/a"), None).err().unwrap();
        assert_eq!(e.message(), "redirect host not allowed");
        assert_eq!(m.seen().len(), 1);
        assert_eq!(net.dialed.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_redirect_to_a_literal_ip_localhost_or_credentials_is_refused() {
        for loc in ["http://127.0.0.1/x", "http://169.254.169.254/x", "http://localhost/x", "http://u:p@other.example/x", "file:///etc/passwd", "ftp://other.example/x"] {
            let target = loc.to_string();
            let m = mock(move |_| Reply::new(302, "").with("location", &target));
            let net = FakeNet::new(m.port, &[("start.example", &["93.184.216.34"]), ("other.example", &["93.184.216.35"])]);
            let e = guarded_get(&net, &u("http://start.example/a"), None).err().unwrap();
            assert_eq!(e.message(), "redirect host not allowed", "{loc}");
            assert_eq!(m.seen().len(), 1);
        }
    }

    #[test]
    fn redirect_hops_are_each_revalidated_and_repinned_then_capped_at_three() {
        let m = mock(|s| match s.url.as_str() {
            "/1" => Reply::new(302, "").with("location", "http://b.example/2"),
            "/2" => Reply::new(301, "").with("location", "/3"),
            "/3" => Reply::new(200, "done"),
            _ => Reply::new(404, ""),
        });
        let net = FakeNet::new(m.port, &[("a.example", &["93.184.216.1"]), ("b.example", &["93.184.216.2"])]);
        let mut res = guarded_get(&net, &u("http://a.example/1"), None).map_err(|e| e.message()).unwrap();
        assert_eq!(res.body_mut().read_to_string().unwrap(), "done");
        assert_eq!(*net.lookups.lock().unwrap(), ["a.example", "b.example", "b.example"]);
        let dialed: Vec<String> = net.dialed.lock().unwrap().iter().map(|a| a.to_string()).collect();
        assert_eq!(dialed, ["93.184.216.1:80", "93.184.216.2:80", "93.184.216.2:80"]);

        let m = mock(|_| Reply::new(302, "").with("location", "/again"));
        let net = FakeNet::new(m.port, &[("a.example", &["93.184.216.1"])]);
        assert_eq!(guarded_get(&net, &u("http://a.example/x"), None).err().unwrap().message(), "too many redirects");
        assert_eq!(m.seen().len(), 4);
    }

    #[test]
    fn downloads_leave_no_part_file_on_failure_and_rename_on_success() {
        let d = TempDir::new("dl");
        let dest = d.path().join("media/a.mp4");
        let m = mock(|s| match s.url.as_str() {
            "/ok" => Reply::new(200, vec![1u8; 100]),
            "/big" => Reply::new(200, vec![1u8; 2048]),
            _ => Reply::new(500, "nope"),
        });
        let net = FakeNet::new(m.port, &[("a.example", &["93.184.216.1"])]);
        let t = Duration::from_secs(10);
        assert_eq!(download_to_file(&net, "http://a.example/fail", &dest, 1000, t).unwrap_err(), "server returned HTTP 500");
        assert_eq!(download_to_file(&net, "http://a.example/big", &dest, 1000, t).unwrap_err(), "remote file exceeds the size cap");
        assert!(!dest.exists());
        assert!(!d.path().join("media/a.mp4.part").exists());
        assert_eq!(download_to_file(&net, "http://a.example/ok", &dest, 1000, t).unwrap(), 100);
        assert_eq!(std::fs::read(&dest).unwrap().len(), 100);
        assert!(!d.path().join("media/a.mp4.part").exists());
    }

    #[test]
    fn provider_downloads_return_the_bytes_and_report_http_errors() {
        let m = mock(|s| if s.url == "/ok" { Reply::new(200, vec![7u8; 11]) } else { Reply::new(403, "denied") });
        let net = FakeNet::new(m.port, &[("a.example", &["93.184.216.1"])]);
        assert_eq!(guarded_download(&net, "http://a.example/ok").unwrap(), vec![7u8; 11]);
        assert_eq!(guarded_download(&net, "http://a.example/no").unwrap_err(), "403 denied");
    }

    #[test]
    fn provider_downloads_are_refused_for_internal_targets() {
        let net = FakeNet::new(1, &[("internal.evil", &["192.168.1.1"])]);
        assert_eq!(guarded_download(&net, "http://internal.evil/x").unwrap_err(), "url host not allowed");
        assert_eq!(guarded_download(&SystemNet, "https://169.254.169.254/latest/").unwrap_err(), "url host not allowed");
        assert_eq!(guarded_download(&SystemNet, "not a url").unwrap_err(), "invalid url");
    }
}
