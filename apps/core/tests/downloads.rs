mod support;
use axum::{Json, Router, routing::get};
use serde_json::{Value, json};

#[tokio::test]
async fn a_selected_file_becomes_an_available_model_set_and_repeated_selection_is_deduplicated() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route(&format!("/api/models/fixture/small/revision/{commit}"), get(move || async move { Json(json!({"id":"fixture/small","sha":commit,"private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/small/tree/{commit}"), get(|| async { Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"}])) }))
            .route(&format!("/fixture/small/resolve/{commit}/model.gguf"), get(|| async { ([("etag","\"fixture-v1\""),("content-length","16")], "fixture GGUF!!!!") }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let body = json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]});
    let response = client
        .post(format!("{}/downloads", core.url))
        .header("Idempotency-Key", "download")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let sets: Value = client
                .get(format!("{}/model-sets", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if sets["model_sets"][0]["availability"] == "available" {
                assert_eq!(sets["model_sets"][0]["files"][0]["downloaded_bytes"], 16);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    client
        .post(format!("{}/downloads", core.url))
        .header("Idempotency-Key", "same-selection")
        .json(&body)
        .send()
        .await
        .unwrap();
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sets["model_sets"].as_array().unwrap().len(), 1);
    let staging = std::process::Command::new("rg")
        .args(["--files", "--hidden", "--no-ignore"])
        .arg(root.path().join("data/downloads"))
        .output()
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&staging.stdout).contains(".partial"),
        "Completed downloads must leave staging so deleting the model actually releases its bytes"
    );
    fixture.abort();
}

#[tokio::test]
async fn a_paused_download_resumes_after_core_restart_using_range() {
    use axum::{
        http::{HeaderMap, Method, StatusCode},
        response::IntoResponse,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let commit = "0123456789012345678901234567890123456789";
    let size = 4 * 1024 * 1024u64;
    let started = Arc::new(AtomicBool::new(false));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route(&format!("/api/models/fixture/large/revision/{commit}"), get(move || async move { Json(json!({"id":"fixture/large","sha":commit,"private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/large/tree/{commit}"), get(move || async move { Json(json!([{"type":"file","path":"model.gguf","size":size,"oid":"a"}])) }))
            .route(&format!("/fixture/large/resolve/{commit}/model.gguf"), get(move |method: Method, headers: HeaderMap| {
                let started = started.clone();
                async move {
                    if method == Method::HEAD { return ([("etag","\"stable\""),("content-length","4194304")], "").into_response(); }
                    let range = headers.get("range").and_then(|h| h.to_str().ok());
                    let offset = range.and_then(|s| s.strip_prefix("bytes=")).and_then(|s| s.split('-').next()).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                    if started.swap(true,Ordering::SeqCst) && (offset == 0 || headers.get("if-range").and_then(|h|h.to_str().ok()) != Some("\"stable\"")) { return StatusCode::CONFLICT.into_response(); }
                    let stream = async_stream::stream! {
                        let mut left = size - offset;
                        while left > 0 {
                            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                            let n = left.min(65536); left -= n;
                            yield Ok::<_, std::io::Error>(vec![b'x'; n as usize]);
                        }
                    };
                    let mut response = axum::body::Body::from_stream(stream).into_response();
                    response.headers_mut().insert("etag", "\"stable\"".parse().unwrap());
                    response.headers_mut().insert("content-length", (size-offset).to_string().parse().unwrap());
                    if offset > 0 { *response.status_mut() = StatusCode::PARTIAL_CONTENT; response.headers_mut().insert("content-range",format!("bytes {offset}-{}/{size}",size-1).parse().unwrap()); }
                    response
                }
            }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", &endpoint);
    let mut core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let accepted: Value = client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","large")
        .json(&json!({"repo_id":"fixture/large","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let op: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if op["progress"]["bytes_done"].as_u64().unwrap_or(0) > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Download progress must become observable before completion");
    let paused = client
        .post(format!("{}/downloads/{id}/pause", core.url))
        .header("Idempotency-Key", "pause")
        .send()
        .await
        .unwrap();
    assert_eq!(paused.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let op: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if op["status"] == "paused" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    core.child.kill().await.unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let op: Value = client
        .get(format!("{}/operations/{id}", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(op["status"], "paused");
    let resumed = client
        .post(format!("{}/downloads/{id}/resume", core.url))
        .header("Idempotency-Key", "resume")
        .send()
        .await
        .unwrap();
    assert_eq!(resumed.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let op: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_ne!(op["status"], "failed", "{op}");
            if op["status"] == "succeeded" {
                assert_eq!(op["progress"]["bytes_done"], size);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    fixture.abort();
}

#[tokio::test]
async fn cancelling_a_download_does_not_publish_unfinished_files() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener,Router::new()
            .route(&format!("/api/models/fixture/cancel/revision/{commit}"),get(move||async move{Json(json!({"id":"fixture/cancel","sha":commit,"private":false,"gated":false}))}))
            .route(&format!("/api/models/fixture/cancel/tree/{commit}"),get(||async{Json(json!([{"type":"file","path":"model.gguf","size":1048576,"oid":"a"}]))}))
            .route(&format!("/fixture/cancel/resolve/{commit}/model.gguf"),get(||async{
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                ([("etag","\"cancel\"")],vec![0u8;1048576])
            }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let accepted:Value=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","cancel-me")
        .json(&json!({"repo_id":"fixture/cancel","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    let response = client
        .post(format!("{}/downloads/{id}/cancel", core.url))
        .header("Idempotency-Key", "cancel")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let op: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if op["status"] == "cancelled" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(sets["model_sets"][0]["availability"], "available");
    fixture.abort();
}

#[tokio::test]
async fn unsafe_range_responses_preserve_partial_until_explicit_file_restart() {
    use axum::{
        http::{Method, StatusCode},
        response::IntoResponse,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    for variant in ["ignore-range", "bad-content-range", "changed-etag", "416"] {
        let commit = "0123456789012345678901234567890123456789";
        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let fixture = tokio::spawn(async move {
            axum::serve(listener,Router::new()
            .route(&format!("/api/models/fixture/range/revision/{commit}"),get(move||async move{Json(json!({"id":"fixture/range","sha":commit,"private":false,"gated":false}))}))
            .route(&format!("/api/models/fixture/range/tree/{commit}"),get(||async{Json(json!([{"type":"file","path":"model.gguf","size":131072,"oid":"a"}]))}))
            .route(&format!("/fixture/range/resolve/{commit}/model.gguf"),get(move|method:Method,headers:axum::http::HeaderMap|{let calls=calls.clone();async move{
                if method==Method::HEAD{return ([("etag","\"stable\""),("content-length","131072")],"").into_response();}
                let n=calls.fetch_add(1,Ordering::SeqCst);
                if headers.contains_key("range") && variant != "ignore-range" {
                    let status=if variant=="416" {StatusCode::RANGE_NOT_SATISFIABLE} else {StatusCode::PARTIAL_CONTENT};
                    let range=if variant=="bad-content-range" {"bytes 0-65535/131072"} else {"bytes 65536-131071/131072"};
                    let etag=if variant=="changed-etag" {"\"changed\""} else {"\"stable\""};
                    return (status,[("etag",etag),("content-range",range)],vec![b'y';65536]).into_response();
                }
                let stream=async_stream::stream!{
                    yield Ok::<_,std::io::Error>(vec![b'x';65536]);
                    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                    if n==0{yield Err(std::io::Error::other("fixture interrupted"));}else{yield Ok(vec![b'x';65536]);}
                };
                let mut response=axum::body::Body::from_stream(stream).into_response();
                *response.status_mut()=StatusCode::OK; response.headers_mut().insert("etag","\"stable\"".parse().unwrap()); response.headers_mut().insert("content-length","131072".parse().unwrap());response
            }}))
        ).await.unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let mut command = support::command(root.path());
        command.env("CORE_HUB_ENDPOINT", endpoint);
        let core = support::Core::start_command(command).await;
        let client = reqwest::Client::new();
        let accepted:Value=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","range")
        .json(&json!({"repo_id":"fixture/range","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
        let id = accepted["operation_id"].as_str().unwrap();
        async fn terminal(client: &reqwest::Client, url: String) -> Value {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let op: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
                    if matches!(op["status"].as_str(), Some("failed" | "succeeded")) {
                        break op;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap()
        }
        let url = format!("{}/operations/{id}", core.url);
        let first = terminal(&client, url.clone()).await;
        assert_eq!(first["status"], "failed");
        assert_eq!(first["progress"]["bytes_done"], 65536);
        client
            .post(format!("{}/downloads/{id}/resume", core.url))
            .header("Idempotency-Key", "resume")
            .send()
            .await
            .unwrap();
        let second = terminal(&client, url.clone()).await;
        assert_eq!(second["status"], "failed");
        assert_eq!(second["progress"]["bytes_done"], 65536);
        let sets: Value = client
            .get(format!("{}/model-sets", core.url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let file_id = &sets["model_sets"][0]["files"][0]["id"];
        let response = client
            .post(format!("{}/downloads/{id}/restart-file", core.url))
            .header("Idempotency-Key", "restart")
            .json(&json!({"file_id":file_id}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 202);
        let final_op = terminal(&client, url).await;
        assert_eq!(final_op["status"], "succeeded", "{final_op}");
        assert_eq!(final_op["progress"]["bytes_done"], 131072);
        fixture.abort();
    }
}

#[tokio::test]
async fn a_second_model_set_reuses_a_completed_shared_file() {
    use axum::{http::StatusCode, response::IntoResponse};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let commit = "0123456789012345678901234567890123456789";
    let reads = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener,Router::new()
            .route(&format!("/api/models/fixture/shared/revision/{commit}"),get(move||async move{Json(json!({"id":"fixture/shared","sha":commit,"private":false,"gated":false}))}))
            .route(&format!("/api/models/fixture/shared/tree/{commit}"),get(||async{Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"},{"type":"file","path":"mmproj.gguf","size":8,"oid":"b"}]))}))
            .route(&format!("/fixture/shared/resolve/{commit}/model.gguf"),get(move|method:axum::http::Method|{let reads=reads.clone();async move{
                if method==axum::http::Method::HEAD{return ([("etag","\"weights\""),("content-length","16")],"").into_response();}
                if reads.fetch_add(1,Ordering::SeqCst)>0{return StatusCode::GONE.into_response();}
                ([("etag","\"weights\"")],"fixture GGUF!!!!").into_response()
            }}))
            .route(&format!("/fixture/shared/resolve/{commit}/mmproj.gguf"),get(||async{([("etag","\"projector\"")],"project!")}))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    for (key, files) in [
        ("weights", json!([{"path":"model.gguf","role":"weights"}])),
        (
            "vision",
            json!([{"path":"model.gguf","role":"weights"},{"path":"mmproj.gguf","role":"projector"}]),
        ),
    ] {
        let accepted: Value = client
            .post(format!("{}/downloads", core.url))
            .header("Idempotency-Key", key)
            .json(&json!({"repo_id":"fixture/shared","commit":commit,"files":files}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let op: Value = client
                    .get(format!(
                        "{}/operations/{}",
                        core.url,
                        accepted["operation_id"].as_str().unwrap()
                    ))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                assert_ne!(op["status"], "failed", "{op}");
                if op["status"] == "succeeded" {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sets["model_sets"].as_array().unwrap().len(), 2);
    fixture.abort();
}

#[tokio::test]
async fn deleting_a_model_set_requires_a_fresh_reference_preview_and_preserves_source_text() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener,Router::new()
        .route(&format!("/api/models/fixture/small/revision/{commit}"),get(move||async move{Json(json!({"id":"fixture/small","sha":commit,"private":false,"gated":false}))}))
        .route(&format!("/api/models/fixture/small/tree/{commit}"),get(||async{Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"}]))}))
        .route(&format!("/fixture/small/resolve/{commit}/model.gguf"),get(||async{([("etag","\"v1\""),("content-length","16")],"fixture GGUF!!!!")}))
    ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let accepted:Value=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","get-model").json(&json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    let id = accepted["model_set_id"].as_str().unwrap();
    let set = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let sets: Value = client
                .get(format!("{}/model-sets", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if sets["model_sets"][0]["availability"] == "available" {
                break sets["model_sets"][0].clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let text = format!(
        "[linked]\nmodel=../data/models/{}\n",
        set["files"][0]["local_path"].as_str().unwrap()
    );
    let source: Value = client
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "link-preset")
        .json(&json!({"name":"linked.ini","text":text}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let preview = client
        .get(format!("{}/model-sets/{id}/references", core.url))
        .send()
        .await
        .unwrap();
    assert_eq!(preview.status(), 200);
    let preview: Value = preview.json().await.unwrap();
    assert_eq!(preview["preset_ids"], json!(["linked"]));
    let url = format!("{}/model-sets/{id}", core.url);
    let response = client
        .delete(&url)
        .header("Idempotency-Key", "stale-delete")
        .json(&json!({"revision":"stale"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 412);
    let response = client
        .delete(&url)
        .header("Idempotency-Key", "delete-set")
        .json(&json!({"revision":preview["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(sets["model_sets"].as_array().unwrap().is_empty());
    let saved: Value = client
        .get(format!(
            "{}/preset-files/{}",
            core.url,
            source["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved["text"], text);
    let presets: Value = client
        .get(format!("{}/presets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(presets["presets"][0]["can_launch"], false);
    fixture.abort();
}

#[tokio::test]
async fn local_catalog_links_presets_to_the_downloaded_set_and_detects_missing_files() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener,Router::new()
        .route(&format!("/api/models/fixture/small/revision/{commit}"),get(move||async move{Json(json!({"id":"fixture/small","sha":commit,"private":false,"gated":false}))}))
        .route(&format!("/api/models/fixture/small/tree/{commit}"),get(||async{Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"}]))}))
        .route(&format!("/fixture/small/resolve/{commit}/model.gguf"),get(||async{([("etag","\"v1\""),("content-length","16")],"fixture GGUF!!!!")}))
    ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let accepted:Value=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","get-model").json(&json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    let id = accepted["model_set_id"].as_str().unwrap();
    let set = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let sets: Value = client
                .get(format!("{}/model-sets", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if sets["model_sets"][0]["availability"] == "available" {
                break sets["model_sets"][0].clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let text = format!(
        "[linked]\nmodel=../data/models/{}\n",
        set["files"][0]["local_path"].as_str().unwrap()
    );
    let source: Value = client
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "link-preset")
        .json(&json!({"name":"linked.ini","text":text}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let presets: Value = client
        .get(format!("{}/presets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(presets["presets"][0]["model_set_id"], id);
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sets["model_sets"][0]["preset_ids"], json!(["linked"]));
    std::fs::remove_file(
        root.path()
            .join("data/models")
            .join(set["files"][0]["local_path"].as_str().unwrap()),
    )
    .unwrap();
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sets["model_sets"][0]["availability"], "missing");
    assert_eq!(sets["model_sets"][0]["files"][0]["availability"], "missing");
    assert_eq!(source["text"], text);
    let repeated:Value=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","restore-missing")
        .json(&json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    assert_ne!(
        repeated["operation_id"], accepted["operation_id"],
        "A missing file needs new work, not the old successful operation"
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let sets: Value = client
                .get(format!("{}/model-sets", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if sets["model_sets"][0]["availability"] == "available" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    fixture.abort();
}

#[tokio::test]
async fn a_cancelled_selection_can_start_a_new_download_with_a_new_command_key() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener,Router::new()
            .route(&format!("/api/models/fixture/cancel/revision/{commit}"),get(move||async move{Json(json!({"id":"fixture/cancel","sha":commit,"private":false,"gated":false}))}))
            .route(&format!("/api/models/fixture/cancel/tree/{commit}"),get(||async{Json(json!([{"type":"file","path":"model.gguf","size":1048576,"oid":"a"}]))}))
            .route(&format!("/fixture/cancel/resolve/{commit}/model.gguf"),get(||async{
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                ([("etag","\"cancel\"")],vec![0u8;1048576])
            }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let accepted:Value=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","cancel-me")
        .json(&json!({"repo_id":"fixture/cancel","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    let response = client
        .post(format!("{}/downloads/{id}/cancel", core.url))
        .header("Idempotency-Key", "cancel")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let op: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if op["status"] == "cancelled" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(sets["model_sets"][0]["availability"], "available");

    let next:Value=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","download-again")
        .json(&json!({"repo_id":"fixture/cancel","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    assert_ne!(next["operation_id"], accepted["operation_id"]);
    assert_eq!(next["model_set_id"], accepted["model_set_id"]);
    let operation: Value = client
        .get(format!(
            "{}/operations/{}",
            core.url,
            next["operation_id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(matches!(
        operation["status"].as_str(),
        Some("queued" | "running")
    ));
    client
        .post(format!(
            "{}/downloads/{}/cancel",
            core.url,
            next["operation_id"].as_str().unwrap()
        ))
        .header("Idempotency-Key", "cleanup-again")
        .send()
        .await
        .unwrap();
    fixture.abort();
}

#[tokio::test]
async fn repeating_an_accepted_download_does_not_require_the_hub_to_be_online() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route(&format!("/api/models/fixture/small/revision/{commit}"), get(move || async move { Json(json!({"id":"fixture/small","sha":commit,"private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/small/tree/{commit}"), get(|| async { Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"}])) }))
            .route(&format!("/fixture/small/resolve/{commit}/model.gguf"), get(|| async { ([("etag","\"fixture-v1\""),("content-length","16")], "fixture GGUF!!!!") }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let body = json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]});
    let response = client
        .post(format!("{}/downloads", core.url))
        .header("Idempotency-Key", "download")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);

    let accepted: Value = response.json().await.unwrap();
    fixture.abort();
    let response = client
        .post(format!("{}/downloads", core.url))
        .header("Idempotency-Key", "download")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    assert_eq!(response.json::<Value>().await.unwrap(), accepted);
}

#[tokio::test]
async fn replacing_the_core_executable_does_not_break_new_download_workers() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route(&format!("/api/models/fixture/small/revision/{commit}"), get(move || async move { Json(json!({"id":"fixture/small","sha":commit,"private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/small/tree/{commit}"), get(|| async { Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"}])) }))
            .route(&format!("/fixture/small/resolve/{commit}/model.gguf"), get(|| async { ([("etag","\"fixture-v1\""),("content-length","16")], "fixture GGUF!!!!") }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("core-program");
    std::fs::copy(env!("CARGO_BIN_EXE_core"), &executable).unwrap();
    let mut command = tokio::process::Command::new(&executable);
    command
        .env("CORE_PORT", "0")
        .env("CORE_APP_DIR", root.path())
        .env("CORE_AUTO_BUILD", "0")
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let replacement = root.path().join("replacement");
    std::fs::copy(env!("CARGO_BIN_EXE_core"), &replacement).unwrap();
    std::fs::rename(replacement, &executable).unwrap();
    let client = reqwest::Client::new();
    let body = json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]});
    let response = client
        .post(format!("{}/downloads", core.url))
        .header("Idempotency-Key", "download")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let sets: Value = client
                .get(format!("{}/model-sets", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if sets["model_sets"][0]["availability"] == "available" {
                assert_eq!(sets["model_sets"][0]["files"][0]["downloaded_bytes"], 16);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    client
        .post(format!("{}/downloads", core.url))
        .header("Idempotency-Key", "same-selection")
        .json(&body)
        .send()
        .await
        .unwrap();
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sets["model_sets"].as_array().unwrap().len(), 1);
    fixture.abort();
}

#[tokio::test]
async fn split_weights_require_one_complete_quantization_and_are_published_as_siblings() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route(&format!("/api/models/fixture/split/revision/{commit}"), get(move || async move { Json(json!({"id":"fixture/split","sha":commit,"private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/split/tree/{commit}"), get(|| async { Json(json!([
                {"type":"file","path":"q4/model-00001-of-00002.gguf","size":16,"oid":"a"},
                {"type":"file","path":"q4/model-00002-of-00002.gguf","size":16,"oid":"b"},
                {"type":"file","path":"q8.gguf","size":16,"oid":"c"},
                {"type":"file","path":"mmproj.gguf","size":16,"oid":"d"}
            ])) }))
            .route(&format!("/fixture/split/resolve/{commit}/{{*file}}"), get(|| async { ([("etag","\"split-v1\""),("content-length","16")], "fixture GGUF!!!!") }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    for (key, files) in [
        (
            "incomplete",
            json!([{"path":"q4/model-00001-of-00002.gguf","role":"shard"}]),
        ),
        (
            "mixed",
            json!([{"path":"q4/model-00001-of-00002.gguf","role":"shard"},{"path":"q4/model-00002-of-00002.gguf","role":"shard"},{"path":"q8.gguf","role":"weights"}]),
        ),
        (
            "projector-only",
            json!([{"path":"mmproj.gguf","role":"projector"}]),
        ),
    ] {
        let response = client
            .post(format!("{}/downloads", core.url))
            .header("Idempotency-Key", key)
            .json(&json!({"repo_id":"fixture/split","commit":commit,"files":files}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400, "{key}");
    }
    let response=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","complete").json(&json!({"repo_id":"fixture/split","commit":commit,"files":[{"path":"q4/model-00001-of-00002.gguf","role":"shard"},{"path":"q4/model-00002-of-00002.gguf","role":"shard"},{"path":"mmproj.gguf","role":"projector"}]})).send().await.unwrap();
    assert_eq!(response.status(), 202);
    let set = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let sets: Value = client
                .get(format!("{}/model-sets", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if sets["model_sets"][0]["availability"] == "available" {
                break sets["model_sets"][0].clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let weights: Vec<_> = set["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["role"] == "shard")
        .collect();
    let first = root
        .path()
        .join("data/models")
        .join(weights[0]["local_path"].as_str().unwrap());
    let sibling = first.with_file_name("model-00002-of-00002.gguf");
    assert_eq!(std::fs::read(sibling).unwrap(), b"fixture GGUF!!!!");
    fixture.abort();
}

#[tokio::test]
async fn a_download_with_unknown_hub_size_reports_the_bytes_actually_written() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener,Router::new()
        .route(&format!("/api/models/fixture/unknown/revision/{commit}"),get(move||async move{Json(json!({"id":"fixture/unknown","sha":commit,"private":false,"gated":false}))}))
        .route(&format!("/api/models/fixture/unknown/tree/{commit}"),get(||async{Json(json!([{"type":"file","path":"model.gguf","size":134,"oid":"a","lfs":{"size":null,"sha256":"a","pointerSize":134}}]))}))
        .route(&format!("/fixture/unknown/resolve/{commit}/model.gguf"),get(||async{([("etag","\"unknown-v1\""),("content-length","16")],"fixture GGUF!!!!")}))
    ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let accepted:Value=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","unknown").json(&json!({"repo_id":"fixture/unknown","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    assert!(accepted["operation_id"].is_string(), "{accepted}");
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let op: Value = client
                .get(format!(
                    "{}/operations/{}",
                    core.url,
                    accepted["operation_id"].as_str().unwrap()
                ))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_ne!(op["status"], "failed", "{op}");
            if op["status"] == "succeeded" {
                assert_eq!(op["progress"]["bytes_done"], 16);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sets["model_sets"][0]["files"][0]["downloaded_bytes"], 16);
    fixture.abort();
}

#[tokio::test]
async fn queued_download_waits_until_crash_recovery_is_resolved() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route(&format!("/api/models/fixture/small/revision/{commit}"), get(move || async move { Json(json!({"id":"fixture/small","sha":commit,"private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/small/tree/{commit}"), get(|| async { Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"}])) }))
            .route(&format!("/fixture/small/resolve/{commit}/model.gguf"), get(|| async { ([("etag","\"fixture-v1\""),("content-length","16")], "fixture GGUF!!!!") }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut old = support::with_fixture_toolchain(root.path()).await;
    support::ready(&old, root.path()).await;
    old.child.kill().await.unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let body = json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]});
    let response = client
        .post(format!("{}/downloads", core.url))
        .header("Idempotency-Key", "download")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let accepted: Value = response.json().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let operation: Value = client
        .get(format!(
            "{}/operations/{}",
            core.url,
            accepted["operation_id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        operation["status"], "queued",
        "No second worker may start while old processes survive"
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let state: Value = client
                .get(format!("{}/runtime", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["recovery"].as_array().unwrap().is_empty() {
                break;
            }
            for process in state["recovery"].as_array().unwrap() {
                assert_eq!(
                    client
                        .post(format!(
                            "{}/recovery/{}/stop",
                            core.url,
                            process["id"].as_str().unwrap()
                        ))
                        .header("Idempotency-Key", uuid::Uuid::new_v4().to_string())
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    202
                );
            }
        }
    })
    .await
    .unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let sets: Value = client
                .get(format!("{}/model-sets", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if sets["model_sets"][0]["availability"] == "available" {
                assert_eq!(sets["model_sets"][0]["files"][0]["downloaded_bytes"], 16);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    fixture.abort();
}

#[tokio::test]
async fn a_failed_model_set_deletion_preserves_its_completed_files() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener,Router::new()
        .route(&format!("/api/models/fixture/small/revision/{commit}"),get(move||async move{Json(json!({"id":"fixture/small","sha":commit,"private":false,"gated":false}))}))
        .route(&format!("/api/models/fixture/small/tree/{commit}"),get(||async{Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"}]))}))
        .route(&format!("/fixture/small/resolve/{commit}/model.gguf"),get(||async{([("etag","\"v1\""),("content-length","16")],"fixture GGUF!!!!")}))
    ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let accepted:Value=client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","get-model").json(&json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    let id = accepted["model_set_id"].as_str().unwrap();
    let set = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let sets: Value = client
                .get(format!("{}/model-sets", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if sets["model_sets"][0]["availability"] == "available" {
                break sets["model_sets"][0].clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let text = format!(
        "[linked]\nmodel=../data/models/{}\n",
        set["files"][0]["local_path"].as_str().unwrap()
    );
    let _source: Value = client
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "link-preset")
        .json(&json!({"name":"linked.ini","text":text}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let preview = client
        .get(format!("{}/model-sets/{id}/references", core.url))
        .send()
        .await
        .unwrap();
    assert_eq!(preview.status(), 200);
    let preview: Value = preview.json().await.unwrap();
    assert_eq!(preview["preset_ids"], json!(["linked"]));
    let url = format!("{}/model-sets/{id}", core.url);
    use sea_orm::{ConnectionTrait, Database};
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    db.execute_unprepared("CREATE TRIGGER fail_command BEFORE INSERT ON request_keys BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END").await.unwrap();
    assert_eq!(
        client
            .delete(&url)
            .header("Idempotency-Key", "failed-delete-set")
            .json(&json!({"revision":preview["revision"]}))
            .send()
            .await
            .unwrap()
            .status(),
        500
    );
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        sets["model_sets"][0]["availability"], "available",
        "Failed deletion must preserve completed files"
    );
    fixture.abort();
}

#[tokio::test]
async fn a_publication_storage_failure_can_retry_completed_worker_files_without_redownloading() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route(&format!("/api/models/fixture/small/revision/{commit}"), get(move || async move { Json(json!({"id":"fixture/small","sha":commit,"private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/small/tree/{commit}"), get(|| async { Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"}])) }))
            .route(&format!("/fixture/small/resolve/{commit}/model.gguf"), get(|| async { ([("etag","\"fixture-v1\""),("content-length","16")], "fixture GGUF!!!!") }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let body = json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]});
    use sea_orm::{ConnectionTrait, Database};
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    db.execute_unprepared("CREATE TRIGGER fail_publication BEFORE INSERT ON model_files WHEN json_extract(NEW.body,'$.availability')='available' BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END").await.unwrap();
    let response = client
        .post(format!("{}/downloads", core.url))
        .header("Idempotency-Key", "download")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let accepted: Value = response.json().await.unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let operation: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if operation["status"] == "failed" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    db.execute_unprepared("DROP TRIGGER fail_publication")
        .await
        .unwrap();
    fixture.abort();
    assert_eq!(
        client
            .post(format!("{}/downloads/{id}/resume", core.url))
            .header("Idempotency-Key", "retry-publication")
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let operation: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_ne!(
                operation["status"], "failed",
                "Completed worker files must remain reusable after publication failure: {operation}"
            );
            if operation["status"] == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sets["model_sets"][0]["availability"], "available");
    assert_eq!(sets["model_sets"][0]["files"][0]["downloaded_bytes"], 16);
}

#[tokio::test]
async fn a_crash_during_publication_hides_uncommitted_model_files_until_manual_resume() {
    let commit = "0123456789012345678901234567890123456789";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route(&format!("/api/models/fixture/small/revision/{commit}"), get(move || async move { Json(json!({"id":"fixture/small","sha":commit,"private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/small/tree/{commit}"), get(|| async { Json(json!([{"type":"file","path":"model.gguf","size":16,"oid":"a"}])) }))
            .route(&format!("/fixture/small/resolve/{commit}/model.gguf"), get(|| async { ([("etag","\"fixture-v1\""),("content-length","16")], "fixture GGUF!!!!") }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let mut core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let body = json!({"repo_id":"fixture/small","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]});
    use sea_orm::{ConnectionTrait, Database};
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    db.execute_unprepared("CREATE TRIGGER fail_publication BEFORE INSERT ON model_files WHEN json_extract(NEW.body,'$.availability')='available' BEGIN SELECT length(randomblob(200000000)); END").await.unwrap();
    let response = client
        .post(format!("{}/downloads", core.url))
        .header("Idempotency-Key", "download")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let accepted: Value = response.json().await.unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let files = std::process::Command::new("rg")
                .args(["--files", "--hidden", "--no-ignore"])
                .arg(root.path().join("data/models"))
                .output()
                .unwrap();
            if String::from_utf8_lossy(&files.stdout).contains("model.gguf") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    core.child.kill().await.unwrap();
    db.execute_unprepared("DROP TRIGGER fail_publication")
        .await
        .unwrap();
    fixture.abort();
    let core = support::Core::start(root.path()).await;
    let files = std::process::Command::new("rg")
        .args(["--files", "--hidden", "--no-ignore"])
        .arg(root.path().join("data/models"))
        .output()
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&files.stdout).contains("model.gguf"),
        "Startup must hide uncommitted model links, keeping the completed worker file for manual resume"
    );

    assert_eq!(
        client
            .post(format!("{}/downloads/{id}/resume", core.url))
            .header("Idempotency-Key", "retry-publication")
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let operation: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_ne!(
                operation["status"], "failed",
                "Completed worker files must remain reusable after publication failure: {operation}"
            );
            if operation["status"] == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let sets: Value = client
        .get(format!("{}/model-sets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sets["model_sets"][0]["availability"], "available");
    assert_eq!(sets["model_sets"][0]["files"][0]["downloaded_bytes"], 16);
}

#[tokio::test]
async fn normal_shutdown_preserves_a_running_download_for_manual_range_resume() {
    use axum::{
        http::{HeaderMap, Method, StatusCode},
        response::IntoResponse,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let commit = "0123456789012345678901234567890123456789";
    let size = 4 * 1024 * 1024u64;
    let started = Arc::new(AtomicBool::new(false));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new()
            .route(&format!("/api/models/fixture/large/revision/{commit}"), get(move || async move { Json(json!({"id":"fixture/large","sha":commit,"private":false,"gated":false})) }))
            .route(&format!("/api/models/fixture/large/tree/{commit}"), get(move || async move { Json(json!([{"type":"file","path":"model.gguf","size":size,"oid":"a"}])) }))
            .route(&format!("/fixture/large/resolve/{commit}/model.gguf"), get(move |method: Method, headers: HeaderMap| {
                let started = started.clone();
                async move {
                    if method == Method::HEAD { return ([("etag","\"stable\""),("content-length","4194304")], "").into_response(); }
                    let range = headers.get("range").and_then(|h| h.to_str().ok());
                    let offset = range.and_then(|s| s.strip_prefix("bytes=")).and_then(|s| s.split('-').next()).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                    if started.swap(true,Ordering::SeqCst) && (offset == 0 || headers.get("if-range").and_then(|h|h.to_str().ok()) != Some("\"stable\"")) { return StatusCode::CONFLICT.into_response(); }
                    let stream = async_stream::stream! {
                        let mut left = size - offset;
                        while left > 0 {
                            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                            let n = left.min(65536); left -= n;
                            yield Ok::<_, std::io::Error>(vec![b'x'; n as usize]);
                        }
                    };
                    let mut response = axum::body::Body::from_stream(stream).into_response();
                    response.headers_mut().insert("etag", "\"stable\"".parse().unwrap());
                    response.headers_mut().insert("content-length", (size-offset).to_string().parse().unwrap());
                    if offset > 0 { *response.status_mut() = StatusCode::PARTIAL_CONTENT; response.headers_mut().insert("content-range",format!("bytes {offset}-{}/{size}",size-1).parse().unwrap()); }
                    response
                }
            }))
        ).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", &endpoint);
    let mut core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    let accepted: Value = client.post(format!("{}/downloads",core.url)).header("Idempotency-Key","large")
        .json(&json!({"repo_id":"fixture/large","commit":commit,"files":[{"path":"model.gguf","role":"weights"}]})).send().await.unwrap().json().await.unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let op: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if op["progress"]["bytes_done"].as_u64().unwrap_or(0) > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Download progress must become observable before completion");
    unsafe {
        libc::kill(core.child.id().unwrap() as i32, libc::SIGTERM);
    }
    assert!(core.child.wait().await.unwrap().success());
    let mut command = support::command(root.path());
    command.env("CORE_HUB_ENDPOINT", endpoint);
    let core = support::Core::start_command(command).await;
    let op: Value = client
        .get(format!("{}/operations/{id}", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(op["status"], "paused");
    let resumed = client
        .post(format!("{}/downloads/{id}/resume", core.url))
        .header("Idempotency-Key", "resume")
        .send()
        .await
        .unwrap();
    assert_eq!(resumed.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let op: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_ne!(op["status"], "failed", "{op}");
            if op["status"] == "succeeded" {
                assert_eq!(op["progress"]["bytes_done"], size);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    fixture.abort();
}
