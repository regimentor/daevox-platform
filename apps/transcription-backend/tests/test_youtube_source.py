from unittest.mock import patch

import pytest

from transcription.video_worker import acquire


@pytest.mark.parametrize("availability", [None, "public"])
def test_missing_availability_does_not_reject_downloadable_video(tmp_path, availability):
    downloaded = tmp_path / "download.mp4"
    downloaded.write_bytes(b"video")
    info = {"availability": availability, "is_live": False, "live_status": "not_live"}

    class Downloader:
        def __init__(self, options):
            self.options = options

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def extract_info(self, *args, **kwargs):
            assert self.options["match_filter"](info, incomplete=False) is None
            return info

        def prepare_filename(self, info):
            return str(downloaded)

    with patch("yt_dlp.YoutubeDL", Downloader):
        acquire(
            {
                "directory": str(tmp_path),
                "source_path": str(tmp_path / "source"),
                "source": {"url": "https://www.youtube.com/watch?v=2Xiljy4xzbc"},
            }
        )
    assert (tmp_path / "source").read_bytes() == b"video"


@pytest.mark.parametrize(
    "info,reason",
    [
        ({"availability": "private"}, "ограниченном доступе"),
        ({"availability": "premium_only"}, "ограниченном доступе"),
        ({"availability": "subscriber_only"}, "ограниченном доступе"),
        ({"availability": "needs_auth"}, "ограниченном доступе"),
        ({"is_live": True}, "трансляция"),
        ({"live_status": "is_upcoming"}, "трансляция"),
        ({"live_status": "post_live"}, "трансляция"),
    ],
)
def test_restricted_sources_keep_reason_when_downloader_skips_video(tmp_path, info, reason):
    from transcription.video_worker import UnsupportedSource

    class Downloader:
        def __init__(self, options):
            self.options = options

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def extract_info(self, *args, **kwargs):
            assert reason in self.options["match_filter"](info, incomplete=False)

    with patch("yt_dlp.YoutubeDL", Downloader), pytest.raises(UnsupportedSource, match=reason):
        acquire(
            {
                "directory": str(tmp_path),
                "source": {"url": "https://www.youtube.com/watch?v=2Xiljy4xzbc"},
            }
        )


def test_worker_emits_specific_source_rejection(monkeypatch):
    import io
    import json
    import sys

    from transcription import video_worker

    events = []
    monkeypatch.setattr(sys, "stdout", sys.stdout)
    monkeypatch.setattr(sys, "argv", ["worker", "voiceover_preparation"])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"source": {"kind": "youtube"}})))
    monkeypatch.setattr(video_worker, "emit", lambda **event: events.append(event))

    def reject(config):
        raise video_worker.UnsupportedSource("YouTube сообщил об ограниченном доступе к видео.")

    monkeypatch.setattr(video_worker, "acquire", reject)
    with pytest.raises(SystemExit):
        video_worker.main()
    assert events == [
        {
            "kind": "error",
            "code": "unsupported_source",
            "message": "YouTube сообщил об ограниченном доступе к видео.",
        }
    ]
