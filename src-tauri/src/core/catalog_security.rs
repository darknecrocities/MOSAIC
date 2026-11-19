use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::Url;

pub const MAX_CATALOG_BYTES: usize = 2 * 1024 * 1024;

fn is_non_public_v4(v4: Ipv4Addr) -> bool {
    let [a, b, _, _] = v4.octets();
    let is_cgnat = a == 100 && (b & 0xc0) == 64;
    let is_benchmark = a == 198 && (b == 18 || b == 19);
    let is_reserved = a >= 240;
    let is_ietf_prot = a == 192 && b == 0 && v4.octets()[2] == 0;
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || v4.is_documentation()
        || is_cgnat
        || is_benchmark
        || is_ietf_prot
        || is_reserved
}

fn is_non_public_v6(v6: Ipv6Addr) -> bool {
    let seg0 = v6.segments()[0];
    let is_ula = (seg0 & 0xfe00) == 0xfc00;
    let is_link_local = (seg0 & 0xffc0) == 0xfe80;
    let is_doc = seg0 == 0x2001 && v6.segments()[1] == 0x0db8;
    let mapped_v4 = v6
        .to_ipv4_mapped()
        .or_else(|| v6.to_ipv4())
        .is_some_and(is_non_public_v4);
    v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_multicast()
        || is_ula
        || is_link_local
        || is_doc
        || mapped_v4
}

pub fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_non_public_v4(v4),
        IpAddr::V6(v6) => is_non_public_v6(v6),
    }
}

fn is_non_canonical_ip_literal(host: &str) -> bool {
    !host.is_empty()
        && host.split('.').all(|seg| {
            !seg.is_empty()
                && (seg.bytes().all(|b| b.is_ascii_digit())
                    || ((seg.starts_with("0x") || seg.starts_with("0X"))
                        && seg.len() > 2
                        && seg[2..].bytes().all(|b| b.is_ascii_hexdigit())))
        })
}

pub fn validate_catalog_url_syntax(url: &str) -> Result<(Url, String, u16), String> {
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !parsed.has_host()
    {
        return Err("Catalog refresh URL must be a valid https:// URL without userinfo.".into());
    }
    let raw_host = parsed
        .host_str()
        .ok_or_else(|| "Catalog refresh URL is missing a host.".to_string())?;
    let host = raw_host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(raw_host)
        .trim_end_matches('.');
    let lower = host.to_ascii_lowercase();
    if lower.is_empty()
        || lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || lower == "metadata"
        || lower.starts_with("metadata.")
    {
        return Err(format!("Blocked non-public or internal catalog host: {raw_host}"));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_non_public_ip(ip) {
            return Err(format!("Blocked non-public IP address for catalog refresh: {raw_host}"));
        }
    } else if is_non_canonical_ip_literal(host) {
        return Err(format!("Blocked non-canonical IP host for catalog refresh: {raw_host}"));
    }
    let host_owned = host.to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    Ok((parsed, host_owned, port))
}

pub async fn resolve_and_validate_public_addrs(
    host: &str,
    port: u16,
) -> Result<Vec<SocketAddr>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_non_public_ip(ip) {
            return Err(format!("Blocked non-public IP address for catalog refresh: {host}"));
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("Failed to resolve catalog host '{host}': {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("Catalog host '{host}' did not resolve to any addresses."));
    }
    for addr in &addrs {
        if is_non_public_ip(addr.ip()) {
            return Err(format!(
                "Blocked SSRF: catalog host '{host}' resolved to non-public IP {}.",
                addr.ip()
            ));
        }
    }
    Ok(addrs)
}

pub fn build_catalog_client(host: &str, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .read_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12));
    if !addrs.is_empty() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    builder.build().map_err(|e| e.to_string())
}

pub async fn read_response_bounded(
    mut resp: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if resp.status().is_redirection() {
        return Err(format!("Catalog refresh rejected HTTP redirect ({}).", resp.status()));
    }
    if !resp.status().is_success() {
        return Err(format!("Catalog refresh HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > max_bytes as u64 {
            return Err("Catalog refresh payload exceeds 2 MiB safety limit.".into());
        }
    }

    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len().saturating_add(chunk.len()) > max_bytes {
            return Err("Catalog refresh payload exceeds 2 MiB safety limit.".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

pub async fn fetch_public_https_bounded(url: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let (parsed, host, port) = validate_catalog_url_syntax(url)?;
    let addrs = resolve_and_validate_public_addrs(&host, port).await?;
    let client = build_catalog_client(&host, &addrs)?;
    let resp = client.get(parsed).send().await.map_err(|e| e.to_string())?;
    read_response_bounded(resp, max_bytes).await
}
