use axum::{
    Extension,
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
};
use sea_orm::DatabaseConnection;
use serde_json::{Value, json};
use std::{convert::Infallible, sync::Arc};
use tokio::sync::{Mutex, broadcast};

#[derive(Clone)]
pub(crate) struct Events(Arc<Mutex<State>>);
struct State {
    session: String,
    seq: u64,
    snapshot: Value,
    sender: broadcast::Sender<Value>,
}
impl State {
    fn envelope(&mut self, kind: &str, payload: Value) -> Value {
        self.seq += 1;
        json!({"session_id":self.session,"seq":self.seq,"type":kind,"timestamp":chrono::Utc::now().to_rfc3339(),"payload":payload})
    }
}
async fn snapshot(
    db: &DatabaseConnection,
    runtime: &crate::runtime::Runtime,
    directory: &crate::presets::Directory,
) -> Value {
    let settings = crate::settings::read(Extension(db.clone()))
        .await
        .ok()
        .map(|v| v.0);
    let operations = crate::operations::all(db, "operations")
        .await
        .unwrap_or_default();
    let presets = crate::presets::catalog(
        Extension(directory.clone()),
        Extension(runtime.clone()),
        Extension(db.clone()),
    )
    .await
    .ok()
    .map(|v| v.0);
    let builds = crate::operations::all(db, "builds")
        .await
        .unwrap_or_default();
    let sets = crate::operations::all(db, "model_sets")
        .await
        .unwrap_or_default();
    let runtime = crate::runtime::snapshot(Extension(runtime.clone())).await.0;
    json!({"runtime":runtime,"settings":settings,"operations":operations,"catalog_revisions":{"presets":presets.as_ref().map(|p|p["revision"].clone()),"builds":crate::presets::revision(&json!(builds).to_string()),"model_sets":crate::presets::revision(&json!(sets).to_string())}})
}
impl Events {
    pub async fn start(
        db: DatabaseConnection,
        runtime: crate::runtime::Runtime,
        directory: crate::presets::Directory,
        metrics: crate::metrics::Metrics,
    ) -> Self {
        let mut logs = crate::logs::subscribe(directory.0.parent().unwrap());
        let initial = snapshot(&db, &runtime, &directory).await;
        let (sender, _) = broadcast::channel(128);
        let data = Arc::new(Mutex::new(State {
            session: initial["runtime"]["session_id"].as_str().unwrap().into(),
            seq: 0,
            snapshot: initial,
            sender,
        }));
        let weak = Arc::downgrade(&data);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
            let mut last_metric = Value::Null;
            loop {
                tick.tick().await;
                let Some(data) = weak.upgrade() else {
                    break;
                };
                let next = snapshot(&db, &runtime, &directory).await;
                let mut state = data.lock().await;
                for (catalog, kind) in [("presets", "preset.changed"), ("builds", "build.changed")]
                {
                    if next["catalog_revisions"][catalog]
                        != state.snapshot["catalog_revisions"][catalog]
                    {
                        let event = state
                            .envelope(kind, json!({"revision":next["catalog_revisions"][catalog]}));
                        let _ = state.sender.send(event);
                    }
                }
                for (field, kind) in [
                    ("runtime", "runtime.changed"),
                    ("settings", "catalog.changed"),
                    ("operations", "operation.changed"),
                    ("catalog_revisions", "catalog.changed"),
                ] {
                    if next[field] != state.snapshot[field] {
                        state.snapshot[field] = next[field].clone();
                        let event = state.envelope(kind, next[field].clone());
                        let _ = state.sender.send(event);
                    }
                }
                for _ in 0..128 {
                    match logs.try_recv() {
                        Ok(entry) => {
                            let event = state.envelope("log.append", entry);
                            let _ = state.sender.send(event);
                        }
                        Err(broadcast::error::TryRecvError::Lagged(_)) => {
                            let event = state.envelope("gap", json!({"reason":"log_consumer_lag"}));
                            let _ = state.sender.send(event);
                            let snapshot = state.snapshot.clone();
                            let event = state.envelope("snapshot", snapshot);
                            let _ = state.sender.send(event);
                        }
                        Err(_) => break,
                    }
                }
                if let Some(metric) = metrics.latest()
                    && metric["timestamp"] != last_metric
                {
                    last_metric = metric["timestamp"].clone();
                    let event = state.envelope("metric.sample", metric);
                    let _ = state.sender.send(event);
                }
            }
        });
        Self(data)
    }
}
fn event(body: Value) -> Event {
    Event::default()
        .id(format!(
            "{}:{}",
            body["session_id"].as_str().unwrap(),
            body["seq"]
        ))
        .event(body["type"].as_str().unwrap())
        .data(body.to_string())
}
pub(crate) async fn subscribe(
    Extension(events): Extension<Events>,
    headers: HeaderMap,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let mut state = events.0.lock().await;
    let mut receiver = state.sender.subscribe();
    let expected = format!("{}:{}", state.session, state.seq);
    let gap = headers
        .get("Last-Event-ID")
        .is_some_and(|v| v.to_str().ok() != Some(expected.as_str()));
    let gap = gap.then(|| state.envelope("gap", json!({"reason":"history_unavailable"})));
    let payload = state.snapshot.clone();
    let initial = state.envelope("snapshot", payload);
    drop(state);
    Sse::new(async_stream::stream! {
        if let Some(gap)=gap {yield Ok(event(gap));}
        yield Ok(event(initial));
        loop {
            match receiver.recv().await {
                Ok(body)=>yield Ok(event(body)),
                Err(broadcast::error::RecvError::Closed)=>break,
                Err(broadcast::error::RecvError::Lagged(_))=>{
                    let mut state=events.0.lock().await;
                    receiver=state.sender.subscribe();
                    let gap=state.envelope("gap",json!({"reason":"consumer_lag"}));
                    let payload=state.snapshot.clone();let current=state.envelope("snapshot",payload);drop(state);
                    yield Ok(event(gap));yield Ok(event(current));
                }
            }
        }
    }).keep_alive(KeepAlive::default())
}
