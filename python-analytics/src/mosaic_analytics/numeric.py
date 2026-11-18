"""Safe numeric coercion helpers guarding bool, NaN/Inf, and non-numeric inputs."""

from __future__ import annotations

import math
from typing import Any

MAX_SAFE_BYTES = 10**18
MAX_SAFE_COUNT = 10**9


def safe_optional_float(value: Any) -> float | None:
    """Coerce numeric or numeric-string values to finite float, else None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        try:
            parsed = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return parsed if math.isfinite(parsed) else None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            parsed = float(stripped)
        except (TypeError, ValueError, OverflowError):
            return None
        return parsed if math.isfinite(parsed) else None
    return None


def safe_float(value: Any, default: float = 0.0) -> float:
    """Coerce value to finite float, falling back to default on invalid input."""
    parsed = safe_optional_float(value)
    return default if parsed is None else parsed


def safe_int(
    value: Any,
    default: int = 0,
    *,
    min_value: int | None = None,
    max_value: int | None = None,
) -> int:
    """Coerce value to int, rejecting bool, NaN/Inf, and invalid strings."""
    if isinstance(value, int) and not isinstance(value, bool):
        try:
            if not math.isfinite(float(value)):
                return default
        except OverflowError:
            return default
        result = value
    else:
        parsed = safe_optional_float(value)
        if parsed is None:
            return default
        result = int(parsed)
    if min_value is not None:
        result = max(min_value, result)
    if max_value is not None:
        result = min(max_value, result)
    return result


def safe_scaled_int(
    value: Any,
    factor: float = 1.0,
    default: int = 0,
    *,
    min_value: int = 0,
    cap: int = MAX_SAFE_BYTES,
) -> int:
    """Multiply a numeric value by factor safely, guarding overflow/NaN/Inf."""
    parsed = safe_optional_float(value)
    if parsed is None:
        return default
    try:
        factor_f = float(factor)
        scaled = parsed * factor_f
    except (TypeError, ValueError, OverflowError):
        return default
    if not math.isfinite(factor_f):
        return default
    if not math.isfinite(scaled):
        if parsed == 0 or factor_f == 0:
            return max(0, min_value)
        return cap if (parsed > 0) == (factor_f > 0) else min_value
    if scaled >= cap:
        return cap
    if scaled <= min_value:
        return min_value
    return int(scaled)
