use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};

static OPTIONS: LazyLock<BTreeMap<String, Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/llama-options.json"))
        .expect("pinned option map")
});

pub(crate) struct Parsed {
    pub sections: BTreeMap<String, BTreeMap<String, String>>,
    pub diagnostics: Vec<Value>,
}

fn diagnostic(code: &str, message: &str, line: usize, key: Option<&str>) -> Value {
    json!({"severity": "error", "code": code, "message": message, "line": line, "key": key})
}

pub(crate) fn parse(text: &str) -> Parsed {
    let mut result = Parsed {
        sections: BTreeMap::new(),
        diagnostics: vec![],
    };
    let mut section = "*".to_string();
    let mut seen = BTreeSet::new();
    for (index, raw) in text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .enumerate()
    {
        let line = index + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with([';', '#']) {
            continue;
        }
        let content = raw.split([';', '#']).next().unwrap_or("").trim_end();
        if content.starts_with('[') && content.ends_with(']') {
            section = content[1..content.len() - 1].trim().to_string();
            if section.is_empty() || section.contains(['[', ']']) {
                result.diagnostics.push(diagnostic(
                    "invalid_syntax",
                    "Invalid section name",
                    line,
                    None,
                ));
            }
            if !seen.insert(section.clone()) {
                result.diagnostics.push(diagnostic(
                    "duplicate_section",
                    "Section is declared more than once",
                    line,
                    None,
                ));
            }
            result.sections.entry(section.clone()).or_default();
            continue;
        }
        let Some((key, value)) = content.split_once('=') else {
            result.diagnostics.push(diagnostic(
                "invalid_syntax",
                "Expected section or key=value",
                line,
                None,
            ));
            continue;
        };
        let key = key.trim_end();
        if key.is_empty()
            || !key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
        {
            result.diagnostics.push(diagnostic(
                "invalid_syntax",
                "Invalid or indented option key",
                line,
                Some(key),
            ));
            continue;
        }
        if key == "version" {
            continue;
        }
        let Some(option) = OPTIONS.get(key) else {
            result.diagnostics.push(diagnostic(
                "unknown_setting",
                "Unknown option for the pinned llama.cpp",
                line,
                Some(key),
            ));
            continue;
        };
        if option["kind"] == "integer" && value.trim().parse::<i32>().is_err() {
            result.diagnostics.push(diagnostic(
                "invalid_value",
                "Expected a signed 32-bit integer",
                line,
                Some(key),
            ));
        }
        let canonical = option["canonical"].as_str().unwrap();
        let value = if option["negated"] == true {
            if matches!(value.trim(), "1" | "true" | "enabled" | "on") {
                "false"
            } else {
                "true"
            }
        } else {
            value.trim()
        };
        if matches!(
            canonical,
            "host"
                | "port"
                | "models-dir"
                | "models-preset"
                | "models-max"
                | "models-autoload"
                | "no-models-autoload"
                | "load-on-startup"
                | "stop-timeout"
                | "dedup-cache-models"
                | "alias"
                | "api-key"
                | "api-key-file"
                | "ssl-key-file"
                | "ssl-cert-file"
                | "path"
                | "media-path"
                | "webui-config-file"
                | "slot-save-path"
                | "log-file"
                | "log-prompts-dir"
                | "log-disable"
                | "lookup-cache-dynamic"
                | "lookup-cache-static"
                | "cache-list"
                | "rpc"
                | "mmproj-url"
                | "model-url"
                | "hf-repo"
                | "hf-file"
                | "hf-token"
        ) || canonical.contains("draft")
        {
            result.diagnostics.push(diagnostic(
                "router_owned_setting",
                "This option is controlled by core or outside the single-model contract",
                line,
                Some(key),
            ));
            continue;
        }
        let options = result.sections.entry(section.clone()).or_default();
        if options
            .insert(canonical.to_string(), value.to_string())
            .is_some()
        {
            result.diagnostics.push(json!({"severity": "warning", "code": "duplicate_key", "message": format!("Repeated option {}; effective last value: {}", canonical, value.trim()), "line": line, "key": key}));
        }
    }
    result
}
