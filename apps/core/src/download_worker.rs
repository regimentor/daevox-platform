use serde_json::{Value, json};
use std::{fs, io::Write, path::Path};

pub async fn run(manifest: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let files: Value = serde_json::from_slice(&fs::read(manifest)?)?;
    let directory = manifest.parent().ok_or("Missing worker directory")?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()?;
    for file in files.as_array().ok_or("Invalid worker manifest")? {
        if file["shared"] == true {
            continue;
        }
        let id = file["id"].as_str().ok_or("Missing file id")?;
        let url = file["url"].as_str().ok_or("Missing source URL")?;
        let path = directory.join(format!("{id}.partial"));
        let meta = directory.join(format!("{id}.identity.json"));
        let completed = directory.join(format!("{id}.completed.json"));
        if let Ok(bytes) = fs::read(&completed)
            && let Ok(record) = serde_json::from_slice::<Value>(&bytes)
            && record["url"] == url
            && fs::metadata(&path).is_ok_and(|m| Some(m.len()) == record["size"].as_u64())
        {
            continue;
        }
        let head = client
            .head(url)
            .header("Accept-Encoding", "identity")
            .send()
            .await
            .map_err(|_| "Metadata request failed")?
            .error_for_status()
            .map_err(|_| "Source metadata unavailable")?;
        let size = head
            .headers()
            .get("content-length")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.parse::<u64>().ok())
            .or(file["size_bytes"].as_u64());
        if let (Some(expected), Some(actual)) = (file["size_bytes"].as_u64(), size)
            && expected != actual
        {
            return Err("Source size changed; partial preserved".into());
        }
        let etag = head
            .headers()
            .get("etag")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let identity = json!({"url":url,"size":size,"etag":etag});
        let offset = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if meta.exists() {
            let saved: Value = serde_json::from_slice(&fs::read(&meta)?)?;
            if saved != identity {
                return Err(
                    "Source identity changed; partial preserved; explicitly restart this file"
                        .into(),
                );
            }
        } else {
            if offset > 0 {
                return Err("Partial identity is missing; explicitly restart this file".into());
            }
            fs::write(&meta, identity.to_string())?;
        }
        let mut request = client.get(url).header("Accept-Encoding", "identity");
        if offset > 0 {
            let validator = etag
                .as_deref()
                .filter(|s| !s.starts_with("W/") && !s.is_empty())
                .ok_or("No strong resume validator; explicitly restart this file")?;
            let total = size.ok_or("Missing resume size")?;
            if offset >= total {
                return Err("Partial length requires explicit restart".into());
            }
            request = request
                .header("Range", format!("bytes={offset}-{}", total - 1))
                .header("If-Range", validator);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "Download request failed")?;
        if offset > 0 {
            let total = size.ok_or("Missing resume size")?;
            let expected = format!("bytes {offset}-{}/{total}", total - 1);
            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT
                || response
                    .headers()
                    .get("content-range")
                    .and_then(|h| h.to_str().ok())
                    != Some(expected.as_str())
            {
                return Err(
                    "Range response is invalid; partial preserved; explicitly restart this file"
                        .into(),
                );
            }
        } else if response.status() != reqwest::StatusCode::OK {
            return Err("Source rejected the download".into());
        }
        if let Some(response_etag) = response.headers().get("etag").and_then(|h| h.to_str().ok())
            && etag.as_deref() != Some(response_etag)
        {
            return Err("Response identity changed; partial preserved".into());
        }
        if response.headers().contains_key("content-encoding") {
            return Err("Encoded transfers are unsupported; partial preserved".into());
        }
        let mut output = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        let mut bytes = offset;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Download stream failed; partial retained")?
        {
            if size.is_some_and(|size| bytes + chunk.len() as u64 > size) {
                return Err("Download exceeds declared size".into());
            }
            output.write_all(&chunk)?;
            bytes += chunk.len() as u64;
        }
        output.sync_all()?;
        if size.is_some_and(|size| bytes != size) {
            return Err("Download is incomplete; partial retained".into());
        }
        let temporary = directory.join(format!("{id}.completed.tmp"));
        let mut record = fs::File::create(&temporary)?;
        record.write_all(json!({"url":url,"size":bytes}).to_string().as_bytes())?;
        record.sync_all()?;
        fs::rename(temporary, completed)?;
        fs::File::open(directory)?.sync_all()?;
    }
    Ok(())
}
