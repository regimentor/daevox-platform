mod support;
use axum::{
    Json, Router,
    http::{HeaderMap, StatusCode},
    routing::get,
};
use serde_json::{Value, json};

#[tokio::test]
async fn searching_public_models_does_not_send_an_inherited_hf_token() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/api/models", get(|headers: HeaderMap| async move {
            if headers.contains_key("authorization") { return (StatusCode::UNAUTHORIZED, Json(json!({"error":"Public metadata must be anonymous"}))); }
            (StatusCode::OK, Json(json!([{"id":"fixture/small-GGUF","private":false,"gated":false,"downloads":42}])))
        }))).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command
        .env("CORE_HUB_ENDPOINT", endpoint)
        .env("HF_TOKEN", "hf_test_do_not_send");
    let core = support::Core::start_command(command).await;
    let response = reqwest::get(format!("{}/hub/models?q=small", core.url))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let results: Value = response.json().await.unwrap();
    assert_eq!(results["models"][0]["id"], "fixture/small-GGUF");
    fixture.abort();
}

#[tokio::test]
async fn hub_file_selection_is_bound_to_a_resolved_commit_and_keeps_shards_and_projector() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route("/api/models/fixture/vision/revision/main", get(move || async move { Json(json!({"id":"fixture/vision", "sha":commit, "private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/vision/tree/{commit}"), get(|| async { Json(json!([
                {"type":"file","path":"model-Q4-00001-of-00002.gguf","size":100,"oid":"a"},
                {"type":"file","path":"model-Q4-00002-of-00002.gguf","size":80,"oid":"b"},
                {"type":"file","path":"mmproj-f16.gguf","size":20,"oid":"c"},
                {"type":"file","path":"README.md","size":10,"oid":"d"}
            ])) }))).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let response = reqwest::get(format!(
        "{}/hub/files?repo=fixture/vision&revision=main",
        core.url
    ))
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let result: Value = response.json().await.unwrap();
    assert_eq!(result["commit"], commit);
    assert_eq!(result["files"].as_array().unwrap().len(), 3);
    assert_eq!(result["files"][0]["role"], "shard");
    assert_eq!(result["files"][2]["role"], "projector");
    fixture.abort();
}

#[tokio::test]
async fn public_search_can_continue_using_an_opaque_cursor() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener,Router::new().route("/api/models",get(|| async {
            Json((0..25).map(|n|json!({"id":format!("fixture/model-{n}"),"private":false,"gated":false})).collect::<Vec<_>>())
        }))).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let first: Value = reqwest::get(format!("{}/hub/models?q=model", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["models"].as_array().unwrap().len(), 20);
    let cursor = first["cursor"]
        .as_str()
        .expect("More results require a cursor");
    let next: Value = reqwest::get(format!("{}/hub/models?q=model&cursor={cursor}", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(next["models"].as_array().unwrap().len(), 5);
    assert_eq!(next["models"][0]["id"], "fixture/model-20");
    assert!(next["cursor"].is_null());
    fixture.abort();
}

#[tokio::test]
async fn private_and_gated_repositories_are_rejected_without_fetching_weights() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener,Router::new()
            .route("/api/models/fixture/private/revision/main",get(||async {Json(json!({"id":"fixture/private","sha":"0123456789012345678901234567890123456789","private":true,"gated":false}))}))
            .route("/api/models/fixture/gated/revision/main",get(||async {Json(json!({"id":"fixture/gated","sha":"0123456789012345678901234567890123456789","private":false,"gated":"manual"}))}))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    for repo in ["private", "gated"] {
        let response = reqwest::get(format!(
            "{}/hub/files?repo=fixture/{repo}&revision=main",
            core.url
        ))
        .await
        .unwrap();
        assert_eq!(response.status(), 403);
        let error: Value = response.json().await.unwrap();
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("gated")
        );
    }
    fixture.abort();
}
