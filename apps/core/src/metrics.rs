use crate::settings::ApiError;
use axum::{Extension, Json, extract::Query, http::StatusCode};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub(crate) struct Metrics(Arc<Mutex<VecDeque<Value>>>);
fn value(value: Option<Value>, unit: &str, time: &str, reason: Option<String>) -> Value {
    json!({"value":value,"unit":unit,"availability":if value.is_some(){"available"}else{"unsupported"},"sampled_at":time,"last_success_at":if value.is_some(){Some(time)}else{None},"reason":reason})
}
fn sensor<T: serde::Serialize>(
    reading: Result<T, nvml_wrapper::error::NvmlError>,
    unit: &str,
    time: &str,
) -> Value {
    match reading {
        Ok(v) => value(Some(json!(v)), unit, time, None),
        Err(e) => {
            use nvml_wrapper::error::NvmlError;
            let mut reading = value(None, unit, time, Some(e.to_string()));
            if !matches!(
                e,
                NvmlError::NotSupported
                    | NvmlError::FunctionNotFound
                    | NvmlError::LibloadingError(_)
            ) {
                reading["availability"] = json!("error");
            }
            reading
        }
    }
}

fn retain_last_success(current: &mut Value, previous: &Value) {
    if current.get("availability").is_some() && current.get("sampled_at").is_some() {
        if current["value"].is_null() {
            current["last_success_at"] = previous["last_success_at"].clone();
        }
    } else if let Some(fields) = current.as_object_mut() {
        for (key, child) in fields {
            retain_last_success(child, &previous[key]);
        }
    } else if let Some(items) = current.as_array_mut() {
        for (index, child) in items.iter_mut().enumerate() {
            let identity = ["id", "pid", "name", "gpu_id"]
                .into_iter()
                .find(|key| child.get(key).is_some());
            let old = identity
                .and_then(|key| {
                    previous
                        .as_array()?
                        .iter()
                        .find(|old| old[key] == child[key])
                })
                .unwrap_or_else(|| {
                    if identity.is_none() {
                        &previous[index]
                    } else {
                        &Value::Null
                    }
                });
            retain_last_success(child, old);
        }
    }
}
fn mark_unavailable(value: &mut Value, time: &str, reason: &str) {
    if value.get("availability").is_some() && value.get("sampled_at").is_some() {
        value["value"] = Value::Null;
        value["availability"] = json!("error");
        value["sampled_at"] = json!(time);
        value["reason"] = json!(reason);
    } else if let Some(fields) = value.as_object_mut() {
        for child in fields.values_mut() {
            mark_unavailable(child, time, reason);
        }
    } else if let Some(items) = value.as_array_mut() {
        for child in items {
            mark_unavailable(child, time, reason);
        }
    }
}

impl Metrics {
    pub fn latest(&self) -> Option<Value> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .back()
            .cloned()
    }
    pub fn start(
        session: String,
        telemetry: crate::telemetry::Telemetry,
        root: std::path::PathBuf,
    ) -> Self {
        let data = Arc::new(Mutex::new(VecDeque::<Value>::new()));
        let weak = Arc::downgrade(&data);
        std::thread::spawn(move || {
            let mut next = std::time::Instant::now() + std::time::Duration::from_secs(1);
            let mut system = sysinfo::System::new_all();
            let mut components = sysinfo::Components::new_with_refreshed_list();
            let nvml = nvml_wrapper::Nvml::init().ok();
            let cuda = cuda_indices().unwrap_or_default();
            loop {
                std::thread::sleep(next.saturating_duration_since(std::time::Instant::now()));
                next += std::time::Duration::from_secs(1);
                let Some(data) = weak.upgrade() else {
                    break;
                };
                system.refresh_cpu_all();
                system.refresh_memory();
                let owned = crate::processes::owned_pids(&root);
                let pids: Vec<_> = owned.iter().copied().map(sysinfo::Pid::from_u32).collect();
                system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&pids), true);
                components.refresh(true);
                let time = chrono::Utc::now().to_rfc3339();
                let logical:Vec<_>=system.cpus().iter().map(|cpu|json!({"name":cpu.name(),"usage":value(Some(json!(cpu.cpu_usage())),"percent",&time,None),"frequency":value(Some(json!(cpu.frequency())),"MHz",&time,None)})).collect();
                let temperatures:Vec<_>=components.iter().map(|c|json!({"name":c.label(),"temperature":value(c.temperature().map(|n|json!(n)),"celsius",&time,c.temperature().is_none().then(||"Temperature sensor unavailable".into()))})).collect();
                let mut gpus = vec![];
                let mut gpu_error = None;
                if let Some(nvml) = nvml.as_ref() {
                    let count = nvml.device_count().unwrap_or_else(|error| {
                        gpu_error = Some(error.to_string());
                        0
                    });
                    for index in 0..count {
                        if let Ok(device) = nvml.device_by_index(index) {
                            let uuid = device.uuid().ok();
                            let pci = device.pci_info().ok().map(|p| p.bus_id);
                            gpus.push(json!({"id":uuid,"uuid":uuid,"pci":pci,"nvml_index":index,"cuda_index":uuid.as_ref().and_then(|id|cuda.get(id)),"name":device.name().ok(),
                                "utilisation":sensor(device.utilization_rates().map(|u|u.gpu),"percent",&time),
                                "vram_used":sensor(device.memory_info().map(|m|m.used),"bytes",&time),
                                "vram_total":sensor(device.memory_info().map(|m|m.total),"bytes",&time),
                                "temperature":sensor(device.temperature(nvml_wrapper::enum_wrappers::device::TemperatureSensor::Gpu),"celsius",&time),
                                "power":sensor(device.power_usage().map(|n|n as f64/1000.0),"watts",&time),"fan":sensor(device.fan_speed(0),"percent",&time)}));
                        }
                    }
                }
                let processes:Vec<_>=owned.into_iter().filter_map(|pid|system.process(sysinfo::Pid::from_u32(pid)).map(|process| {
                    let mut gpu_memory=vec![];
                    if let Some(nvml)=nvml.as_ref() {
                        for gpu in &gpus {
                            if let Some(index)=gpu["nvml_index"].as_u64() && let Ok(device)=nvml.device_by_index(index as u32) {
                                let memory=device.running_compute_processes().map(|entries|entries.into_iter().find(|entry|entry.pid==pid).map(|entry|entry.used_gpu_memory).unwrap_or(nvml_wrapper::enums::device::UsedGpuMemory::Used(0)));
                                let reading=match memory {Ok(nvml_wrapper::enums::device::UsedGpuMemory::Used(bytes))=>value(Some(json!(bytes)),"bytes",&time,None),Ok(_)=>value(None,"bytes",&time,Some("Per-process allocation unsupported".into())),Err(error)=>sensor::<u64>(Err(error),"bytes",&time)};
                                gpu_memory.push(json!({"gpu_id":gpu["id"],"memory":reading}));
                            }
                        }
                    }
                    json!({"pid":pid,"role":if pid==std::process::id(){"core"}else{"owned"},"cpu":value(Some(json!(process.cpu_usage())),"percent",&time,None),"ram":value(Some(json!(process.memory())),"bytes",&time,None),"gpu_memory":gpu_memory})
                })).collect();
                let mut sample = json!({"session_id":session,"timestamp":time,"inference":telemetry.snapshot(),"processes":processes,"cpu":{"total":value(Some(json!(system.global_cpu_usage())),"percent",&time,None),"logical":logical,"temperatures":temperatures},
                    "ram":{"total":value(Some(json!(system.total_memory())),"bytes",&time,None),"used":value(Some(json!(system.used_memory())),"bytes",&time,None),"swap_total":value(Some(json!(system.total_swap())),"bytes",&time,None),"swap_used":value(Some(json!(system.used_swap())),"bytes",&time,None)},"gpus":gpus,"gpu_availability":if nvml.is_some(){"available"}else{"unsupported"}});
                let mut samples = data.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(previous) = samples.back() {
                    if let Some(reason) = &gpu_error {
                        let mut missing = previous["gpus"].clone();
                        mark_unavailable(&mut missing, &time, reason);
                        sample["gpus"] = missing;
                    }
                    retain_last_success(&mut sample, previous);
                }
                if gpu_error.is_some() {
                    sample["gpu_availability"] = json!("error");
                }
                samples.push_back(sample);
                while samples.len() > 3600 {
                    samples.pop_front();
                }
            }
        });
        Self(data)
    }
}
pub(crate) async fn list(
    Extension(metrics): Extension<Metrics>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let parse = |key: &str| {
        query
            .get(key)
            .map(|s| {
                chrono::DateTime::parse_from_rfc3339(s).map_err(|_| {
                    ApiError(
                        StatusCode::BAD_REQUEST,
                        "invalid_request",
                        "Use RFC3339 metric bounds".into(),
                    )
                })
            })
            .transpose()
    };
    let from = parse("from")?;
    let to = parse("to")?;
    let samples: Vec<_> = metrics
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|s| {
            let time =
                chrono::DateTime::parse_from_rfc3339(s["timestamp"].as_str().unwrap()).unwrap();
            from.is_none_or(|f| time >= f) && to.is_none_or(|t| time <= t)
        })
        .cloned()
        .collect();
    Ok(Json(json!({"samples":samples})))
}

// CUDA driver declarations follow the installed cuda.h ABI. No CUDA context
// or allocation is created; missing drivers/symbols leave indices unavailable.
fn cuda_indices() -> Option<HashMap<String, i32>> {
    unsafe {
        let library = libloading::Library::new("libcuda.so.1").ok()?;
        let init = library
            .get::<unsafe extern "C" fn(u32) -> i32>(b"cuInit\0")
            .ok()?;
        let count = library
            .get::<unsafe extern "C" fn(*mut i32) -> i32>(b"cuDeviceGetCount\0")
            .ok()?;
        let device = library
            .get::<unsafe extern "C" fn(*mut i32, i32) -> i32>(b"cuDeviceGet\0")
            .ok()?;
        let uuid = library
            .get::<unsafe extern "C" fn(*mut [u8; 16], i32) -> i32>(b"cuDeviceGetUuid\0")
            .ok()?;
        let mut n = 0;
        if init(0) != 0 || count(&mut n) != 0 {
            return None;
        }
        let mut result = HashMap::new();
        for index in 0..n {
            let mut handle = 0;
            let mut bytes = [0u8; 16];
            if device(&mut handle, index) == 0 && uuid(&mut bytes, handle) == 0 {
                result.insert(format!("GPU-{}", uuid::Uuid::from_bytes(bytes)), index);
            }
        }
        Some(result)
    }
}
