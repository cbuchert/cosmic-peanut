"""Beat-tracking accuracy floor on Ballroom (~10 s on 10 cores). Skips without the dataset:
uv run python -m tools.beat_eval --fetch"""

import pytest

from tools.beat_eval import clips, evaluate, summary

# Measured on the current tracker; raise these as it improves (NOTES.md has the history).
FLOOR = {"f": 0.66, "cmlt": 0.52, "amlt": 0.68, "acc1": 0.72, "acc2": 0.94}


@pytest.mark.skipif(not clips(), reason="no Ballroom dataset (tools.beat_eval --fetch)")
def test_ballroom_beat_tracking_stays_above_its_floor():
    got = summary(evaluate(clips()))
    assert all(got[k] >= v for k, v in FLOOR.items()), got
