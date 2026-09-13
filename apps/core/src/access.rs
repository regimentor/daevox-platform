use crate::settings::ApiError;
use axum::{
    extract::Request,
    http::{StatusCode, uri::Authority},
    middleware::Next,
    response::{IntoResponse, Response},
};

pub(crate) async fn local_only(request: Request, next: Next) -> Response {
    let allowed_origin = std::env::var("CORE_WEB_ORIGIN").ok();
    let origin_ok = request.headers().get("origin").is_none_or(|origin| {
        origin
            .to_str()
            .ok()
            .zip(allowed_origin.as_deref())
            .is_some_and(|(actual, expected)| actual == expected)
    });
    let host_ok = request
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.parse::<Authority>().ok())
        .is_some_and(|h| matches!(h.host(), "localhost" | "127.0.0.1" | "[::1]"));
    if !origin_ok || !host_ok {
        return ApiError(
            StatusCode::FORBIDDEN,
            "forbidden_origin",
            "Only the configured local web client may access core".into(),
        )
        .into_response();
    }
    let inference = request.uri().path().starts_with("/v1/");
    let response = next.run(request).await;
    let status = response.status();
    if (status.is_client_error() || status.is_server_error())
        && !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json"))
    {
        let (code, message) = match status {
            StatusCode::NOT_FOUND => ("unknown_resource", "Unknown API route"),
            StatusCode::METHOD_NOT_ALLOWED => (
                "invalid_request",
                "HTTP method is not supported for this route",
            ),
            StatusCode::PAYLOAD_TOO_LARGE => ("invalid_request", "Request body is too large"),
            _ => ("invalid_request", "Request does not match the API contract"),
        };
        if inference {
            return (status,axum::Json(serde_json::json!({"error":{"code":code,"type":"invalid_request_error","message":message,"param":null}}))).into_response();
        }
        return ApiError(status, code, message.into()).into_response();
    }
    response
}
