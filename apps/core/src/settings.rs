use axum::{
    Extension, Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait};
use serde_json::{Value, json};

pub(crate) struct ApiError(pub StatusCode, pub &'static str, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": {"code": self.1, "message": self.2, "retryable": false, "details": null}, "request_id": uuid::Uuid::new_v4().to_string()}))).into_response()
    }
}

impl From<sea_orm::DbErr> for ApiError {
    fn from(error: sea_orm::DbErr) -> Self {
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), "Storage error: {error}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "Cannot access core storage".into(),
        )
    }
}

pub(crate) async fn read(
    Extension(db): Extension<DatabaseConnection>,
) -> Result<Json<Value>, ApiError> {
    let row = db
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT body FROM settings WHERE id=1",
        ))
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "core_not_ready",
                "Settings are missing".into(),
            )
        })?;
    let body: String = row.try_get("", "body")?;
    Ok(Json(serde_json::from_str(&body).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "Settings are corrupt".into(),
        )
    })?))
}

pub(crate) async fn update(
    Extension(db): Extension<DatabaseConnection>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if !body["drain_timeout_ms"].as_u64().is_some_and(|n| n > 0)
        || !body["compiler_jobs"].as_u64().is_some_and(|n| n > 0)
        || !body["revision"].is_string()
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Positive integer drain_timeout_ms/compiler_jobs and revision are required".into(),
        ));
    }
    let key = crate::commands::key(&headers)?;
    let request = body.clone();
    let tx = db.begin().await?;
    if let Some(response) = crate::commands::replay(&tx, &key, "PUT /settings", &request).await? {
        tx.commit().await?;
        return Ok(Json(response));
    }
    let revision = body["revision"].as_str().unwrap_or("").to_string();
    body["revision"] = json!(uuid::Uuid::new_v4().to_string());
    let changed = tx
        .execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "UPDATE settings SET body=? WHERE id=1 AND json_extract(body, '$.revision')=?",
            [body.to_string().into(), revision.into()],
        ))
        .await?;
    if changed.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "revision_conflict",
            "Settings have changed; reload before saving".into(),
        ));
    }
    crate::commands::remember(&tx, &key, "PUT /settings", &request, &body).await?;
    tx.commit().await?;
    Ok(Json(body))
}
