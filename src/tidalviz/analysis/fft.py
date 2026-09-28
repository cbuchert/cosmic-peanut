"""Real FFTs into preallocated float64/complex128 arrays, without numpy.fft's Python wrappers.

``np.fft.rfft`` spends more time in its Python argument handling than in the transform when it
runs cold once per hop (~140 µs vs ~75 µs per call on an idle M4 Pro core). numpy ≥ 2 exposes
the transforms as gufuncs; we call those directly when present and fall back to ``np.fft``.
"""

from collections.abc import Callable
from typing import Any

import numpy as np

_rfft_gufunc: Callable[..., Any] | None
_irfft_gufunc: Callable[..., Any] | None
try:
    import numpy.fft._pocketfft_umath as _pfu  # pyright: ignore[reportMissingImports]

    _rfft_gufunc = _pfu.rfft_n_even  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    _irfft_gufunc = _pfu.irfft  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
except ImportError:  # pragma: no cover - numpy < 2
    _rfft_gufunc = _irfft_gufunc = None


def rfft(x: np.ndarray, out: np.ndarray) -> None:
    """``out[:] = np.fft.rfft(x)`` for an even-length float32 or float64 ``x``."""
    if _rfft_gufunc is not None:
        _rfft_gufunc(x, 1.0, out=out)
    else:  # pragma: no cover
        np.fft.rfft(x, out=out)


def irfft(x: np.ndarray, out: np.ndarray) -> None:
    """``out[:] = np.fft.irfft(x, n=out.size)`` (backward normalization)."""
    if _irfft_gufunc is not None:
        _irfft_gufunc(x, 1.0 / out.size, out=out)
    else:  # pragma: no cover
        np.fft.irfft(x, n=out.size, out=out)
