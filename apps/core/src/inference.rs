use crate::runtime::Runtime;
use axum::{
    Extension, Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

struct Inflight(Arc<AtomicU64>);
impl Drop for Inflight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) async fn models(runtime: Option<Extension<Runtime>>) -> Json<Value> {
    let mut models = vec![];
    if let Some(Extension(runtime)) = runtime {
        let snapshot = runtime.0.lock().await;
        if snapshot["state"] == "ready" {
            models.push(json!({"id":snapshot["active_instance"]["preset_id"],"object":"model","created":0,"owned_by":"local"}));
        }
    }
    Json(json!({"object":"list", "data":models}))
}
fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({"error":{"code":code,"type":"server_error","message":message,"param":null}})),
    )
        .into_response()
}
pub(crate) async fn chat(
    runtime: Option<Extension<Runtime>>,
    telemetry: Option<Extension<crate::telemetry::Telemetry>>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    Json(body): Json<Value>,
) -> Response {
    if !body["model"].as_str().is_some_and(|s| !s.trim().is_empty())
        || uri.query().is_some_and(|s| !s.is_empty())
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Supply a concrete model in the JSON body; router query controls are unavailable",
        );
    }
    let Some(Extension(runtime)) = runtime else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_active_model",
            "No model is active",
        );
    };
    let snapshot = runtime.0.lock().await;
    if matches!(
        snapshot["state"].as_str(),
        Some("waiting" | "unloading" | "loading")
    ) {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "model_switching",
            "Model is switching",
        );
    }
    if snapshot["state"] != "ready" {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_active_model",
            "No model is active",
        );
    }
    if snapshot["active_instance"]["preset_id"] != body["model"] {
        return error(
            StatusCode::CONFLICT,
            "preset_not_active",
            "Requested preset is not active",
        );
    }
    let mut measurement = telemetry
        .map(|Extension(t)| t.request(&snapshot["active_instance"], body["stream"] == true));
    let mut cancellation = runtime.3.subscribe();
    runtime.2.fetch_add(1, Ordering::SeqCst);
    let guard = Inflight(runtime.2.clone());
    drop(snapshot);
    let url = runtime.1.lock().await.as_ref().map(|r| r.url.clone());
    let Some(url) = url else {
        if let Some(m) = &mut measurement {
            m.status = "failed";
        }
        return error(
            StatusCode::BAD_GATEWAY,
            "inference_upstream_error",
            "Router is unavailable",
        );
    };
    let client = reqwest::Client::new();
    let request = client
        .post(format!("{url}/v1/chat/completions"))
        .json(&body);
    let response = tokio::select! {
        response = request.send() => response,
        _ = cancellation.changed() => return error(StatusCode::SERVICE_UNAVAILABLE, "model_switching", "Request was interrupted by force"),
    };
    match response {
        Ok(response) => {
            let status = response.status();
            let content_type = response
                .headers()
                .get("content-type")
                .cloned()
                .unwrap_or_else(|| axum::http::HeaderValue::from_static("application/json"));
            let stream = async_stream::stream! {
                let _guard = guard;
                let mut stream = response.bytes_stream();
                loop {
                    tokio::select! {
                        chunk = stream.next() => match chunk { Some(chunk) => {match &chunk {Ok(bytes)=>{if let Some(m)=&mut measurement {m.chunk(bytes);}},Err(_)=>{if let Some(m)=&mut measurement {m.status="failed";}}} yield chunk.map_err(std::io::Error::other)}, None => {if let Some(m)=&mut measurement {m.complete(status.is_success());} break} },
                        _ = cancellation.changed() => { yield Err(std::io::Error::other("Request interrupted by force")); break; }
                    }
                }
            };
            (
                status,
                [(axum::http::header::CONTENT_TYPE, content_type)],
                axum::body::Body::from_stream(stream),
            )
                .into_response()
        }
        Err(_) => {
            if let Some(m) = &mut measurement {
                m.status = "failed";
            }
            error(
                StatusCode::BAD_GATEWAY,
                "inference_upstream_error",
                "Router is unavailable",
            )
        }
    }
}
