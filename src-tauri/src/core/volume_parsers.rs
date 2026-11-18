use crate::core::volume_manager::ExternalVolume;

pub fn parse_linux_lsblk_json(parsed: &serde_json::Value) -> Vec<ExternalVolume> {
    let mut volumes = Vec::new();
    if let Some(devices) = parsed.get("blockdevices").and_then(|v| v.as_array()) {
        collect_linux_devices(devices, false, "unknown", false, &mut volumes);
    }
    volumes
}

fn collect_linux_devices(
    devices: &[serde_json::Value],
    parent_removable: bool,
    parent_tran: &str,
    parent_rota: bool,
    out: &mut Vec<ExternalVolume>,
) {
    for dev in devices {
        let tran = dev.get("tran").and_then(|v| v.as_str()).unwrap_or(parent_tran);
        let rm = dev.get("rm").and_then(|v| v.as_bool()).unwrap_or(false)
            || parent_removable
            || tran.eq_ignore_ascii_case("usb")
            || tran.eq_ignore_ascii_case("thunderbolt");
        let rota = dev.get("rota").and_then(|v| v.as_bool()).unwrap_or(parent_rota);

        if let Some(mount) = dev.get("mountpoint").and_then(|v| v.as_str()) {
            let fstype = dev.get("fstype").and_then(|v| v.as_str()).unwrap_or("unknown");
            let ro = dev.get("ro").and_then(|v| v.as_bool()).unwrap_or(false);
            if rm && !mount.is_empty() && mount != "/" && !mount.starts_with("/boot") && fstype != "squashfs" {
                let media_kind = if rota { "HDD" } else { "SSD" }.to_string();
                let writable = !ro;
                let advisory = build_volume_advisory(fstype, &media_kind, writable);
                let label = dev
                    .get("label")
                    .and_then(|v| v.as_str())
                    .or_else(|| dev.get("name").and_then(|v| v.as_str()))
                    .unwrap_or("External")
                    .to_string();
                let uuid = dev
                    .get("uuid")
                    .and_then(|v| v.as_str())
                    .unwrap_or(mount)
                    .to_string();
                out.push(ExternalVolume {
                    volume_identifier: uuid,
                    label,
                    mount_path: mount.to_string(),
                    filesystem: fstype.to_string(),
                    protocol: tran.to_string(),
                    media_kind,
                    total_bytes: dev.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    free_bytes: dev.get("fsavail").and_then(|v| v.as_u64()).unwrap_or(0),
                    writable,
                    advisory,
                });
            }
        }
        if let Some(children) = dev.get("children").and_then(|v| v.as_array()) {
            collect_linux_devices(children, rm, tran, rota, out);
        }
    }
}

pub fn parse_macos_storage_json(parsed: &serde_json::Value) -> Vec<ExternalVolume> {
    let Some(items) = parsed.get("SPStorageDataType").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut volumes = Vec::new();
    for item in items {
        let Some(phys) = item.get("physical_drive") else {
            continue;
        };
        let is_internal = phys.get("is_internal_disk").and_then(|v| v.as_str()) == Some("yes");
        let protocol = phys.get("protocol").and_then(|v| v.as_str()).unwrap_or("unknown");
        let device_name = phys.get("device_name").and_then(|v| v.as_str()).unwrap_or("");
        if is_internal || protocol == "Disk Image" || device_name == "Disk Image" {
            continue;
        }
        let mount_path = item.get("mount_point").and_then(|v| v.as_str()).unwrap_or("");
        if mount_path.is_empty() || mount_path.starts_with("/System/Volumes") {
            continue;
        }
        let writable = item.get("writable").and_then(|v| v.as_str()) == Some("yes");
        let filesystem = item.get("file_system").and_then(|v| v.as_str()).unwrap_or("unknown");
        let medium = phys.get("medium_type").and_then(|v| v.as_str()).unwrap_or("unknown");
        let media_kind = normalize_media_kind(medium);
        let advisory = build_volume_advisory(filesystem, &media_kind, writable);
        volumes.push(ExternalVolume {
            volume_identifier: item
                .get("volume_uuid")
                .and_then(|v| v.as_str())
                .unwrap_or(mount_path)
                .to_string(),
            label: item.get("_name").and_then(|v| v.as_str()).unwrap_or("External").to_string(),
            mount_path: mount_path.to_string(),
            filesystem: filesystem.to_string(),
            protocol: protocol.to_string(),
            media_kind,
            total_bytes: item.get("size_in_bytes").and_then(|v| v.as_u64()).unwrap_or(0),
            free_bytes: item.get("free_space_in_bytes").and_then(|v| v.as_u64()).unwrap_or(0),
            writable,
            advisory,
        });
    }
    volumes
}

pub fn normalize_media_kind(raw: &str) -> String {
    match raw.to_ascii_lowercase().as_str() {
        "ssd" | "solid state" => "SSD".to_string(),
        "hdd" | "rotational" => "HDD".to_string(),
        _ => "unknown".to_string(),
    }
}

pub fn build_volume_advisory(
    filesystem: &str,
    media_kind: &str,
    writable: bool,
) -> Option<String> {
    if !writable {
        return Some("Volume is mounted read-only and cannot store models.".to_string());
    }
    if media_kind == "HDD" {
        return Some(
            "External HDD detected: supported for storage, but SSD is recommended for faster model loading.".to_string(),
        );
    }
    if filesystem.eq_ignore_ascii_case("exFAT") {
        return Some(
            "exFAT works cross-platform; native APFS/NTFS/ext4 is recommended for reliability.".to_string(),
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_internal_and_disk_images() {
        let fixture = serde_json::json!({
            "SPStorageDataType": [
                {
                    "_name": "Macintosh HD",
                    "mount_point": "/",
                    "file_system": "APFS",
                    "writable": "yes",
                    "size_in_bytes": 500_000_000_000u64,
                    "free_space_in_bytes": 100_000_000_000u64,
                    "volume_uuid": "INT-1",
                    "physical_drive": { "is_internal_disk": "yes", "protocol": "Apple Fabric", "medium_type": "ssd" }
                },
                {
                    "_name": "Installer DMG",
                    "mount_point": "/Volumes/Installer",
                    "file_system": "APFS",
                    "writable": "no",
                    "size_in_bytes": 100_000_000u64,
                    "free_space_in_bytes": 0u64,
                    "volume_uuid": "DMG-1",
                    "physical_drive": { "is_internal_disk": "no", "protocol": "Disk Image", "device_name": "Disk Image" }
                },
                {
                    "_name": "MOSAIC_SSD",
                    "mount_point": "/Volumes/MOSAIC_SSD",
                    "file_system": "APFS",
                    "writable": "yes",
                    "size_in_bytes": 1_000_000_000_000u64,
                    "free_space_in_bytes": 750_000_000_000u64,
                    "volume_uuid": "EXT-UUID-99",
                    "physical_drive": { "is_internal_disk": "no", "protocol": "USB", "medium_type": "ssd" }
                }
            ]
        });

        let found = parse_macos_storage_json(&fixture);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].volume_identifier, "EXT-UUID-99");
        assert_eq!(found[0].media_kind, "SSD");
    }

    #[test]
    fn parses_linux_lsblk_usb_and_skips_root() {
        let fixture = serde_json::json!({
            "blockdevices": [
                {
                    "name": "nvme0n1",
                    "tran": "nvme",
                    "rm": false,
                    "rota": false,
                    "children": [
                        { "name": "nvme0n1p1", "mountpoint": "/", "fstype": "ext4", "ro": false, "size": 500_000_000_000u64, "fsavail": 200_000_000_000u64 }
                    ]
                },
                {
                    "name": "sda",
                    "tran": "usb",
                    "rm": true,
                    "rota": true,
                    "children": [
                        { "name": "sda1", "label": "OneTouch", "uuid": "LIN-UUID-1", "mountpoint": "/media/user/OneTouch", "fstype": "exfat", "ro": false, "size": 1_000_000_000_000u64, "fsavail": 600_000_000_000u64 }
                    ]
                }
            ]
        });

        let found = parse_linux_lsblk_json(&fixture);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].volume_identifier, "LIN-UUID-1");
        assert_eq!(found[0].media_kind, "HDD");
    }
}
