use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct Telemetry(pub Arc<Mutex<Value>>);
impl Telemetry {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(
            json!({"succeeded":0,"failed":0,"cancelled":0,"prompt_tokens":0,"completion_tokens":0,"last_request":null}),
        )))
    }
    pub fn snapshot(&self) -> Value {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn request(&self, active: &Value, streaming: bool) -> Request {
        Request {
            telemetry: self.clone(),
            started: std::time::Instant::now(),
            streaming,
            done: false,
            buffer: Vec::new(),
            discarded: false,
            status: "cancelled",
            record: json!({"request_id":uuid::Uuid::new_v4().to_string(),"instance_id":active["id"],"preset_id":active["preset_id"],"applied_revision":active["applied_preset_revision"],"build_id":active["build_id"],"ttft_ms":null,"duration_ms":null,"tokens_per_second":null,"prompt_tokens":null,"completion_tokens":null,"source":"llama-server timings","timestamp":null}),
        }
    }
}
pub(crate) struct Request {
    telemetry: Telemetry,
    started: std::time::Instant,
    streaming: bool,
    done: bool,
    buffer: Vec<u8>,
    discarded: bool,
    pub status: &'static str,
    record: Value,
}
impl Request {
    fn observe(&mut self, value: Value) {
        if !value["error"].is_null() {
            self.status = "failed";
        }
        if self.streaming
            && self.record["ttft_ms"].is_null()
            && value["choices"].as_array().is_some_and(|choices| {
                choices.iter().any(|c| {
                    ["content", "reasoning_content", "reasoning"]
                        .iter()
                        .any(|key| c["delta"][key].as_str().is_some_and(|s| !s.is_empty()))
                        || c["delta"]["tool_calls"]
                            .as_array()
                            .is_some_and(|t| !t.is_empty())
                })
            })
        {
            self.record["ttft_ms"] = json!(self.started.elapsed().as_secs_f64() * 1000.0);
        }
        for (key, timing) in [
            ("prompt_tokens", "prompt_n"),
            ("completion_tokens", "predicted_n"),
        ] {
            if value["usage"][key].is_u64() {
                self.record[key] = value["usage"][key].clone();
            } else if value["timings"][timing].is_u64() {
                self.record[key] = value["timings"][timing].clone();
            }
        }
        if let Some(rate) = value["timings"]["predicted_per_second"]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
        {
            self.record["tokens_per_second"] = json!(rate);
        }
    }
    pub fn chunk(&mut self, bytes: &[u8]) {
        if self.discarded {
            return;
        }
        if self.buffer.len() + bytes.len() > 1024 * 1024 {
            self.buffer.clear();
            self.discarded = true;
            return;
        }
        self.buffer.extend_from_slice(bytes);
        if self.streaming {
            while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = self.buffer.drain(..=end).collect();
                if line.starts_with(b"data: [DONE]") {
                    self.done = true;
                }
                if let Some(json) = line
                    .strip_prefix(b"data: ")
                    .and_then(|v| serde_json::from_slice(v).ok())
                {
                    self.observe(json);
                }
            }
        }
    }
    pub fn complete(&mut self, success: bool) {
        if !self.streaming
            && let Ok(json) = serde_json::from_slice(&self.buffer)
        {
            self.observe(json);
        }
        self.status = if success && self.status != "failed" && (!self.streaming || self.done) {
            "succeeded"
        } else {
            "failed"
        };
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        self.record["duration_ms"] = json!(self.started.elapsed().as_secs_f64() * 1000.0);
        self.record["timestamp"] = json!(chrono::Utc::now().to_rfc3339());
        self.record["status"] = json!(self.status);
        let mut state = self.telemetry.0.lock().unwrap_or_else(|e| e.into_inner());
        state[self.status] = json!(state[self.status].as_u64().unwrap_or(0) + 1);
        for key in ["prompt_tokens", "completion_tokens"] {
            state[key] =
                json!(state[key].as_u64().unwrap_or(0) + self.record[key].as_u64().unwrap_or(0));
        }
        state["last_request"] = self.record.clone();
    }
}
