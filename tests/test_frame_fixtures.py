import json
from pathlib import Path

import numpy as np
import pytest

from tidalviz.transport.frame import decode, encode
from tools.make_frame_fixtures import FIXTURES, build


@pytest.mark.parametrize("name", ["mono", "stereo"])
def test_golden_fixture_matches_encoder(name: str):
    """The committed .bin is exactly what the encoder produces, and the .json describes it."""
    frame = build(stereo=name == "stereo")
    assert (FIXTURES / f"frame_v1_{name}.bin").read_bytes() == encode(frame)
    desc = json.loads((FIXTURES / f"frame_v1_{name}.json").read_text())
    g = decode(encode(frame))
    assert desc["frameIndex"] == g.index and desc["onset"] == g.onset and desc["silent"] == g.silent
    np.testing.assert_allclose(desc["scalars"], g.scalars, rtol=0, atol=0)
    np.testing.assert_allclose(desc["bands"], g.bands)
    assert Path(FIXTURES).is_dir()
