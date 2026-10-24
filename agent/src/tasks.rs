//! Structured remote tasks on the existing authenticated terminal connection.
use std::{collections::HashMap, path::{Component, Path, PathBuf}, sync::{Arc, Mutex}, process::Stdio};
use serde_json::{json, Value};
use tokio::{io::AsyncReadExt, sync::{mpsc, Semaphore}};
use iroh::endpoint::{RecvStream, SendStream};
use uuid::Uuid;
use crate::{termstream::{Frame, FrameDecoder}, serve::{read_frame, write_frame}};

const FILE_LIMIT: u64 = 128 * 1024;

#[derive(Clone)]
struct Binding { root: PathBuf, shell: String, version: String }

pub struct TaskService {
    device: String,
    bindings: Mutex<HashMap<String, Binding>>,
    requests: Mutex<std::collections::HashSet<String>>,
    commands: Semaphore,
}

impl TaskService {
    pub fn new(device: String) -> Self {
        Self { device, bindings: Mutex::new(HashMap::new()), requests: Mutex::new(Default::default()), commands: Semaphore::new(1) }
    }
}

fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| format!("INVALID_ARGUMENT: {key}"))
}

// Canonical parent and target checks reject traversal and symlink escapes.
fn scoped(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)) {
        return Err("PATH_OUTSIDE_BINDING".into());
    }
    let joined = root.join(path);
    let resolved = if joined.exists() { joined.canonicalize() } else {
        joined.parent().ok_or("INVALID_PATH")?.canonicalize().map(|p| p.join(joined.file_name().unwrap_or_default()))
    }.map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) { return Err("PATH_OUTSIDE_BINDING".into()); }
    if std::fs::symlink_metadata(&joined).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("SYMLINK_NOT_ALLOWED".into());
    }
    Ok(resolved)
}

fn file_operation(binding: &Binding, req: &Value) -> Result<Value, String> {
    let action = string(req, "action")?;
    let path = scoped(&binding.root, string(req, "path")?)?;
    match action {
        "fs.read" => {
            use std::io::Read;
            let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("NOT_A_FILE".into()); }
            let mut bytes = Vec::new();
            file.take(FILE_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            if bytes.len() as u64 > FILE_LIMIT { return Err("FILE_TOO_LARGE: 128 KiB maximum".into()); }
            let content = String::from_utf8(bytes).map_err(|_| "NOT_UTF8")?;
            Ok(json!({"content":content}))
        }
        "fs.write" => {
            use std::io::Write;
            let content = req.get("content").and_then(Value::as_str).ok_or("INVALID_CONTENT")?;
            if content.len() as u64 > FILE_LIMIT { return Err("FILE_TOO_LARGE".into()); }
            let tmp = path.with_file_name(format!(".lingxi-{}.tmp", Uuid::new_v4()));
            let result = (|| -> std::io::Result<()> {
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
                if let Ok(meta) = std::fs::metadata(&path) { file.set_permissions(meta.permissions())?; }
                file.write_all(content.as_bytes())?;
                file.sync_all()?;
                drop(file);
                std::fs::rename(&tmp, &path)?;
                Ok(())
            })();
            if result.is_err() { let _ = std::fs::remove_file(&tmp); }
            result.map_err(|e| e.to_string())?;
            Ok(json!({"bytesWritten":content.len()}))
        }
        "fs.delete" => {
            if path == binding.root { return Err("CANNOT_DELETE_BINDING_ROOT".into()); }
            // Directories are deliberately non-recursive.
            if path.is_dir() { std::fs::remove_dir(path) } else { std::fs::remove_file(path) }.map_err(|e| e.to_string())?;
            Ok(json!({"deleted":true}))
        }
        "fs.list" => {
            let mut entries = Vec::new();
            for item in std::fs::read_dir(path).map_err(|e| e.to_string())? {
                let item = item.map_err(|e| e.to_string())?;
                if entries.len() >= 1000 { return Err("DIRECTORY_TOO_LARGE: 1000 entries maximum".into()); }
                entries.push(json!({"name":item.file_name().to_string_lossy(),"isDirectory":item.file_type().map_err(|e| e.to_string())?.is_dir()}));
            }
            Ok(json!({"entries":entries}))
        }
        _ => Err("UNKNOWN_ACTION".into()),
    }
}

fn envelope(service: &TaskService, req: &Value, mut data: Value) -> Value {
    data["deviceId"] = json!(service.device);
    data["agentFingerprint"] = json!(service.device);
    for key in ["requestId", "sessionId", "bindingVersion"] { data[key] = req[key].clone(); }
    data
}

pub async fn serve(service: Arc<TaskService>, req: Value, mut send: SendStream, mut recv: RecvStream, mut decoder: FrameDecoder) {
    let result = handle(&service, &req, &mut send, &mut recv, &mut decoder).await;
    let data = match result {
        Ok(data) => data,
        Err(error) => json!({"event":"result","status":"FAILED","error":error}),
    };
    let _ = write_frame(&mut send, &Frame::Task(envelope(&service, &req, data))).await;
    let _ = send.finish();
}

async fn handle(service: &TaskService, req: &Value, send: &mut SendStream, recv: &mut RecvStream, decoder: &mut FrameDecoder) -> Result<Value, String> {
    if string(req, "deviceId")? != service.device { return Err("DEVICE_ID_MISMATCH".into()); }
    let request = string(req, "requestId")?;
    {
        let mut seen = service.requests.lock().unwrap();
        if seen.len() >= 100_000 { return Err("REQUEST_LIMIT: reconnect explicitly".into()); }
        if !seen.insert(request.to_owned()) { return Err("DUPLICATE_REQUEST: will not replay".into()); }
    }
    if string(req, "action")? == "bind" {
        let root = std::fs::canonicalize(string(req, "workDir")?).map_err(|e| e.to_string())?;
        if !root.is_dir() { return Err("NOT_A_DIRECTORY".into()); }
        std::fs::read_dir(&root).map_err(|e| e.to_string())?;
        let shell = string(req, "shell")?.to_owned();
        if !Path::new(&shell).is_absolute() || !Path::new(&shell).is_file() { return Err("SHELL_REQUIRES_EXISTING_ABSOLUTE_PATH".into()); }
        let binding = Binding { root, shell, version: Uuid::new_v4().to_string() };
        let session = Uuid::new_v4().to_string();
        let result = json!({"event":"result","status":"SUCCESS","binding":{"sessionId":session,"bindingVersion":binding.version,"workDir":binding.root,"shell":binding.shell}});
        let mut bindings = service.bindings.lock().unwrap();
        if bindings.len() >= 1024 { return Err("BINDING_LIMIT".into()); }
        bindings.insert(session, binding);
        return Ok(result);
    }
    let binding = service.bindings.lock().unwrap().get(string(req, "sessionId")?).cloned().ok_or("UNKNOWN_SESSION")?;
    if string(req, "bindingVersion")? != binding.version { return Err("BINDING_MISMATCH".into()); }
    if string(req, "action")? == "command.run" {
        let _permit = service.commands.try_acquire().map_err(|_| "DEVICE_BUSY")?;
        run_command(service, req, &binding, send, recv, decoder).await
    } else {
        let req = req.clone();
        let result = tokio::task::spawn_blocking(move || file_operation(&binding, &req)).await.map_err(|e| e.to_string())??;
        Ok(json!({"event":"result","status":"SUCCESS","result":result}))
    }
}

// A private process group avoids terminating the Agent's own session.
struct ProcessTree(u32);
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe { unsafe extern "C" { fn kill(pid: i32, sig: i32) -> i32; } kill(-(self.0 as i32), 9); }
    }
}

async fn pump<R: tokio::io::AsyncRead + Unpin>(mut reader: R, channel: &'static str, tx: mpsc::Sender<(&'static str, Vec<u8>)>) {
    let mut buf = vec![0; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => if tx.send((channel, buf[..n].to_vec())).await.is_err() { break; },
        }
    }
}

async fn run_command(service: &TaskService, req: &Value, binding: &Binding, send: &mut SendStream, recv: &mut RecvStream, decoder: &mut FrameDecoder) -> Result<Value, String> {
    let command = string(req, "command")?;
    let timeout = req.get("timeoutMs").and_then(Value::as_u64).unwrap_or(120_000).clamp(1, 3_600_000);
    let mut cmd = tokio::process::Command::new(&binding.shell);
    #[cfg(unix)]
    { cmd.arg("-c"); cmd.process_group(0); }
    #[cfg(windows)]
    { if binding.shell.to_lowercase().ends_with("cmd.exe") { cmd.args(["/D", "/S", "/C"]); } else { cmd.args(["-NoProfile", "-NonInteractive", "-Command"]); } }
    cmd.arg(command).current_dir(&binding.root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("COMMAND_START_FAILED: {e}"))?;
    let tree = ProcessTree(child.id().ok_or("NO_PROCESS_ID")?);
    #[cfg(windows)]
    let job = crate::pty::windows_job::JobObject::capture(tree.0).ok_or("JOB_CAPTURE_FAILED")?;
    let (tx, mut rx) = mpsc::channel(16);
    let stdout = tokio::spawn(pump(child.stdout.take().unwrap(), "stdout", tx.clone()));
    let stderr = tokio::spawn(pump(child.stderr.take().unwrap(), "stderr", tx));
    let deadline = tokio::time::sleep(std::time::Duration::from_millis(timeout));
    tokio::pin!(deadline);
    let mut exit = None;
    let mut drained = false;
    let mut bytes = 0;
    let outcome = loop {
        if exit.is_some() && drained { break "SUCCESS"; }
        tokio::select! {
            status = child.wait(), if exit.is_none() => { exit = Some(status.map_err(|e| e.to_string())?); }
            chunk = rx.recv(), if !drained => match chunk {
                Some((channel, data)) => {
                    bytes += data.len();
                    if bytes > 1024 * 1024 { break "OUTPUT_LIMIT"; }
                    use base64::Engine;
                    let event = envelope(service, req, json!({"event":"output","channel":channel,"data":base64::engine::general_purpose::STANDARD.encode(data)}));
                    if write_frame(send, &Frame::Task(event)).await.is_err() { break "UNKNOWN"; }
                }
                None => drained = true,
            },
            incoming = read_frame(recv, decoder) => {
                match incoming {
                    Ok(Some(Frame::Task(cancel))) if cancel["action"] == "command.cancel" && cancel["requestId"] == req["requestId"] => break "CANCELLED",
                    _ => break "UNKNOWN",
                }
            }
            _ = &mut deadline => break "TIMED_OUT",
        }
    };
    drop(tree);
    #[cfg(windows)]
    drop(job);
    if exit.is_none() { let _ = child.kill().await; let _ = child.wait().await; }
    stdout.abort(); stderr.abort();
    let code = exit.and_then(|s| s.code());
    let status = if outcome == "SUCCESS" && code != Some(0) { "FAILED" } else { outcome };
    Ok(json!({"event":"result","status":status,"exitCode":code}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_roundtrip_and_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let binding = Binding { root: dir.path().canonicalize().unwrap(), shell: "/bin/sh".into(), version: "v1".into() };
        file_operation(&binding, &json!({"action":"fs.write","path":"hello.txt","content":"你好\n"})).unwrap();
        assert_eq!(file_operation(&binding, &json!({"action":"fs.read","path":"hello.txt"})).unwrap()["content"], "你好\n");
        assert!(file_operation(&binding, &json!({"action":"fs.read","path":"../secret"})).is_err());
        assert!(file_operation(&binding, &json!({"action":"fs.delete","path":"."})).is_err());
        assert!(file_operation(&binding, &json!({"action":"fs.write","path":"big","content":"x".repeat(FILE_LIMIT as usize+1)})).is_err());
        file_operation(&binding, &json!({"action":"fs.delete","path":"hello.txt"})).unwrap();
        assert!(!dir.path().join("hello.txt").exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/", dir.path().join("outside")).unwrap();
        assert!(scoped(dir.path(), "outside/etc/passwd").is_err());
    }
}
