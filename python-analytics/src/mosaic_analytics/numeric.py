"""Safe numeric coercion helpers guarding bool, NaN/Inf, and non-numeric inputs."""

from __future__ import annotations

import math
from typing import Any


def safe_optional_float(value: Any) -> float | None:
    """Coerce numeric or numeric-string values to finite float, else None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            parsed = float(stripped)
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) else None
    return None


def safe_float(value: Any, default: float = 0.0) -> float:
    """Coerce value to finite float, falling back to default on invalid input."""
    parsed = safe_optional_float(value)
    return default if parsed is None else parsed


def safe_int(value: Any, default: int = 0) -> int:
    """Coerce value to int, rejecting bool, NaN/Inf, and invalid strings."""
    parsed = safe_optional_float(value)
    return default if parsed is None else int(parsed)
