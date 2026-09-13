use serde_json::json;
use tokio::net::TcpListener;

struct Server {
    url: String,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, daevox_core::app()).await.unwrap();
        });
        Self { url, task }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn a_fresh_core_exposes_no_models_for_inference() {
    let server = Server::start().await;
    let response = reqwest::get(format!("{}/v1/models", server.url))
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        json!({"object": "list", "data": []})
    );
}

#[tokio::test]
async fn inference_without_an_active_model_is_rejected_without_autoloading() {
    let server = Server::start().await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/v1/chat/completions", server.url))
        .json(&json!({
            "model": "smollm-local",
            "messages": [{"role": "user", "content": "Hello"}]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 503);
    let body = response.json::<serde_json::Value>().await.unwrap();
    assert_eq!(body["error"]["code"], "no_active_model");
    assert_eq!(body["error"]["type"], "server_error");
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    assert_eq!(body["error"]["param"], json!(null));

    let models = client
        .get(format!("{}/v1/models", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(models.status(), 200);
    assert_eq!(
        models.json::<serde_json::Value>().await.unwrap(),
        json!({"object": "list", "data": []})
    );
}
