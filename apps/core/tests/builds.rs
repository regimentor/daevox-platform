mod support;
use serde_json::{Value, json};

#[tokio::test]
async fn an_unavailable_toolchain_is_a_failed_operation_without_cpu_fallback() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "build")
        .json(&json!({"profile": "cuda", "jobs": 8, "clean": false}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let accepted: Value = response.json().await.unwrap();
    let url = format!(
        "{}/operations/{}",
        core.url,
        accepted["operation_id"].as_str().unwrap()
    );
    let operation = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let operation: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
            if operation["status"] == "failed" {
                break operation;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        operation["error"]["message"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    let builds: Value = client
        .get(format!("{}/builds", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(builds["builds"].as_array().unwrap().len(), 1);
    assert_eq!(builds["builds"][0]["profile"], "cuda");
    assert_eq!(builds["builds"][0]["status"], "failed");
}

#[tokio::test]
#[ignore = "compiles the pinned llama.cpp with the host CUDA toolchain"]
async fn a_cuda_build_produces_a_checked_candidate_without_applying_it() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("vendor")).unwrap();
    std::os::unix::fs::symlink(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/llama.cpp"),
        root.path().join("vendor/llama.cpp"),
    )
    .unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let accepted: Value = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "cuda-build")
        .json(&json!({"profile": "cuda", "jobs": 8, "clean": false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!(
        "{}/operations/{}",
        core.url,
        accepted["operation_id"].as_str().unwrap()
    );
    let operation = tokio::time::timeout(std::time::Duration::from_secs(900), async {
        loop {
            let operation: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
            if matches!(operation["status"].as_str(), Some("failed" | "succeeded")) {
                break operation;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(operation["status"], "succeeded", "{operation}");
    let builds: Value = client
        .get(format!("{}/builds", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(builds["builds"][0]["status"], "ready");
    assert_eq!(builds["builds"][0]["current"], false);
    assert_eq!(
        builds["builds"][0]["commit"],
        "82d6bb284d1ff1c6ef37f29a4c3b63d1a8b11806"
    );
    assert_eq!(builds["builds"][0]["checks"]["router_health"], true);
    assert_eq!(builds["builds"][0]["checks"]["inference"], "not_checked");
    assert!(core.child.id().is_some());
}

fn slow_toolchain(root: &std::path::Path) -> tokio::process::Command {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(root.join("vendor")).unwrap();
    std::os::unix::fs::symlink(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/llama.cpp"),
        root.join("vendor/llama.cpp"),
    )
    .unwrap();
    std::fs::create_dir_all(root.join("tools")).unwrap();
    let cmake = root.join("tools/cmake");
    std::fs::write(&cmake, "#!/usr/bin/python3\nimport time\nprint('fixture-compiler-started', flush=True)\ntime.sleep(2)\n").unwrap();
    std::fs::set_permissions(&cmake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut command = support::command(root);
    command.env(
        "PATH",
        format!(
            "{}:{}",
            root.join("tools").display(),
            std::env::var("PATH").unwrap()
        ),
    );
    command
}

#[tokio::test]
async fn a_second_build_is_rejected_while_the_first_is_running() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start_command(slow_toolchain(root.path())).await;
    let client = reqwest::Client::new();
    let body = json!({"profile": "cpu", "jobs": 2, "clean": false});
    let first = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "one")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 202);
    let second = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "two")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), 409);
}

#[tokio::test]
async fn cancelling_a_build_finishes_before_the_slow_compiler() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start_command(slow_toolchain(root.path())).await;
    let client = reqwest::Client::new();
    let accepted: Value = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "build")
        .json(&json!({"profile":"cpu", "jobs":2, "clean":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let response = client
        .post(format!("{}/operations/{id}/cancel", core.url))
        .header("Idempotency-Key", "cancel")
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let operation: Value = client
                .get(format!("{}/operations/{id}", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if operation["status"] == "cancelled" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Cancellation waits for termination, not completion of compilation");
}

#[tokio::test]
async fn build_output_is_readable_while_compiling_and_survives_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start_command(slow_toolchain(root.path())).await;
    let client = reqwest::Client::new();
    client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "log-build")
        .json(&json!({"profile":"cpu", "jobs":2, "clean":false}))
        .send()
        .await
        .unwrap();
    let response = client
        .get(format!("{}/logs?source=build", core.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let logs: Value = client
                .get(format!("{}/logs?source=build", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if logs["entries"].as_array().unwrap().iter().any(|e| {
                e["message"]
                    .as_str()
                    .unwrap()
                    .contains("fixture-compiler-started")
            }) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    core.child.kill().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let logs: Value = client
        .get(format!("{}/logs?source=build", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(logs["entries"].as_array().unwrap().iter().any(|e| {
        e["message"]
            .as_str()
            .unwrap()
            .contains("fixture-compiler-started")
    }));
}

#[tokio::test]
async fn restarting_core_marks_an_unfinished_build_interrupted() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start_command(slow_toolchain(root.path())).await;
    let client = reqwest::Client::new();
    let accepted: Value = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "restart-build")
        .json(&json!({"profile":"cpu", "jobs":2, "clean":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    core.child.kill().await.unwrap();
    let core = support::Core::start(root.path()).await;
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
    assert_eq!(op["status"], "interrupted");
    let builds: Value = client
        .get(format!("{}/builds", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(builds["builds"][0]["status"], "interrupted");
}

#[tokio::test]
async fn surviving_owned_processes_block_new_work_after_a_core_crash() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start_command(slow_toolchain(root.path())).await;
    let client = reqwest::Client::new();
    client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "crash-build")
        .json(&json!({"profile":"cpu", "jobs":2, "clean":false}))
        .send()
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    core.child.kill().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let snapshot: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(snapshot["state"], "recovery_required");
    assert!(!snapshot["recovery"].as_array().unwrap().is_empty());
    let response = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "blocked")
        .json(&json!({"profile":"cpu", "jobs":2, "clean":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409);
}

#[tokio::test]
async fn recovery_stops_only_a_verified_owned_process() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start_command(slow_toolchain(root.path())).await;
    let client = reqwest::Client::new();
    client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "owned")
        .json(&json!({"profile":"cpu", "jobs":2, "clean":false}))
        .send()
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    core.child.kill().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let snapshot: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = snapshot["recovery"][0]["id"].as_str().unwrap();
    let response = client
        .post(format!("{}/recovery/{id}/stop", core.url))
        .header("Idempotency-Key", "stop")
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let snapshot: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(snapshot["state"], "empty");
    assert_eq!(snapshot["recovery"], json!([]));
}

#[tokio::test]
async fn long_compiler_output_is_bounded_marked_and_downloadable_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let command = slow_toolchain(root.path());
    std::fs::write(root.path().join("tools/cmake"),"#!/usr/bin/python3\nimport sys,time\nsys.stdout.write('x'*100000+'\\n')\nsys.stdout.flush()\ntime.sleep(2)\n").unwrap();
    let core = support::Core::start_command(command).await;
    let client = reqwest::Client::new();
    client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "long-log")
        .json(&json!({"profile":"cpu","jobs":2,"clean":false}))
        .send()
        .await
        .unwrap();
    let logs = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let logs: Value = client
                .get(format!("{}/logs?source=build", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if !logs["entries"].as_array().unwrap().is_empty() {
                break logs;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        logs["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["message"].as_str().unwrap().len() <= 16384)
    );
    assert!(
        logs["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["truncated"] == true)
    );
    let segments: Vec<_> = logs["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect();
    drop(core);
    let core = support::Core::start(root.path()).await;
    let mut retained = String::new();
    for segment in segments {
        let download = client
            .get(format!("{}/logs/{segment}/download", core.url))
            .send()
            .await
            .unwrap();
        assert_eq!(download.status(), 200);
        retained.push_str(&download.text().await.unwrap());
    }
    assert!(retained.contains("xxxxxxxx"));
}

#[tokio::test]
async fn only_unused_build_artifacts_can_be_deleted() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let build = support::candidate(&core).await;
    let client = reqwest::Client::new();
    let url = format!("{}/builds/{build}", core.url);
    let response = client
        .delete(&url)
        .header("Idempotency-Key", "delete-build")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let accepted: Value = response.json().await.unwrap();
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
    assert_eq!(operation["status"], "succeeded");
    let builds: Value = client
        .get(format!("{}/builds", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(builds["builds"].as_array().unwrap().is_empty());
    assert_eq!(
        client
            .delete(&url)
            .header("Idempotency-Key", "delete-build")
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
}

#[tokio::test]
async fn startup_prepares_a_default_cuda_candidate_without_applying_or_loading_it() {
    let root = tempfile::tempdir().unwrap();
    let setup = support::with_fixture_toolchain(root.path()).await;
    drop(setup);
    let mut command = support::command(root.path());
    command
        .env_remove("CORE_AUTO_BUILD")
        .env(
            "PATH",
            format!(
                "{}:{}",
                root.path().join("tools").display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .env(
            "FIXTURE_ROUTER",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/router.py"),
        );
    let core = support::Core::start_command(command).await;
    let builds = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let builds: Value = reqwest::get(format!("{}/builds", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if builds["builds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["status"] == "ready")
            {
                break builds;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(builds["builds"][0]["profile"], "cuda");
    assert_eq!(builds["builds"][0]["jobs"], 8);
    assert_eq!(builds["builds"][0]["current"], false);
    let state: Value = reqwest::get(format!("{}/runtime", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["state"], "empty");
    assert!(state["active_instance"].is_null());
}

#[tokio::test]
async fn cancelling_during_candidate_health_check_stops_the_probe_promptly() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("slow-probe"), "").unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let client = reqwest::Client::new();
    let accepted: Value = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "probe-build")
        .json(&json!({"profile":"cpu","jobs":2,"clean":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = accepted["operation_id"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let logs: Value = client
                .get(format!("{}/logs?query=fixture%20probe%20waiting", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if !logs["entries"].as_array().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        client
            .post(format!("{}/operations/{id}/cancel", core.url))
            .header("Idempotency-Key", "cancel-probe")
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
            if operation["status"] == "cancelled" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("Cancel must stop a pending candidate health probe");
}

#[tokio::test]
async fn a_failed_build_deletion_leaves_the_candidate_usable() {
    use sea_orm::{ConnectionTrait, Database};
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let build = support::candidate(&core).await;
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    db.execute_unprepared("CREATE TRIGGER fail_command BEFORE INSERT ON request_keys BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END").await.unwrap();
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .delete(format!("{}/builds/{build}", core.url))
            .header("Idempotency-Key", "failed-delete-build")
            .send()
            .await
            .unwrap()
            .status(),
        500
    );
    db.execute_unprepared("DROP TRIGGER fail_command")
        .await
        .unwrap();
    let accepted: Value = client
        .post(format!("{}/builds/{build}/apply", core.url))
        .header("Idempotency-Key", "apply-preserved-build")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
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
            assert_ne!(
                operation["status"], "failed",
                "Rejected deletion must preserve a runnable candidate"
            );
            if operation["status"] == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_changed_driver_rechecks_the_existing_cuda_artifact_without_rebuilding_it() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::with_fixture_toolchain(root.path()).await;
    let client = reqwest::Client::new();
    let accepted: Value = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "cuda-candidate")
        .json(&json!({"profile":"cuda","jobs":2,"clean":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let build = tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
                break op["resource_id"].as_str().unwrap().to_string();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    core.child.kill().await.unwrap();
    let binary = root
        .path()
        .join("data/builds")
        .join(&build)
        .join("bin/llama-server");
    let text = std::fs::read_to_string(&binary).unwrap().replace(
        "if '--list-devices' in sys.argv:",
        "if '--list-devices' in sys.argv:\n    raise SystemExit(9)",
    );
    std::fs::write(binary, text).unwrap();
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
    command.env("LD_LIBRARY_PATH", root.path().join("nvml"));
    let core = support::Core::start_command(command).await;
    let builds: Value = client
        .get(format!("{}/builds", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        builds["builds"].as_array().unwrap().len(),
        1,
        "A driver change must not trigger a blind rebuild"
    );
    assert_eq!(
        builds["builds"][0]["checks"]["driver_compatibility"],
        "failed"
    );
    assert_eq!(
        client
            .post(format!("{}/builds/{build}/apply", core.url))
            .header("Idempotency-Key", "incompatible-apply")
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
}

#[tokio::test]
async fn automatic_build_is_deferred_until_crash_recovery_is_resolved() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start_command(slow_toolchain(root.path())).await;
    std::fs::write(root.path().join("tools/cmake"), "#!/usr/bin/python3\nimport time\nprint('fixture-compiler-started', flush=True)\ntime.sleep(30)\n").unwrap();
    let client = reqwest::Client::new();
    client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "crash-build")
        .json(&json!({"profile":"cpu", "jobs":2, "clean":false}))
        .send()
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    core.child.kill().await.unwrap();
    let mut command = support::command(root.path());
    command.env("CORE_AUTO_BUILD", "1").env(
        "PATH",
        format!(
            "{}:{}",
            root.path().join("tools").display(),
            std::env::var("PATH").unwrap()
        ),
    );
    let core = support::Core::start_command(command).await;
    let snapshot: Value = client
        .get(format!("{}/runtime", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(snapshot["state"], "recovery_required");
    assert!(!snapshot["recovery"].as_array().unwrap().is_empty());
    let response = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "blocked")
        .json(&json!({"profile":"cpu", "jobs":2, "clean":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409);

    for process in snapshot["recovery"].as_array().unwrap() {
        let response = client
            .post(format!(
                "{}/recovery/{}/stop",
                core.url,
                process["id"].as_str().unwrap()
            ))
            .header("Idempotency-Key", format!("stop-{}", process["id"]))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 202, "{}", response.text().await.unwrap());
    }
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let builds: Value = reqwest::get(format!("{}/builds", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if builds["builds"].as_array().unwrap().len() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("The deferred automatic build must resume once recovery is resolved");
}

#[tokio::test]
async fn a_failed_build_publication_never_reports_a_successful_operation() {
    use sea_orm::{ConnectionTrait, Database};
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    db.execute_unprepared("CREATE TRIGGER fail_build_publication BEFORE INSERT ON builds WHEN json_extract(NEW.body,'$.status')='ready' BEGIN SELECT RAISE(ABORT,'fixture storage unavailable'); END").await.unwrap();
    let accepted: Value = reqwest::Client::new()
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "publication-failure")
        .json(&json!({"profile":"cpu","jobs":2,"clean":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let op: Value = reqwest::get(format!(
                "{}/operations/{}",
                core.url,
                accepted["operation_id"].as_str().unwrap()
            ))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
            assert_ne!(
                op["status"], "succeeded",
                "An uncommitted candidate must not be reported as successful"
            );
            if op["status"] == "failed" {
                assert!(op["error"]["message"].is_string());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
