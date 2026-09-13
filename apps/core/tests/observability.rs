mod support;
use serde_json::Value;

#[tokio::test]
async fn hardware_samples_accumulate_in_the_core_session_without_a_browser() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let response = reqwest::get(format!("{}/metrics", core.url)).await.unwrap();
    assert_eq!(response.status(), 200);
    tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
    let result: Value = reqwest::get(format!("{}/metrics", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(result["samples"].as_array().unwrap().len() >= 2);
    let sample = result["samples"].as_array().unwrap().last().unwrap();
    assert!(!sample["cpu"]["logical"].as_array().unwrap().is_empty());
    assert!(sample["ram"]["total"]["value"].as_u64().unwrap() > 0);
    assert_eq!(sample["ram"]["total"]["unit"], "bytes");
    assert_eq!(sample["ram"]["total"]["availability"], "available");
    assert!(sample["gpus"].is_array());
    let runtime: Value = reqwest::get(format!("{}/runtime", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sample["session_id"], runtime["session_id"]);
}

#[tokio::test]
async fn sse_starts_with_a_snapshot_and_reports_a_gap_on_old_session_reconnect() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let mut response = client
        .get(format!("{}/events", core.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("text/event-stream")
    );
    let chunk = tokio::time::timeout(std::time::Duration::from_secs(1), response.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let text = String::from_utf8_lossy(&chunk);
    assert!(text.contains("event: snapshot"));
    assert!(text.contains("\"runtime\""));
    assert!(text.contains("\"settings\""));
    drop(response);
    let mut reconnect = client
        .get(format!("{}/events", core.url))
        .header("Last-Event-ID", "old-session:17")
        .send()
        .await
        .unwrap();
    let mut text = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !text.contains("event: snapshot") {
            text.push_str(&String::from_utf8_lossy(
                &reconnect.chunk().await.unwrap().unwrap(),
            ));
        }
    })
    .await
    .unwrap();
    assert!(text.contains("event: gap"));
    assert!(text.find("event: gap") < text.find("event: snapshot"));
}

#[tokio::test]
async fn router_logs_are_available_in_the_same_persistent_log_catalog() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let logs: Value = reqwest::get(format!("{}/logs?source=router", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!logs["entries"].as_array().unwrap().is_empty());
    assert!(
        logs["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["source"] == "router" && e["timestamp"].is_string())
    );
}

#[tokio::test]
async fn log_cursor_returns_only_new_entries_and_marks_an_unavailable_cursor() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let logs: Value = reqwest::get(format!("{}/logs", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cursor = logs["cursor"].as_str().unwrap();
    let next: Value = reqwest::get(format!("{}/logs?cursor={cursor}", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(next["entries"].as_array().unwrap().is_empty());
    assert_eq!(next["gap"], false);
    let missing: Value = reqwest::get(format!("{}/logs?cursor=rotated-away", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(missing["gap"], true);
}

#[tokio::test]
async fn live_events_deliver_session_metrics_and_external_preset_changes() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let mut response = reqwest::get(format!("{}/events", core.url)).await.unwrap();
    response.chunk().await.unwrap().unwrap();
    std::fs::write(
        root.path().join("presets/external.ini"),
        "[new]\nctx-size=1024\n",
    )
    .unwrap();
    let mut text = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !text.contains("event: metric.sample")
            || !text.contains("event: preset.changed")
            || !text.ends_with("\n\n")
        {
            text.push_str(&String::from_utf8_lossy(
                &response.chunk().await.unwrap().unwrap(),
            ));
        }
    })
    .await
    .unwrap();
    let events: Vec<Value> = text
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(
        events
            .windows(2)
            .all(|w| w[0]["seq"].as_u64() < w[1]["seq"].as_u64())
    );
}

#[tokio::test]
async fn inference_metrics_distinguish_completion_and_client_cancellation_without_inventing_tps() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let answer: Value = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&serde_json::json!({"model":"a","messages":[]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(answer["usage"]["completion_tokens"], 1);
    let mut stream = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&serde_json::json!({"model":"a","messages":[],"stream":true}))
        .send()
        .await
        .unwrap();
    stream.chunk().await.unwrap();
    drop(stream);
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let metrics: Value = client
        .get(format!("{}/metrics", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let requests = &metrics["samples"].as_array().unwrap().last().unwrap()["inference"];
    assert_eq!(requests["succeeded"], 1);
    assert_eq!(requests["cancelled"], 1);
    assert_eq!(requests["failed"], 0);
    assert_eq!(requests["completion_tokens"], 1);
    assert!(requests["last_request"]["request_id"].is_string());
    assert_eq!(requests["last_request"]["preset_id"], "a");
    assert!(
        requests["last_request"]["ttft_ms"].is_null(),
        "Role-only chunk must not produce TTFT"
    );
    assert!(
        requests["last_request"]["tokens_per_second"].is_null(),
        "Token count alone does not establish generation timing"
    );
}

#[tokio::test]
#[ignore = "requires this workstation's two NVIDIA GPUs and CUDA driver"]
async fn cuda_indices_are_matched_by_uuid_instead_of_nvml_enumeration_order() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let result: Value = reqwest::get(format!("{}/metrics", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sample = result["samples"].as_array().unwrap().last().unwrap();
    let gpus = sample["gpus"].as_array().unwrap();
    let ti = gpus
        .iter()
        .find(|g| g["uuid"] == "GPU-4285af60-14a3-e67a-ca06-cb7c9afad6ce")
        .unwrap();
    let blackwell = gpus
        .iter()
        .find(|g| g["uuid"] == "GPU-b4cb0aff-7e56-1711-f4a9-6b2379de4c1f")
        .unwrap();
    assert_eq!(ti["cuda_index"], 0);
    assert_eq!(blackwell["cuda_index"], 1);
    assert_ne!(ti["cuda_index"], ti["nvml_index"]);
}

#[tokio::test]
async fn log_cursor_does_not_lose_later_output_from_an_older_router_segment() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let accepted: Value = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "another-build")
        .json(&serde_json::json!({"profile":"cpu","jobs":2,"clean":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
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
            if operation["status"] == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let logs: Value = client
        .get(format!("{}/logs", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cursor = logs["cursor"].as_str().unwrap();
    client.post(format!("{}/v1/chat/completions",core.url)).json(&serde_json::json!({"model":"a","messages":[],"fixture_log":"later output from active router"})).send().await.unwrap().text().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let logs: Value = client
                .get(format!("{}/logs?cursor={cursor}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if logs["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["message"] == "later output from active router")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("A new entry in an old segment must remain visible after a global cursor");
}

#[tokio::test]
async fn sse_delivers_build_changes_and_live_log_entries_during_a_build() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let mut response = reqwest::get(format!("{}/events", core.url)).await.unwrap();
    response.chunk().await.unwrap();
    let accepted = reqwest::Client::new()
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "live-build")
        .json(&serde_json::json!({"profile":"cpu","jobs":2}))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), 202);
    let mut text = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !text.contains("event: build.changed") || !text.contains("event: log.append") {
            text.push_str(&String::from_utf8_lossy(
                &response.chunk().await.unwrap().unwrap(),
            ));
        }
    })
    .await
    .expect("Build and log notifications must arrive on the public event stream");
}

#[tokio::test]
async fn upstream_sse_eof_without_a_terminal_marker_is_counted_as_failed() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let response = reqwest::Client::new()
        .post(format!("{}/v1/chat/completions", core.url))
        .json(
            &serde_json::json!({"model":"a","messages":[],"stream":true,"fixture_early_eof":true}),
        )
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!response.contains("[DONE]"));
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let metrics: Value = reqwest::get(format!("{}/metrics", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let inference = &metrics["samples"].as_array().unwrap().last().unwrap()["inference"];
    assert_eq!(inference["failed"], 1);
    assert_eq!(inference["succeeded"], 0);
}

#[tokio::test]
async fn metrics_include_cpu_ram_and_gpu_availability_for_core_and_owned_processes() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let result: Value = reqwest::get(format!("{}/metrics", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sample = result["samples"].as_array().unwrap().last().unwrap();
    let processes = sample["processes"]
        .as_array()
        .expect("Process metrics must be exposed");
    assert!(
        processes.len() >= 3,
        "Expected core, router and model child"
    );
    let core_sample = processes
        .iter()
        .find(|p| p["pid"].as_u64() == core.child.id().map(u64::from))
        .unwrap();
    assert_eq!(core_sample["role"], "core");
    assert_eq!(core_sample["ram"]["availability"], "available");
    assert!(core_sample["ram"]["value"].as_u64().unwrap() > 0);
    assert!(
        processes
            .iter()
            .all(|p| p["cpu"]["unit"] == "percent" && p["gpu_memory"].is_array())
    );
}

#[tokio::test]
async fn streaming_token_counters_use_actual_llama_timings_when_usage_is_absent() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    reqwest::Client::new()
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&serde_json::json!({"model":"a","messages":[],"stream":true,"fixture_timings":true}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let metrics: Value = reqwest::get(format!("{}/metrics", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let counts = &metrics["samples"].as_array().unwrap().last().unwrap()["inference"];
    assert_eq!(counts["succeeded"], 1);
    assert_eq!(counts["prompt_tokens"], 7);
    assert_eq!(counts["completion_tokens"], 3);
    assert_eq!(counts["last_request"]["tokens_per_second"], 12.5);
    assert!(counts["last_request"]["ttft_ms"].as_f64().unwrap() >= 400.0);
}

#[tokio::test]
async fn a_failed_gpu_sensor_retains_last_success_time_and_never_substitutes_zero() {
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
    let mut command = support::command(root.path());
    command
        .env("LD_LIBRARY_PATH", root.path().join("nvml"))
        .env("FIXTURE_NVML_STATE", root.path().join("nvml/allocation"));
    let core = support::Core::start_command(command).await;
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let before: Value = reqwest::get(format!("{}/metrics", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let good = &before["samples"].as_array().unwrap().last().unwrap()["gpus"][0]["utilisation"];
    assert_eq!(good["value"], 42);
    std::fs::write(root.path().join("nvml/allocation"), "sensor failure").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let after: Value = reqwest::get(format!("{}/metrics", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let failed = &after["samples"].as_array().unwrap().last().unwrap()["gpus"][0]["utilisation"];
    assert!(failed["value"].is_null());
    assert_eq!(failed["availability"], "error");
    assert_eq!(failed["last_success_at"], good["sampled_at"]);
    assert!(failed["reason"].is_string());
    for field in ["vram_used", "vram_total"] {
        let metric = &after["samples"].as_array().unwrap().last().unwrap()["gpus"][0][field];
        assert_eq!(metric["availability"], "error", "{field}");
        assert!(metric["value"].is_null());
        assert_eq!(metric["last_success_at"], good["sampled_at"]);
    }

    std::fs::write(root.path().join("nvml/allocation"), "collector failure").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let failed: Value = reqwest::get(format!("{}/metrics", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sample = failed["samples"].as_array().unwrap().last().unwrap();
    assert_eq!(sample["gpu_availability"], "error");
    assert_eq!(sample["gpus"][0]["id"], "GPU-fixture");
    assert!(sample["gpus"][0]["utilisation"]["value"].is_null());
    assert_eq!(
        sample["gpus"][0]["utilisation"]["last_success_at"],
        good["sampled_at"]
    );
}

#[tokio::test]
async fn forwarded_model_logs_are_filterable_and_correlate_with_the_active_instance() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let active: Value = reqwest::get(format!("{}/runtime", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    reqwest::Client::new().post(format!("{}/v1/chat/completions",core.url)).json(&serde_json::json!({"model":"a","messages":[],"fixture_log":"[12345] 0.01 I fixture model output"})).send().await.unwrap().text().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let logs: Value = reqwest::get(format!("{}/logs?source=model", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entry = logs["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| {
            e["message"]
                .as_str()
                .unwrap()
                .contains("fixture model output")
        })
        .expect("Forwarded child logs must be classified as model");
    assert_eq!(entry["instance_id"], active["active_instance"]["id"]);
    assert_eq!(entry["build_id"], active["active_instance"]["build_id"]);
    assert_eq!(entry["level"], "info");
}

#[tokio::test]
async fn core_startup_is_recorded_in_the_persistent_core_log_source() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let logs: Value = reqwest::get(format!("{}/logs?source=core", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if let Some(entry) = logs["entries"].as_array().unwrap().first() {
                assert!(entry["message"].as_str().unwrap().contains("Core started"));
                assert_eq!(entry["level"], "info");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Core lifecycle must be available in its log catalog");
}
