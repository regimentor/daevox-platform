mod support;

#[tokio::test]
async fn a_second_core_cannot_open_the_same_data_directory() {
    let root = tempfile::tempdir().unwrap();
    let mut first = support::Core::start(root.path()).await;
    let second = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        support::command(root.path()).output(),
    )
    .await
    .expect("Second core must reject the occupied directory promptly")
    .unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("already in use"));
    assert_eq!(
        reqwest::get(format!("{}/v1/models", first.url))
            .await
            .unwrap()
            .status(),
        200
    );
    first.child.kill().await.unwrap();
    let _restarted = support::Core::start(root.path()).await;
}

#[tokio::test]
async fn settings_survive_a_core_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{}/settings", core.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let original: serde_json::Value = response.json().await.unwrap();
    assert_eq!(original["drain_timeout_ms"], 300000);
    assert_eq!(original["compiler_jobs"], 8);
    let response = client.put(format!("{}/settings", core.url))
        .header("Idempotency-Key", "settings-first")
        .json(&serde_json::json!({"drain_timeout_ms": 120000, "compiler_jobs": 2, "revision": original["revision"]}))
        .send().await.unwrap();
    assert_eq!(response.status(), 200);
    core.child.kill().await.unwrap();
    let restarted = support::Core::start(root.path()).await;
    let saved: serde_json::Value = client
        .get(format!("{}/settings", restarted.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved["drain_timeout_ms"], 120000);
    assert_eq!(saved["compiler_jobs"], 2);
    assert_ne!(saved["revision"], original["revision"]);
}

#[tokio::test]
async fn stale_settings_cannot_overwrite_a_newer_revision() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let original: serde_json::Value = client
        .get(format!("{}/settings", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let body = serde_json::json!({"drain_timeout_ms": 60000, "compiler_jobs": 4, "revision": original["revision"]});
    assert_eq!(
        client
            .put(format!("{}/settings", core.url))
            .header("Idempotency-Key", "first")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let rejected = client
        .put(format!("{}/settings", core.url))
        .header("Idempotency-Key", "stale")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), 412);
    assert_eq!(
        rejected.json::<serde_json::Value>().await.unwrap()["error"]["code"],
        "revision_conflict"
    );
}

#[tokio::test]
async fn invalid_settings_leave_the_saved_configuration_intact() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let url = format!("{}/settings", core.url);
    let original: serde_json::Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    for (drain, jobs) in [(0, 8), (300000, 0), (-1, 8), (300000, -1)] {
        let response = client.put(&url).header("Idempotency-Key", format!("invalid-{drain}-{jobs}"))
            .json(&serde_json::json!({"drain_timeout_ms": drain, "compiler_jobs": jobs, "revision": original["revision"]}))
            .send().await.unwrap();
        assert_eq!(response.status(), 400);
    }
    assert_eq!(
        client
            .get(&url)
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap(),
        original
    );
}

#[tokio::test]
async fn a_retried_settings_command_returns_its_original_result_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let original: serde_json::Value = client
        .get(format!("{}/settings", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let body = serde_json::json!({"drain_timeout_ms": 60000, "compiler_jobs": 4, "revision": original["revision"]});
    let response = client
        .put(format!("{}/settings", core.url))
        .header("Idempotency-Key", "retry")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let saved: serde_json::Value = response.json().await.unwrap();
    core.child.kill().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let replay = client
        .put(format!("{}/settings", core.url))
        .header("Idempotency-Key", "retry")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), 200);
    assert_eq!(replay.json::<serde_json::Value>().await.unwrap(), saved);
    let conflict = client.put(format!("{}/settings", core.url)).header("Idempotency-Key", "retry")
        .json(&serde_json::json!({"drain_timeout_ms": 60000, "compiler_jobs": 2, "revision": saved["revision"]})).send().await.unwrap();
    assert_eq!(conflict.status(), 409);
}

#[tokio::test]
async fn foreign_web_origins_cannot_change_core_settings() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let url = format!("{}/settings", core.url);
    let original: serde_json::Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    let response = client.put(&url).header("Origin", "https://untrusted.example")
        .header("Idempotency-Key", "foreign")
        .json(&serde_json::json!({"drain_timeout_ms": 60000, "compiler_jobs": 4, "revision": original["revision"]})).send().await.unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(
        client
            .get(&url)
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap(),
        original
    );
    assert_eq!(
        client
            .get(&url)
            .header("Origin", "http://localhost:5173")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .get(&url)
            .header("Host", "untrusted.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
}

#[tokio::test]
async fn migration_failure_preserves_a_consistent_backup_including_wal() {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("data")).unwrap();
    let db = Database::connect(format!(
        "sqlite:{}?mode=rwc",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    db.execute_unprepared("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserve me'); CREATE TABLE seaql_migrations(wrong_column TEXT);").await.unwrap();
    let result = support::command(root.path()).output().await.unwrap();
    assert!(!result.status.success());
    let backups: Vec<_> = std::fs::read_dir(root.path().join("data/backups"))
        .unwrap()
        .collect();
    assert_eq!(
        backups.len(),
        1,
        "Create backup even when migration metadata is malformed"
    );
    let path = backups[0].as_ref().unwrap().path();
    let copy = Database::connect(format!("sqlite:{}?mode=ro", path.display()))
        .await
        .unwrap();
    let row = copy
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT value FROM sentinel",
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<String>("", "value").unwrap(), "preserve me");
}

#[tokio::test]
async fn health_reports_core_liveness_without_an_active_model() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let response = reqwest::get(format!("{}/health", core.url)).await.unwrap();
    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn startup_retains_unfinished_command_keys_and_prunes_only_old_completed_history() {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use serde_json::json;
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start(root.path()).await;
    core.child.kill().await.unwrap();
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    for (id, status, time) in [
        ("old", "succeeded", "2000-01-01T00:00:00Z"),
        ("unfinished", "paused", "2000-01-01T00:00:00Z"),
        ("recent", "succeeded", "2099-01-01T00:00:00Z"),
    ] {
        let operation = json!({"id":id,"type":"download","status":status,"phase":status,"resource_id":"fixture","created_at":"2000-01-01T00:00:00Z","updated_at":time,"progress":null,"error":null,"allowed_actions":[]});
        db.execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT INTO operations(id,body) VALUES(?,?)",
            [id.into(), operation.to_string().into()],
        ))
        .await
        .unwrap();
        db.execute(Statement::from_sql_and_values(DbBackend::Sqlite,"INSERT INTO request_keys(key,action,request,response,expires_at) VALUES(?,'POST /downloads','{}',?,1)",[id.into(),json!({"operation_id":id}).to_string().into()])).await.unwrap();
    }
    db.close().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let list: serde_json::Value = client
        .get(format!("{}/operations", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let ids: Vec<_> = list["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap())
        .collect();
    assert!(!ids.contains(&"old"));
    assert!(ids.contains(&"unfinished"));
    assert!(ids.contains(&"recent"));
    for key in ["unfinished", "recent"] {
        let response = client
            .post(format!("{}/downloads", core.url))
            .header("Idempotency-Key", key)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            202,
            "{key} must retain its accepted result"
        );
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap()["operation_id"],
            key
        );
    }
}

#[tokio::test]
async fn malformed_management_requests_use_the_published_error_envelope() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let response = reqwest::Client::new()
        .put(format!("{}/settings", core.url))
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", "invalid-json")
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let error: serde_json::Value = response.json().await.expect("Errors must be JSON");
    assert_eq!(error["error"]["code"], "invalid_request");
    assert!(error["request_id"].is_string());
    assert_eq!(error["error"]["retryable"], false);
}
