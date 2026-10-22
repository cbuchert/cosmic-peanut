"""Beat-tracking accuracy floor on Ballroom (~10 s on 10 cores). Skips without the dataset:
uv run python -m tools.beat_eval --fetch"""

import pytest

from tools.beat_eval import clips, evaluate, summary

# Measured on the current tracker; raise these as it improves (NOTES.md has the history).
FLOOR = {"f": 0.52, "cmlt": 0.37, "amlt": 0.59, "acc1": 0.64, "acc2": 0.91}


@pytest.mark.skipif(not clips(), reason="no Ballroom dataset (tools.beat_eval --fetch)")
def test_ballroom_beat_tracking_stays_above_its_floor():
    got = summary(evaluate(clips()))
    assert all(got[k] >= v for k, v in FLOOR.items()), got
