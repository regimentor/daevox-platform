mod support;
use serde_json::Value;

#[tokio::test]
async fn each_start_has_a_new_empty_observation_session() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start(root.path()).await;
    let response = reqwest::get(format!("{}/runtime", core.url)).await.unwrap();
    assert_eq!(response.status(), 200);
    let snapshot: Value = response.json().await.unwrap();
    assert_eq!(snapshot["state"], "empty");
    assert_eq!(snapshot["active_instance"], Value::Null);
    assert_eq!(snapshot["inflight_requests"], 0);
    assert!(
        snapshot["session_id"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    core.child.kill().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let next: Value = reqwest::get(format!("{}/runtime", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(next["session_id"], snapshot["session_id"]);
}

#[tokio::test]
async fn applying_a_checked_build_changes_current_build_and_leaves_runtime_empty() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let build = support::candidate(&core).await;
    let response = reqwest::Client::new()
        .post(format!("{}/builds/{build}/apply", core.url))
        .header("Idempotency-Key", "apply")
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let snapshot: Value = reqwest::get(format!("{}/runtime", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if snapshot["current_build_id"] == build {
                assert_eq!(snapshot["state"], "empty");
                assert_eq!(snapshot["active_instance"], Value::Null);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn loading_a_saved_preset_exposes_only_that_model_and_uses_its_scoped_settings() {
    use serde_json::json;
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::apply_candidate(&core).await;
    std::fs::write(
        root.path().join("data/models/fixture.gguf"),
        "external model fixture",
    )
    .unwrap();
    let client = reqwest::Client::new();
    let source: Value = client.post(format!("{}/preset-files", core.url)).header("Idempotency-Key", "source")
        .json(&json!({"name":"local.ini", "text":"[*]\nmodel=../data/models/fixture.gguf\nctx-size=512\n[local]\nctx-size=2048\n"})).send().await.unwrap().json().await.unwrap();
    let response = client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "load")
        .json(&json!({"preset_id":"local", "preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let snapshot: Value = client
                .get(format!("{}/runtime", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if snapshot["state"] == "ready" {
                assert_eq!(snapshot["active_instance"]["preset_id"], "local");
                assert_eq!(
                    snapshot["active_instance"]["applied_preset_revision"],
                    source["revision"]
                );
                break;
            }
            assert_ne!(snapshot["state"], "error", "{snapshot}");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let models: Value = client
        .get(format!("{}/v1/models", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"].as_array().unwrap().len(), 1);
    assert_eq!(models["data"][0]["id"], "local");
    let completion = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&json!({"model":"local", "messages":[{"role":"user","content":"Hello"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(completion.status(), 200);
    assert_eq!(
        completion.json::<Value>().await.unwrap()["choices"][0]["message"]["content"],
        "ctx=2048"
    );
}

#[tokio::test]
async fn an_accepted_stream_finishes_before_a_switch_and_new_requests_are_rejected() {
    use serde_json::json;
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::apply_candidate(&core).await;
    std::fs::write(
        root.path().join("data/models/fixture.gguf"),
        "external model fixture",
    )
    .unwrap();
    let client = reqwest::Client::new();
    let source: Value = client.post(format!("{}/preset-files", core.url)).header("Idempotency-Key", "source")
        .json(&json!({"name":"local.ini", "text":"[*]\nmodel=../data/models/fixture.gguf\n[a]\nctx-size=512\n[b]\nctx-size=2048\n"})).send().await.unwrap().json().await.unwrap();
    client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "load-a")
        .json(&json!({"preset_id":"a", "preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap();
    for _ in 0..100 {
        let state: Value = client
            .get(format!("{}/runtime", core.url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if state["state"] == "ready" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let stream = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&json!({"model":"a","messages":[],"stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(stream.status(), 200);
    assert!(
        stream.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("text/event-stream")
    );
    let switch = client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "load-b")
        .json(&json!({"preset_id":"b", "preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(switch.status(), 202);
    let snapshot: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(snapshot["state"], "waiting");
    assert_eq!(snapshot["inflight_requests"], 1);
    let rejected = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&json!({"model":"a","messages":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), 503);
    assert_eq!(
        rejected.json::<Value>().await.unwrap()["error"]["code"],
        "model_switching"
    );
    assert!(stream.text().await.unwrap().contains("[DONE]"));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state: Value = client
                .get(format!("{}/runtime", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "ready" && state["active_instance"]["preset_id"] == "b" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn switching_to_null_unloads_the_active_instance() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let response = reqwest::Client::new()
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "unload")
        .json(&serde_json::json!({"preset_id":null}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state: Value = reqwest::get(format!("{}/runtime", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "empty" {
                assert!(state["active_instance"].is_null());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancelling_during_drain_keeps_the_old_instance_and_accepted_stream() {
    use serde_json::json;
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let source = support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let stream = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&json!({"model":"a","messages":[],"stream":true}))
        .send()
        .await
        .unwrap();
    let accepted: Value = client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "switch")
        .json(&json!({"preset_id":"b","preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    let response = client
        .post(format!("{}/operations/{id}/cancel", core.url))
        .header("Idempotency-Key", "cancel")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
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
    let state: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["state"], "ready");
    assert_eq!(state["active_instance"]["preset_id"], "a");
    assert!(stream.text().await.unwrap().contains("[DONE]"));
}

#[tokio::test]
async fn force_ends_the_accepted_stream_and_completes_the_pending_switch() {
    use serde_json::json;
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let source = support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let stream = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&json!({"model":"a","messages":[],"stream":true}))
        .send()
        .await
        .unwrap();
    let accepted: Value = client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "switch")
        .json(&json!({"preset_id":"b","preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    let response = client
        .post(format!("{}/operations/{id}/force", core.url))
        .header("Idempotency-Key", "force")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let text = stream.text().await;
    assert!(
        text.is_err() || !text.unwrap().contains("[DONE]"),
        "Forced termination must not fabricate a normal end marker"
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let state: Value = client
                .get(format!("{}/runtime", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "ready" && state["active_instance"]["preset_id"] == "b" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancelling_after_loading_started_stops_the_new_instance_and_leaves_empty() {
    use serde_json::json;
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let source: Value = client.post(format!("{}/preset-files", core.url)).header("Idempotency-Key", "slow-source")
        .json(&json!({"name":"slow.ini","text":"[slow]\nmodel=../data/models/fixture.gguf\nctx-size=777\n"})).send().await.unwrap().json().await.unwrap();
    let accepted: Value = client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "slow-load")
        .json(&json!({"preset_id":"slow","preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
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
            if state["state"] == "loading" {
                let operation: Value = client
                    .get(format!("{}/operations/{id}", core.url))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                assert_eq!(operation["phase"], "loading");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let response = client
        .post(format!("{}/operations/{id}/cancel", core.url))
        .header("Idempotency-Key", "cancel-load")
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
            if op["status"] != "running" {
                assert_eq!(op["status"], "cancelled");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let state: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["state"], "empty");
    assert!(state["active_instance"].is_null());
}

#[tokio::test]
async fn restart_preserves_the_applied_build_but_never_reloads_the_model() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let before: Value = reqwest::get(format!("{}/runtime", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    drop(core);
    let core = support::Core::start(root.path()).await;
    let after: Value = reqwest::get(format!("{}/runtime", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["current_build_id"], before["current_build_id"]);
    assert_eq!(after["last_selected_preset_id"], "a");
    assert_eq!(after["state"], "empty");
    assert!(after["active_instance"].is_null());
}

#[tokio::test]
async fn applying_a_build_drains_the_active_stream_and_finishes_empty() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let state: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let stream = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&serde_json::json!({"model":"a","messages":[],"stream":true}))
        .send()
        .await
        .unwrap();
    let response = client
        .post(format!(
            "{}/builds/{}/apply",
            core.url,
            state["current_build_id"].as_str().unwrap()
        ))
        .header("Idempotency-Key", "reapply-active")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let state: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["state"], "waiting");
    assert!(stream.text().await.unwrap().contains("[DONE]"));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state: Value = client
                .get(format!("{}/runtime", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "empty" {
                assert!(state["active_instance"].is_null());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancelling_build_apply_during_drain_preserves_the_active_model() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let state: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let stream = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&serde_json::json!({"model":"a","messages":[],"stream":true}))
        .send()
        .await
        .unwrap();
    let operation: Value = client
        .post(format!(
            "{}/builds/{}/apply",
            core.url,
            state["current_build_id"].as_str().unwrap()
        ))
        .header("Idempotency-Key", "apply-cancel")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = operation["operation_id"].as_str().unwrap();
    let response = client
        .post(format!("{}/operations/{id}/cancel", core.url))
        .header("Idempotency-Key", "cancel-apply")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    assert!(stream.text().await.unwrap().contains("[DONE]"));
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
            if op["status"] == "cancelled" {
                break;
            }
            assert_ne!(op["status"], "succeeded");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let after: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["state"], "ready");
    assert_eq!(
        after["active_instance"]["id"],
        state["active_instance"]["id"]
    );
}

#[tokio::test]
async fn a_router_crash_removes_the_ready_model_without_automatic_restart() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let source = support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let _ = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&serde_json::json!({"model":"a","messages":[],"fixture_crash":true}))
        .send()
        .await;
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
            if state["state"] == "error" {
                assert!(state["active_instance"].is_null());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let models: Value = client
        .get(format!("{}/v1/models", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(models["data"].as_array().unwrap().is_empty());

    let retry = client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "manual-retry-after-crash")
        .json(&serde_json::json!({"preset_id":"a","preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        retry.status(),
        202,
        "A stopped failed instance must allow an explicit retry"
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let state: Value = reqwest::get(format!("{}/runtime", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "ready" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn recovery_finds_a_model_child_even_when_its_router_leader_has_died() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    core.child.kill().await.unwrap();
    // Crash the external router after core is gone, leaving its external model child alive.
    for entry in std::fs::read_dir(root.path().join("data/runtime/processes"))
        .unwrap()
        .flatten()
    {
        let record: Value = serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap();
        let pid = record["pid"].as_i64().unwrap();
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let state: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["state"], "recovery_required");
    assert!(!state["recovery"].as_array().unwrap().is_empty());
    for recovery in state["recovery"].as_array().unwrap() {
        assert_eq!(recovery["allowed_actions"], serde_json::json!(["stop"]));
        let response = client
            .post(format!(
                "{}/recovery/{}/stop",
                core.url,
                recovery["id"].as_str().unwrap()
            ))
            .header("Idempotency-Key", uuid::Uuid::new_v4().to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 202);
    }
    let state: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["state"], "empty");
}

#[tokio::test]
async fn inference_requires_a_concrete_model_and_rejects_router_query_controls() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    for (suffix, body) in [
        ("", serde_json::json!({"messages":[]})),
        (
            "?autoload=true",
            serde_json::json!({"model":"a","messages":[]}),
        ),
        (
            "?aut%6fload=1",
            serde_json::json!({"model":"a","messages":[]}),
        ),
    ] {
        let response = client
            .post(format!("{}/v1/chat/completions{suffix}", core.url))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert_eq!(
            response.json::<Value>().await.unwrap()["error"]["code"],
            "invalid_request"
        );
    }
    let models: Value = client
        .get(format!("{}/v1/models", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"][0]["id"], "a");
}

#[tokio::test]
async fn normal_sigterm_stops_owned_runtime_tree_and_restart_needs_no_recovery() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    unsafe {
        libc::kill(core.child.id().unwrap() as i32, libc::SIGTERM);
    }
    let status = tokio::time::timeout(std::time::Duration::from_secs(10), core.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "SIGTERM must finish controlled shutdown");
    let restarted = support::Core::start(root.path()).await;
    let runtime: serde_json::Value = reqwest::get(format!("{}/runtime", restarted.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(runtime["state"], "empty");
    assert_eq!(runtime["recovery"], serde_json::json!([]));
}

#[tokio::test]
async fn cancellation_accepted_while_readiness_response_is_in_flight_cannot_be_lost() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let source:Value=client.post(format!("{}/preset-files",core.url)).header("Idempotency-Key","race-source").json(&serde_json::json!({"name":"race.ini","text":"[race]\nmodel=../data/models/fixture.gguf\nctx-size=888\n"})).send().await.unwrap().json().await.unwrap();
    let accepted: Value = client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "race-switch")
        .json(&serde_json::json!({"preset_id":"race","preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let logs: Value = client
                .get(format!(
                    "{}/logs?query=fixture%20readiness%20captured",
                    core.url
                ))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if !logs["entries"].as_array().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        client
            .post(format!("{}/operations/{id}/cancel", core.url))
            .header("Idempotency-Key", "race-cancel")
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let op: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if op["status"] != "running" {
                assert_eq!(op["status"], "cancelled");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let runtime: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(runtime["state"], "empty");
}

#[tokio::test]
async fn a_model_child_crash_is_observed_even_when_the_router_stays_alive() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .post(format!("{}/v1/chat/completions", core.url))
            .json(&serde_json::json!({"model":"a","messages":[],"fixture_model_crash":true}))
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let runtime: Value = client
                .get(format!("{}/runtime", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if runtime["state"] == "error" {
                assert!(runtime["active_instance"].is_null());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("A dead child must not remain advertised as ready");
    let models: Value = client
        .get(format!("{}/v1/models", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"], serde_json::json!([]));
}

#[tokio::test]
async fn recovery_clears_when_surviving_processes_exit_without_a_stop_command() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    core.child.kill().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let state: Value = reqwest::get(format!("{}/runtime", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["state"], "recovery_required");
    // Simulate termination by the external process supervisor, using the fixture's group.
    for process in state["recovery"].as_array().unwrap() {
        unsafe {
            libc::kill(-(process["pid"].as_i64().unwrap() as i32), libc::SIGKILL);
        }
    }
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let state: Value = reqwest::get(format!("{}/runtime", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "empty" {
                assert_eq!(state["recovery"], serde_json::json!([]));
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("Recovery must refresh when the surviving process exits");
}

#[tokio::test]
async fn unload_waits_for_driver_allocation_to_disappear_after_model_exit() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("nvml")).unwrap();
    assert!(
        std::process::Command::new("cc")
            .args(["-shared", "-fPIC"])
            .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/nvml.c"))
            .arg("-o")
            .arg(root.path().join("nvml/libnvidia-ml.so.1"))
            .status()
            .unwrap()
            .success()
    );
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let started = std::time::Instant::now();
    let response = reqwest::Client::new()
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "unload")
        .json(&serde_json::json!({"preset_id":null}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state: Value = reqwest::get(format!("{}/runtime", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "empty" {
                assert!(state["active_instance"].is_null());
                assert!(
                    started.elapsed() >= std::time::Duration::from_millis(800),
                    "Empty must wait for the driver allocation to clear"
                );
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn build_apply_waits_for_driver_allocation_to_disappear_after_model_exit() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("nvml")).unwrap();
    assert!(
        std::process::Command::new("cc")
            .args(["-shared", "-fPIC"])
            .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/nvml.c"))
            .arg("-o")
            .arg(root.path().join("nvml/libnvidia-ml.so.1"))
            .status()
            .unwrap()
            .success()
    );
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let build = support::candidate(&core).await;
    let started = std::time::Instant::now();
    let response = reqwest::Client::new()
        .post(format!("{}/builds/{build}/apply", core.url))
        .header("Idempotency-Key", "unload")
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state: Value = reqwest::get(format!("{}/runtime", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "empty" {
                assert!(state["active_instance"].is_null());
                assert!(
                    started.elapsed() >= std::time::Duration::from_millis(800),
                    "Empty must wait for the driver allocation to clear"
                );
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failed_load_waits_for_its_child_and_driver_allocation_before_publishing_error() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("nvml")).unwrap();
    assert!(
        std::process::Command::new("cc")
            .args(["-shared", "-fPIC"])
            .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/nvml.c"))
            .arg("-o")
            .arg(root.path().join("nvml/libnvidia-ml.so.1"))
            .status()
            .unwrap()
            .success()
    );
    let core = support::with_fixture_toolchain(root.path()).await;
    support::apply_candidate(&core).await;
    std::fs::write(root.path().join("data/models/fixture.gguf"), "fixture").unwrap();
    let source:Value=reqwest::Client::new().post(format!("{}/preset-files",core.url)).header("Idempotency-Key","failed-source")
        .json(&serde_json::json!({"name":"failure.ini","text":"[failure]\nmodel=../data/models/fixture.gguf\nctx-size=666\n"})).send().await.unwrap().json().await.unwrap();
    let started = std::time::Instant::now();
    let response = reqwest::Client::new()
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "unload")
        .json(&serde_json::json!({"preset_id":"failure","preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state: Value = reqwest::get(format!("{}/runtime", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "error" {
                assert!(state["active_instance"].is_null());
                assert!(
                    started.elapsed() >= std::time::Duration::from_millis(800),
                    "Error must wait for the driver allocation to clear"
                );
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancellation_accepted_during_apply_readiness_cannot_publish_the_candidate() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let build = support::candidate(&core).await;
    std::fs::write(root.path().join("slow-apply"), "").unwrap();
    let client = reqwest::Client::new();
    let accepted: Value = client
        .post(format!("{}/builds/{build}/apply", core.url))
        .header("Idempotency-Key", "apply-race")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let logs: Value = client
                .get(format!(
                    "{}/logs?query=fixture%20apply%20readiness",
                    core.url
                ))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if !logs["entries"].as_array().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        client
            .post(format!("{}/operations/{id}/cancel", core.url))
            .header("Idempotency-Key", "late-apply-cancel")
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let operation: Value = client
        .get(format!("{}/operations/{id}", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(operation["status"], "cancelled");
    let state: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["state"], "empty");
    assert!(state["current_build_id"].is_null());
    let builds: Value = client
        .get(format!("{}/builds", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        builds["builds"]
            .as_array()
            .unwrap()
            .iter()
            .all(|build| build["current"] == false)
    );
}

#[tokio::test]
async fn a_timed_out_resource_release_blocks_retry_until_the_driver_releases_the_allocation() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("nvml")).unwrap();
    assert!(
        std::process::Command::new("cc")
            .args(["-shared", "-fPIC"])
            .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/nvml.c"))
            .arg("-o")
            .arg(root.path().join("nvml/libnvidia-ml.so.1"))
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(root.path().join("nvml/slow-release"), "").unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::apply_candidate(&core).await;
    std::fs::write(root.path().join("data/models/fixture.gguf"), "fixture").unwrap();
    let source:Value=reqwest::Client::new().post(format!("{}/preset-files",core.url)).header("Idempotency-Key","failed-source")
        .json(&serde_json::json!({"name":"failure.ini","text":"[failure]\nmodel=../data/models/fixture.gguf\nctx-size=666\n"})).send().await.unwrap().json().await.unwrap();
    let started = std::time::Instant::now();
    let response = reqwest::Client::new()
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "unload")
        .json(&serde_json::json!({"preset_id":"failure","preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let state: Value = reqwest::get(format!("{}/runtime", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if state["state"] == "error" || state["state"] == "recovery_required" {
                let retry=reqwest::Client::new().post(format!("{}/runtime/switch",core.url)).header("Idempotency-Key","retry-with-held-allocation").json(&serde_json::json!({"preset_id":"failure","preset_revision":source["revision"]})).send().await.unwrap();
                assert_eq!(retry.status(),409,"A live driver allocation must prevent another model launch");
                assert!(state["active_instance"].is_null());
                assert!(
                    started.elapsed() >= std::time::Duration::from_millis(800),
                    "Error must wait for the driver allocation to clear"
                );
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn model_switches_reuse_the_configured_port_and_stop_previous_servers() {
    let root=tempfile::tempdir().unwrap();
    let core=support::with_fixture_toolchain(root.path()).await;
    let source=support::ready(&core,root.path()).await;
    let port=std::fs::read_to_string(root.path().join(".test-router-port")).unwrap();
    let url=format!("http://127.0.0.1:{port}/health");
    let client=reqwest::Client::new();
    let health:Value=client.get(&url).send().await.expect("Model server must listen on the configured permanent port").json().await.unwrap();
    let mut old_pid=health["pid"].as_u64().unwrap() as i32;
    for preset in [serde_json::json!("b"),serde_json::json!("a"),Value::Null] {
        let response:Value=client.post(format!("{}/runtime/switch",core.url)).header("Idempotency-Key",uuid::Uuid::new_v4().to_string()).json(&serde_json::json!({"preset_id":preset,"preset_revision":source["revision"]})).send().await.unwrap().json().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5),async {
            loop {
                let op:Value=client.get(format!("{}/operations/{}",core.url,response["operation_id"].as_str().unwrap())).send().await.unwrap().json().await.unwrap();
                assert_ne!(op["status"],"failed","{op}");
                if op["status"]=="succeeded" {break;}
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }).await.unwrap();
        assert_eq!(unsafe {libc::kill(old_pid,0)},-1,"Previous server is still alive");
        let health:Value=client.get(&url).send().await.unwrap().json().await.unwrap();
        old_pid=health["pid"].as_u64().unwrap() as i32;
    }
    drop(core);
    assert!(client.get(&url).send().await.is_err(),"Shutdown must close the permanent port");
}
