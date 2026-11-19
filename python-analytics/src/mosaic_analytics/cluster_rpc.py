"""Worker validation and GGML_RPC multi-node allocation helpers."""

from __future__ import annotations

import ipaddress
import re
from typing import Any

from mosaic_analytics.execution_planner import GIB
from mosaic_analytics.numeric import safe_int

_AWS_IPV6_IMDS = ipaddress.IPv6Address("fd00:ec2::254")
_IPV6_LOOPBACK = ipaddress.IPv6Address("::1")
_IPV4_BROADCAST = ipaddress.IPv4Address("255.255.255.255")
_HOST_CHARS_RE = re.compile(r"^[A-Za-z0-9.-]+$")


def _is_blocked_v4(v4: ipaddress.IPv4Address) -> bool:
    return (
        v4.is_link_local
        or v4.is_unspecified
        or v4.is_multicast
        or v4.is_reserved
        or v4 == _IPV4_BROADCAST
    )


def _is_non_canonical_ip_hostname(host: str) -> bool:
    segs = host.split(".")
    if not segs or any(not s for s in segs):
        return True
    return all(
        s.isdigit()
        or (
            (s.startswith("0x") or s.startswith("0X"))
            and len(s) > 2
            and all(c in "0123456789abcdefABCDEF" for c in s[2:])
        )
        for s in segs
    )


def _is_blocked_worker_host(host: str) -> bool:
    raw = host.strip()
    if not raw or any(ch.isspace() for ch in raw):
        return True
    bracketed = raw.startswith("[") and raw.endswith("]")
    clean = raw[1:-1] if bracketed else raw
    clean = clean.rstrip(".")
    if not clean or len(clean) > 253 or "%" in clean:
        return True
    lower = clean.lower()
    if (
        lower in {"metadata", "metadata.google.internal"}
        or lower.startswith("metadata.")
        or lower.endswith(".internal")
    ):
        return True
    try:
        ip = ipaddress.ip_address(clean)
    except ValueError:
        if bracketed or "[" in raw or "]" in raw:
            return True
        if clean.startswith("-") or clean.startswith(".") or ".." in clean:
            return True
        if not _HOST_CHARS_RE.fullmatch(clean):
            return True
        return _is_non_canonical_ip_hostname(clean)

    if isinstance(ip, ipaddress.IPv4Address):
        return True if bracketed else _is_blocked_v4(ip)

    if ip == _AWS_IPV6_IMDS or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
        return True
    v4_mapped = ip.ipv4_mapped
    if v4_mapped is not None and _is_blocked_v4(v4_mapped):
        return True
    if ip != _IPV6_LOOPBACK and int(ip) < 2**32:
        v4_compat = ipaddress.IPv4Address(ip.packed[-4:])
        if _is_blocked_v4(v4_compat) or v4_compat.is_loopback or v4_compat.is_private:
            return True
    return False


def _format_endpoint(host: str, port: int) -> str:
    clean = host.strip().strip("[]")
    return f"[{clean}]:{port}" if ":" in clean else f"{clean}:{port}"


def node_budget_bytes(node: dict[str, Any], reserve_gib: float, *, is_remote: bool = False) -> int:
    """Usable memory budget for a local or remote RPC node."""
    is_unified = bool(node.get("is_unified_memory"))
    vram = max(0, safe_int(node.get("vram_bytes"), 0))
    raw_ram = node.get("ram_effective_avail_bytes")
    ram = max(0, safe_int(raw_ram if raw_ram is not None else node.get("ram_available_bytes"), 0))
    if is_unified:
        if is_remote:
            return max(0, ram - int(reserve_gib * GIB))
        ram_total = max(0, safe_int(node.get("ram_total_bytes"), 0))
        metal_cap = max(0, safe_int(node.get("metal_wired_limit_bytes"), 0))
        if metal_cap <= 0:
            metal_cap = int(ram_total * 0.70) if ram_total > 0 else ram
        return max(0, min(ram, metal_cap) - int(reserve_gib * GIB))
    if vram > 0:
        return max(0, vram - int(0.5 * GIB)) + max(0, ram - int(reserve_gib * GIB))
    return max(0, ram - int(reserve_gib * GIB))


def parse_valid_workers(workers: Any) -> list[dict[str, Any]]:
    """Filter worker entries with valid host, TCP port (1-65535), and positive budget."""
    if not isinstance(workers, list):
        return []
    valid: list[dict[str, Any]] = []
    for w in workers:
        if not isinstance(w, dict):
            continue
        raw_host = w.get("host")
        host = raw_host.strip() if isinstance(raw_host, str) else ""
        if not host or _is_blocked_worker_host(host):
            continue
        raw_port = w.get("port")
        if raw_port is None:
            port = 50052
        elif isinstance(raw_port, bool | float):
            continue
        else:
            try:
                port = int(raw_port)
            except (TypeError, ValueError):
                continue
        if not (1 <= port <= 65535):
            continue
        budget = node_budget_bytes(w, reserve_gib=1.0, is_remote=True)
        if budget > 0:
            valid.append(
                {
                    "name": str(w.get("name") or host),
                    "endpoint": _format_endpoint(host, port),
                    "budget": budget,
                }
            )
    return valid


def build_multi_node_rpc_plan(
    *,
    local_node: dict[str, Any],
    local_total_budget: int,
    local_fast_tier: int,
    local_unified: bool,
    valid_workers: list[dict[str, Any]],
    total_demand: int,
    hot_bytes: int,
    is_moe: bool,
    confidence: str,
    warnings: list[str],
) -> dict[str, Any]:
    """Build multi-node GGML_RPC allocation and runtime flags across valid workers."""
    nodes = [
        {
            "name": local_node.get("name") or "local-coordinator",
            "role": "coordinator",
            "budget_bytes": local_total_budget,
            "endpoint": "127.0.0.1",
        }
    ] + [
        {
            "name": w["name"],
            "role": "rpc_worker",
            "budget_bytes": w["budget"],
            "endpoint": w["endpoint"],
        }
        for w in valid_workers
    ]
    rpc_endpoints = [w["endpoint"] for w in valid_workers]
    cluster_budget = sum(n["budget_bytes"] for n in nodes)
    splits = [max(1, round((n["budget_bytes"] / cluster_budget) * 100)) for n in nodes]
    allocations = [
        {
            "name": n["name"],
            "role": n["role"],
            "endpoint": n["endpoint"],
            "allocated_bytes": int(total_demand * (n["budget_bytes"] / cluster_budget)),
            "budget_bytes": n["budget_bytes"],
        }
        for n in nodes
    ]
    spill_bytes = max(0, total_demand - cluster_budget)
    runtime_flags = [
        "--split-mode",
        "layer",
        "--rpc",
        ",".join(rpc_endpoints),
        "--tensor-split",
        ",".join(str(s) for s in splits),
    ]
    if is_moe and not local_unified:
        runtime_flags.extend(["-ot", "exps=CPU"])
    if spill_bytes > 0:
        warnings.append(
            f"Pooled cluster memory is short by {spill_bytes / GIB:.1f} GiB; "
            "remaining weights would spill to external drive mmap."
        )
    warnings.append(
        "Cross-node GGML_RPC pools memory over TCP; token speed is bounded by network RTT."
    )
    tier1_gpu = min(hot_bytes, local_fast_tier)
    tier2_ram = max(0, min(total_demand - spill_bytes, cluster_budget) - tier1_gpu)
    return {
        "value": {
            "strategy": "multi_node_rpc",
            "feasible": spill_bytes == 0,
            "is_moe": is_moe,
            "total_demand_bytes": total_demand,
            "tier1_gpu_bytes": tier1_gpu,
            "tier2_ram_bytes": tier2_ram,
            "tier3_disk_mmap_bytes": spill_bytes,
            "node_allocations": allocations,
            "runtime_flags": runtime_flags,
            "warnings": warnings,
        },
        "unit": "bytes",
        "source": "calculated",
        "confidence": "medium" if confidence == "high" else confidence,
        "limitations": warnings,
    }
