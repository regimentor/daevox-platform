use crate::settings::ApiError;
use axum::http::{HeaderMap, StatusCode};
use sea_orm::{ConnectionTrait, DatabaseTransaction, DbBackend, Statement};
use serde_json::Value;

pub(crate) fn key(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get("Idempotency-Key")
        .and_then(|s| s.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Idempotency-Key is required (1–256 bytes)".into(),
            )
        })
}

pub(crate) async fn replay(
    tx: &DatabaseTransaction,
    key: &str,
    action: &str,
    body: &Value,
) -> Result<Option<Value>, ApiError> {
    prune(tx).await?;
    if let Some(row) = tx
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT action, request, response FROM request_keys WHERE key=?",
            [key.into()],
        ))
        .await?
    {
        let prior_action: String = row.try_get("", "action")?;
        let prior_body: String = row.try_get("", "request")?;
        let requested_body = body.to_string();
        if prior_action != action || prior_body != requested_body {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "This key belongs to a different command".into(),
            ));
        }
        let response: String = row.try_get("", "response")?;
        return Ok(Some(serde_json::from_str(&response).map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage_error",
                "Stored command result is corrupt".into(),
            )
        })?));
    }
    Ok(None)
}

pub(crate) async fn remember(
    tx: &DatabaseTransaction,
    key: &str,
    action: &str,
    request: &Value,
    response: &Value,
) -> Result<(), ApiError> {
    tx.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
        "INSERT INTO request_keys(key,action,request,response,expires_at) VALUES(?,?,?,?,unixepoch()+604800)",
        [key.into(), action.into(), request.to_string().into(), response.to_string().into()])).await?;
    Ok(())
}

pub(crate) async fn prune<C: ConnectionTrait>(db: &C) -> Result<(), ApiError> {
    // Async commands retain their key until seven days after completion, even
    // when accepted more than seven days ago. Paused work is unresolved.
    db.execute_unprepared("UPDATE request_keys SET expires_at=(SELECT CASE WHEN json_extract(body,'$.status') IN ('succeeded','failed','cancelled','interrupted') THEN unixepoch(json_extract(body,'$.updated_at'))+604800 ELSE NULL END FROM operations WHERE id=json_extract(request_keys.response,'$.operation_id')) WHERE EXISTS(SELECT 1 FROM operations WHERE id=json_extract(request_keys.response,'$.operation_id')); DELETE FROM request_keys WHERE expires_at IS NOT NULL AND expires_at<=unixepoch(); UPDATE model_sets SET body=json_set(body,'$.download_operation_id',NULL) WHERE json_extract(body,'$.download_operation_id') IN (SELECT id FROM operations WHERE json_extract(body,'$.status') IN ('succeeded','failed','cancelled','interrupted') AND unixepoch(json_extract(body,'$.updated_at'))<=unixepoch()-604800); DELETE FROM operations WHERE json_extract(body,'$.status') IN ('succeeded','failed','cancelled','interrupted') AND unixepoch(json_extract(body,'$.updated_at'))<=unixepoch()-604800;").await?;
    Ok(())
}
