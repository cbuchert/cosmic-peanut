from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AnalysisSettings:
    fft_size: int = 2048  # Hann window; 4096 for more bass detail
    hop: int = 512
    n_bands: int = 64
    band_low_hz: float = 30.0
    band_high_hz: float = 16000.0
    auto_gain: bool = True

    def __post_init__(self) -> None:
        if self.fft_size not in (2048, 4096):
            raise ValueError("fft_size must be 2048 or 4096")
