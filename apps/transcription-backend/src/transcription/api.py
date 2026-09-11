from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, StreamingResponse

from .config import Settings, load_settings
from .models import TERMINAL, Snapshot, StartRequest
from .service import Service
from .voiceover import (
    PhraseRetryRequest,
    SynthesisRequest,
    VoiceAssignment,
    VoiceoverRequest,
    Voiceovers,
    VoiceoverSnapshot,
)


def create_app(
    settings: Settings | None = None, *, worker_command: list[str] | None = None
) -> FastAPI:
    service = Service(settings or load_settings(), worker_command)
    voiceovers = Voiceovers(service.settings, worker_command)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await voiceovers.close()
        await service.close()

    app = FastAPI(title="Daevox local transcription", lifespan=lifespan)
    prefix = "/trancription-api"

    def current_activity():
        if voiceovers.activity():
            return voiceovers.activity()
        if service.current and (
            service.cleanup_failed
            or service.current.status not in TERMINAL
            or (service.task and not service.task.done())
        ):
            return {
                "kind": "transcription",
                "id": service.current.operation_id,
                "status": service.current.status,
            }
        return None

    def check_available():
        active = current_activity()
        if active:
            raise HTTPException(409, {"code": "busy", "message": "Сервис занят", "active": active})

    @app.get(prefix + "/activity")
    async def activity():
        return current_activity()

    @app.get(prefix + "/voiceover-devices")
    async def voiceover_devices():
        import asyncio

        return {
            "items": await asyncio.to_thread(voiceovers.devices),
            "defaults": {"asr_gpu": service.settings.asr_gpu, "tts_gpu": service.settings.tts_gpu},
        }

    @app.post(prefix + "/voiceovers", status_code=201)
    async def reserve_voiceover(body: VoiceoverRequest, response: Response) -> VoiceoverSnapshot:
        previous = voiceovers.retry(body)
        if previous:
            response.status_code = 200
            return previous
        check_available()
        return voiceovers.reserve(body)

    @app.get(prefix + "/voiceovers/{record_id}")
    async def get_voiceover(record_id: str) -> VoiceoverSnapshot:
        return voiceovers.get(record_id)

    @app.get(prefix + "/voiceovers")
    async def list_voiceovers(cursor: str | None = None, limit: int = Query(20, ge=1, le=100)):
        return voiceovers.library(cursor, limit)

    @app.delete(prefix + "/voiceovers/{record_id}", status_code=204)
    async def delete_voiceover(record_id: str):
        await voiceovers.delete(record_id)
        return Response(status_code=204)

    @app.put(prefix + "/voiceovers/{record_id}/source", status_code=202)
    async def upload_voiceover(record_id: str, request: Request) -> VoiceoverSnapshot:
        return await voiceovers.upload(record_id, request)

    @app.put(prefix + "/voiceovers/{record_id}/voices")
    async def assign_voices(record_id: str, body: VoiceAssignment) -> VoiceoverSnapshot:
        return voiceovers.assign(record_id, body)

    @app.post(prefix + "/voiceovers/{record_id}/synthesize", status_code=202)
    async def synthesize(record_id: str, body: SynthesisRequest) -> VoiceoverSnapshot:
        if current_activity() and current_activity().get("id") != record_id:
            check_available()
        return voiceovers.synthesize(record_id, body)

    @app.post(prefix + "/voiceovers/{record_id}/phrases/{phrase_id}/retry", status_code=202)
    async def retry_voiceover_phrase(
        record_id: str, phrase_id: str, body: PhraseRetryRequest
    ) -> VoiceoverSnapshot:
        if current_activity() and current_activity().get("id") != record_id:
            check_available()
        return voiceovers.retry_phrase(record_id, phrase_id, body)

    @app.api_route(prefix + "/voiceovers/{record_id}/media/{kind}", methods=["GET", "HEAD"])
    async def voiceover_media(record_id: str, kind: str):
        return FileResponse(voiceovers.media(record_id, kind))

    @app.api_route(
        prefix + "/voiceovers/{record_id}/phrases/{phrase_id}/audio", methods=["GET", "HEAD"]
    )
    async def voiceover_phrase_audio(record_id: str, phrase_id: str):
        return FileResponse(voiceovers.phrase_audio(record_id, phrase_id), media_type="audio/wav")

    @app.api_route(
        prefix + "/voiceovers/{record_id}/speakers/{speaker_id}/sample", methods=["GET", "HEAD"]
    )
    async def voiceover_speaker_sample(record_id: str, speaker_id: str):
        return FileResponse(
            voiceovers.speaker_sample(record_id, speaker_id), media_type="audio/wav"
        )

    @app.put(prefix + "/voiceovers/{record_id}/speakers/{speaker_id}/sample")
    async def replace_voiceover_speaker_sample(
        record_id: str, speaker_id: str, expected_revision: int, request: Request
    ) -> VoiceoverSnapshot:
        return await voiceovers.replace_speaker_sample(
            record_id, speaker_id, expected_revision, request
        )

    @app.api_route(prefix + "/voiceover-voices/{voice}/sample", methods=["GET", "HEAD"])
    async def voice_sample(voice: str):
        return FileResponse(voiceovers.sample(voice), media_type="audio/wav")

    @app.get(prefix + "/voiceovers/{record_id}/events")
    async def voiceover_events(record_id: str, request: Request):
        voiceovers.get(record_id)
        cursor = request.headers.get("last-event-id")
        return StreamingResponse(
            voiceovers.events(record_id, int(cursor) if cursor and cursor.isdigit() else None),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get(prefix + "/health")
    async def health():
        return {"status": "ok"}

    @app.get(prefix + "/operations/current")
    async def get_current() -> Snapshot | None:
        return service.current

    @app.post(prefix + "/operations", status_code=201)
    async def reserve(body: StartRequest) -> Snapshot:
        if not (service.current and service.request_id == body.client_request_id):
            check_available()
        return service.reserve(body)

    @app.get(prefix + "/operations/{operation_id}")
    async def get_operation(operation_id: str) -> Snapshot:
        return service.get(operation_id)

    @app.post(prefix + "/operations/{operation_id}/cancel", status_code=202)
    async def cancel(operation_id: str) -> Snapshot:
        return service.cancel(operation_id)

    @app.put(prefix + "/operations/{operation_id}/source", status_code=202)
    async def upload(operation_id: str, request: Request) -> Snapshot:
        return await service.upload(operation_id, request)

    @app.get(prefix + "/operations/{operation_id}/events")
    async def events(operation_id: str, request: Request):
        snapshot = service.get(operation_id)
        cursor = request.headers.get("last-event-id")
        return StreamingResponse(
            service.events(snapshot, int(cursor) if cursor and cursor.isdigit() else None),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app
