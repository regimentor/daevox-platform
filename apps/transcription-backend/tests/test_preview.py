import asyncio
import subprocess
import wave

import pytest

from transcription.preview import PreviewStream, preview_file


def test_preview_publishes_before_completion_and_appends_without_replacing_segments(tmp_path):
    clip = tmp_path / "phrase.wav"
    with wave.open(str(clip), "wb") as audio:
        audio.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x01\x00" * 24000)

    async def check():
        stream = PreviewStream(tmp_path / "preview", {})
        try:
            await stream.append(25, [{"start": 0, "duration": 1, "path": str(clip)}])

            async def published():
                while stream.available() < 20:
                    await asyncio.sleep(0.02)

            await asyncio.wait_for(published(), 5)
            playlist = stream.directory / "index.m3u8"
            assert "#EXT-X-ENDLIST" not in playlist.read_text()
            first = stream.directory / "segment000000.ts"
            original = first.read_bytes()
            await stream.append(33, [])
            await stream.finish()
            assert first.read_bytes() == original
            assert "#EXT-X-ENDLIST" in playlist.read_text()
            assert 33 <= stream.available() < 33.1
            await asyncio.to_thread(
                subprocess.run,
                ["ffmpeg", "-v", "error", "-i", str(playlist), "-f", "null", "-"],
                check=True,
            )
        finally:
            await stream.close()
        assert stream.process.returncode == 0

    asyncio.run(check())


def test_preview_cancellation_stops_encoder(tmp_path):
    async def check():
        stream = PreviewStream(tmp_path, {})
        await stream.append(2, [])
        await stream.close()
        assert stream.process.returncode is not None

    asyncio.run(check())


@pytest.mark.parametrize(
    "name", ["../source", "encoder.log", "index.m3u8.tmp", "segment0.ts/../source"]
)
def test_preview_rejects_private_and_unpublished_files(tmp_path, name):
    with pytest.raises(ValueError):
        preview_file(tmp_path, name)


def test_pipeline_exposes_preview_while_last_phrase_is_still_synthesizing(tmp_path, monkeypatch):
    from transcription.config import Settings
    from transcription.processes import run_worker
    from transcription.voiceover import Voiceovers, VoiceoverSnapshot

    service = Voiceovers(Settings(data_dir=tmp_path))
    record = VoiceoverSnapshot(
        id="preview",
        created_at="2026-09-12T00:00:00Z",
        source={"kind": "file"},
        status="synthesizing",
        duration=60,
        transcript=[
            {"id": str(i), "start": start, "end": start + 2, "text": str(i), "speaker_id": "one"}
            for i, start in enumerate([0, 25, 50])
        ],
        voice_assignments={"one": "aidar"},
    )
    service.records[record.id] = record
    directory = service.directory(record.id)
    directory.mkdir(parents=True)
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=s=160x90:r=1:d=60",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=24000:cl=mono",
            "-t",
            "60",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-f",
            "mp4",
            str(directory / "source"),
        ],
        check=True,
    )

    async def check():
        release = asyncio.Event()

        async def worker(command, role, config, receive):
            if role == "preview_video":
                return await run_worker(command, role, config, receive)
            if role in {"translation", "tts"}:
                phrase = config["phrases"][0]
                if role == "translation":
                    receive({"kind": "translation", "id": phrase["id"], "text": phrase["text"]})
                else:
                    if phrase["id"] == "2":
                        await release.wait()
                    path = directory / f"{phrase['id']}.wav"
                    with wave.open(str(path), "wb") as audio:
                        audio.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                        audio.writeframes(b"\x01\x00" * 24000)
                    receive(
                        {
                            "kind": "synthesized",
                            "id": phrase["id"],
                            "path": str(path),
                            "duration": 1,
                        }
                    )

        monkeypatch.setattr("transcription.voiceover.run_worker", worker)
        task = asyncio.create_task(service.render(record))
        try:

            async def available():
                while not record.assets.get("video"):
                    assert not task.done(), record.error
                    await asyncio.sleep(0.05)

            await asyncio.wait_for(available(), 10)
            assert record.status == "synthesizing"
            assert record.preview["available_seconds"] >= 20
            assert not record.preview["complete"]
            assert record.assets["audio"].endswith("index.m3u8")
            assert service.media(record.id, "video").is_file()
            generation = record.preview["generation"]
            playlist = service.preview_asset(record.id, generation, "index.m3u8")
            assert "#EXT-X-ENDLIST" not in playlist.read_text()
            release.set()
            await asyncio.wait_for(task, 10)
            assert record.status == "completed", record.error
            assert record.preview["complete"]
            assert "#EXT-X-ENDLIST" in playlist.read_text()
            assert playlist.exists()  # The active player keeps this URL after final assembly.
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(check())
