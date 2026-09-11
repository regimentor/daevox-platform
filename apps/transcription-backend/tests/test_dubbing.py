from transcription.dubbing import semantic_windows


def test_excessively_long_unpunctuated_phrase_is_split_on_timed_words():
    words = [
        {"start": index * 2.0, "end": index * 2.0 + 1.0, "text": f" word{index}"}
        for index in range(12)
    ]
    phrase = {
        "id": "source",
        "start": 0.0,
        "end": 23.0,
        "text": "".join(word["text"] for word in words),
        "speaker_id": "speaker_1",
        "overlap": False,
        "words": words,
    }

    windows = semantic_windows([phrase])

    assert len(windows) == 2
    assert all(window["end"] - window["start"] <= 18 for window in windows)
    assert [window["id"] for window in windows] == ["source:0", "source:1"]
    assert all(window["source_segment_ids"] == ["source"] for window in windows)
    assert "".join(window["text"] for window in windows) == phrase["text"]


def test_deadlines_use_pauses_and_split_overlap_windows_without_extending_source():
    from transcription.dubbing import phrase_deadlines

    assert phrase_deadlines(
        [
            {"start": 0, "end": 1},
            {"start": 3, "end": 4},
        ],
        5,
    ) == [3, 5]
    assert phrase_deadlines(
        [
            {"start": 0, "end": 2},
            {"start": 1, "end": 3},
            {"start": 4, "end": 5},
        ],
        6,
    ) == [2, 4, 6]
