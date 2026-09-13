use crate::settings::ApiError;
use axum::{Extension, Json, extract::Path, http::StatusCode};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{Value, json};

pub(crate) async fn save<C: ConnectionTrait>(
    db: &C,
    table: &str,
    id: &str,
    body: &Value,
) -> Result<(), ApiError> {
    let mut body = body.clone();
    if table == "operations" {
        body["updated_at"] = json!(chrono::Utc::now().to_rfc3339());
    }
    db.execute(Statement::from_sql_and_values(DbBackend::Sqlite, format!("INSERT INTO {table}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body"), [id.into(), body.to_string().into()])).await?;
    Ok(())
}
pub(crate) async fn all<C: ConnectionTrait>(db: &C, table: &str) -> Result<Vec<Value>, ApiError> {
    db.query_all(Statement::from_string(
        DbBackend::Sqlite,
        format!("SELECT body FROM {table} ORDER BY rowid DESC"),
    ))
    .await?
    .into_iter()
    .map(|row| {
        let body: String = row.try_get("", "body")?;
        serde_json::from_str(&body).map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage_error",
                "Invalid saved record".into(),
            )
        })
    })
    .collect()
}
pub(crate) async fn find<C: ConnectionTrait>(
    db: &C,
    table: &str,
    id: &str,
) -> Result<Value, ApiError> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            format!("SELECT body FROM {table} WHERE id=?"),
            [id.into()],
        ))
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "unknown_resource",
                "Record does not exist".into(),
            )
        })?;
    let body: String = row.try_get("", "body")?;
    serde_json::from_str(&body).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "Invalid saved record".into(),
        )
    })
}
pub(crate) async fn read(
    Extension(db): Extension<DatabaseConnection>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(find(&db, "operations", &id).await?))
}
pub(crate) async fn list(
    Extension(db): Extension<DatabaseConnection>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        json!({"operations": all(&db, "operations").await?, "cursor": null}),
    ))
}

pub(crate) async fn cancel(
    Extension(db): Extension<DatabaseConnection>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    use sea_orm::TransactionTrait;
    let key = crate::commands::key(&headers)?;
    let action = format!("POST /operations/{id}/cancel");
    let body = json!({});
    let tx = db.begin().await?;
    if let Some(response) = crate::commands::replay(&tx, &key, &action, &body).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    let mut operation = find(&tx, "operations", &id).await?;
    if operation["status"] != "running"
        || !matches!(
            operation["type"].as_str(),
            Some("build" | "runtime_switch" | "build_apply")
        )
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "This operation cannot be cancelled".into(),
        ));
    }
    operation["cancel_requested"] = json!(true);
    save(&tx, "operations", &id, &operation).await?;
    let response = json!({"operation_id": id});
    crate::commands::remember(&tx, &key, &action, &body, &response).await?;
    tx.commit().await?;
    Ok((StatusCode::ACCEPTED, Json(response)))
}

pub(crate) async fn force(
    Extension(db): Extension<DatabaseConnection>,
    Extension(runtime): Extension<crate::runtime::Runtime>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    use sea_orm::TransactionTrait;
    let key = crate::commands::key(&headers)?;
    let action = format!("POST /operations/{id}/force");
    let tx = db.begin().await?;
    if let Some(response) = crate::commands::replay(&tx, &key, &action, &json!({})).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    let operation = find(&tx, "operations", &id).await?;
    if operation["status"] != "running"
        || !matches!(
            operation["type"].as_str(),
            Some("runtime_switch" | "build_apply")
        )
        || operation["phase"] != "waiting"
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Only a waiting runtime operation can be forced".into(),
        ));
    }
    let response = json!({"operation_id":id});
    crate::commands::remember(&tx, &key, &action, &json!({}), &response).await?;
    tx.commit().await?;
    runtime.3.send_modify(|generation| *generation += 1);
    Ok((StatusCode::ACCEPTED, Json(response)))
}
