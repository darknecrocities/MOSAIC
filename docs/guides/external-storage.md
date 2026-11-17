# External Storage Setup & Troubleshooting

MOSAIC requires an external HDD or SSD for storing Ollama model weights and never falls back silently to internal storage.

## Recommended Filesystems

| OS | Recommended | Cross-Platform Alternative | Notes |
| :--- | :--- | :--- | :--- |
| macOS | APFS | exFAT | Disk images (`.dmg`) and `/System/Volumes/*` are automatically excluded. |
| Windows | NTFS | exFAT | Ensure the drive letter or volume is mounted writable. |
| Linux | ext4 | exFAT / NTFS (with OS drivers) | Verify user write permissions on the mount point. |

## Safe Removal

Always use **External Storage -> Stop model and prepare drive for removal**. MOSAIC blocks ejection while a pull or chat stream is active, flushes pending writes, and invokes the OS eject mechanism (`diskutil eject` / `udisksctl`).
