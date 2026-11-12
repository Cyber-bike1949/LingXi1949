//! Structured remote tasks on the existing authenticated terminal connection.
use crate::{
    serve::{read_frame, write_frame},
    termstream::{Frame, FrameDecoder},
};
use iroh::endpoint::{RecvStream, SendStream};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};
use tokio::{
    io::AsyncReadExt,
    sync::{mpsc, Semaphore},
};
use uuid::Uuid;

const FILE_LIMIT: u64 = 128 * 1024;

#[derive(Clone)]
struct Binding {
    root: PathBuf,
    shell: String,
    version: String,
}

pub struct TaskService {
    device: String,
    bindings: Mutex<HashMap<String, Binding>>,
    claims: Arc<Mutex<HashMap<PathBuf, String>>>,
    requests: Mutex<std::collections::HashSet<String>>,
    commands: Semaphore,
}

impl TaskService {
    pub fn new(device: String, claims: Arc<Mutex<HashMap<PathBuf, String>>>) -> Self {
        Self {
            device,
            bindings: Mutex::new(HashMap::new()),
            claims,
            requests: Mutex::new(Default::default()),
            commands: Semaphore::new(1),
        }
    }
}

impl Drop for TaskService {
    fn drop(&mut self) {
        let bindings = self.bindings.get_mut().expect("bindings poisoned");
        let mut claims = self.claims.lock().expect("work-directory claims poisoned");
        for (session_id, binding) in bindings.drain() {
            if claims
                .get(&binding.root)
                .is_some_and(|owner| owner == &session_id)
            {
                claims.remove(&binding.root);
            }
        }
    }
}

fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("INVALID_ARGUMENT: {key}"))
}

// Canonical parent and target checks reject traversal and symlink escapes.
fn scoped(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err("PATH_OUTSIDE_BINDING".into());
    }
    let joined = root.join(path);
    let resolved = if joined.exists() {
        joined.canonicalize()
    } else {
        joined
            .parent()
            .ok_or("INVALID_PATH")?
            .canonicalize()
            .map(|p| p.join(joined.file_name().unwrap_or_default()))
    }
    .map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) {
        return Err("PATH_OUTSIDE_BINDING".into());
    }
    if std::fs::symlink_metadata(&joined).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("SYMLINK_NOT_ALLOWED".into());
    }
    Ok(resolved)
}

fn file_operation(binding: &Binding, req: &Value) -> Result<Value, String> {
    let action = string(req, "action")?;
    let path = scoped(&binding.root, string(req, "path")?)?;
    match action {
        "fs.stat" | "fs.readChunk" | "fs.uploadStart" | "fs.uploadChunk" | "fs.uploadCommit"
        | "fs.uploadAbort" => binary_operation(binding, req, &path),
        "fs.read" => {
            use std::io::Read;
            let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                return Err("NOT_A_FILE".into());
            }
            let mut bytes = Vec::new();
            file.take(FILE_LIMIT + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() as u64 > FILE_LIMIT {
                return Err("FILE_TOO_LARGE: 128 KiB maximum".into());
            }
            let content = String::from_utf8(bytes).map_err(|_| "NOT_UTF8")?;
            Ok(json!({"content":content}))
        }
        "fs.write" => {
            use std::io::Write;
            let content = req
                .get("content")
                .and_then(Value::as_str)
                .ok_or("INVALID_CONTENT")?;
            if content.len() as u64 > FILE_LIMIT {
                return Err("FILE_TOO_LARGE".into());
            }
            let tmp = path.with_file_name(format!(".lingxi-{}.tmp", Uuid::new_v4()));
            let result = (|| -> std::io::Result<()> {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&tmp)?;
                if let Ok(meta) = std::fs::metadata(&path) {
                    file.set_permissions(meta.permissions())?;
                }
                file.write_all(content.as_bytes())?;
                file.sync_all()?;
                drop(file);
                std::fs::rename(&tmp, &path)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
            result.map_err(|e| e.to_string())?;
            Ok(json!({"bytesWritten":content.len()}))
        }
        "fs.delete" => {
            if path == binding.root {
                return Err("CANNOT_DELETE_BINDING_ROOT".into());
            }
            // Directories are deliberately non-recursive.
            if path.is_dir() {
                std::fs::remove_dir(path)
            } else {
                std::fs::remove_file(path)
            }
            .map_err(|e| e.to_string())?;
            Ok(json!({"deleted":true}))
        }
        "fs.list" => {
            let mut entries = Vec::new();
            for item in std::fs::read_dir(path).map_err(|e| e.to_string())? {
                let item = item.map_err(|e| e.to_string())?;
                if entries.len() >= 1000 {
                    return Err("DIRECTORY_TOO_LARGE: 1000 entries maximum".into());
                }
                entries.push(json!({"name":item.file_name().to_string_lossy(),"isDirectory":item.file_type().map_err(|e| e.to_string())?.is_dir()}));
            }
            Ok(json!({"entries":entries}))
        }
        _ => Err("UNKNOWN_ACTION".into()),
    }
}

// Binary transfers are chunked to stay below the existing one-MiB frame limit.
fn binary_operation(binding: &Binding, req: &Value, path: &Path) -> Result<Value, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::{Read, Seek, SeekFrom, Write};
    const LIMIT: u64 = 64 * 1024 * 1024;
    const CHUNK: usize = 128 * 1024;
    let action = string(req, "action")?;
    let number = |key: &str| {
        req[key]
            .as_u64()
            .ok_or_else(|| format!("INVALID_ARGUMENT: {key}"))
    };
    let token = |m: &std::fs::Metadata| -> Result<String, String> {
        let time = m
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        Ok(format!("{}:{time}", m.len()))
    };
    if action == "fs.stat" || action == "fs.readChunk" {
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("NOT_A_FILE".into());
        }
        if meta.len() > LIMIT {
            return Err("FILE_TOO_LARGE: 64 MiB maximum".into());
        }
        let identity = token(&meta)?;
        if action == "fs.stat" {
            return Ok(json!({"size":meta.len(),"identity":identity}));
        }
        if string(req, "identity")? != identity {
            return Err("SOURCE_CHANGED".into());
        }
        let offset = number("offset")?;
        if offset > meta.len() {
            return Err("INVALID_OFFSET".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![0; CHUNK.min((meta.len() - offset) as usize)];
        file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        if token(&file.metadata().map_err(|e| e.to_string())?)? != identity {
            return Err("SOURCE_CHANGED".into());
        }
        return Ok(
            json!({"data":STANDARD.encode(&bytes),"offset":offset,"size":meta.len(),"identity":identity}),
        );
    }
    // Only random staging names created by this API may be appended or removed.
    let staging = |name: &str| -> Result<PathBuf, String> {
        let id = name
            .strip_prefix(".lingxi-upload-")
            .ok_or("INVALID_UPLOAD")?;
        Uuid::parse_str(id).map_err(|_| "INVALID_UPLOAD")?;
        scoped(&binding.root, name)
    };
    if action == "fs.uploadStart" {
        if path.exists() && req["overwrite"].as_bool() != Some(true) {
            return Err("DESTINATION_EXISTS".into());
        }
        if number("size")? > LIMIT {
            return Err("FILE_TOO_LARGE: 64 MiB maximum".into());
        }
        let name = format!(".lingxi-upload-{}", Uuid::new_v4());
        let temp = staging(&name)?;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp)
            .map_err(|e| e.to_string())?;
        return Ok(json!({"upload":name}));
    }
    let temp = staging(string(req, "upload")?)?;
    if action == "fs.uploadAbort" {
        std::fs::remove_file(temp).map_err(|e| e.to_string())?;
        return Ok(json!({"aborted":true}));
    }
    if action == "fs.uploadChunk" {
        let bytes = STANDARD
            .decode(string(req, "data")?)
            .map_err(|_| "INVALID_BASE64")?;
        if bytes.len() > CHUNK {
            return Err("CHUNK_TOO_LARGE".into());
        }
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(temp)
            .map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        if number("offset")? != size {
            return Err("INVALID_OFFSET".into());
        }
        if size + bytes.len() as u64 > LIMIT {
            return Err("FILE_TOO_LARGE".into());
        }
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        return Ok(json!({"bytesWritten":bytes.len()}));
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != number("size")? {
        return Err("SIZE_MISMATCH".into());
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if req["overwrite"].as_bool() == Some(true) {
        std::fs::rename(&temp, path).map_err(|e| e.to_string())?;
    } else {
        // A hard link atomically refuses an existing destination, including races.
        std::fs::hard_link(&temp, path).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&temp);
    }
    Ok(json!({"bytesWritten":number("size")?}))
}

fn envelope(service: &TaskService, req: &Value, mut data: Value) -> Value {
    data["deviceId"] = json!(service.device);
    data["agentFingerprint"] = json!(service.device);
    for key in ["requestId", "sessionId", "bindingVersion"] {
        data[key] = req[key].clone();
    }
    data
}

// Discover on the target: controller paths may belong to a different OS.
fn environment_defaults() -> Value {
    let work_dir = std::fs::canonicalize(crate::config::home_dir())
        .ok()
        .filter(|path| path.is_dir() && std::fs::read_dir(path).is_ok());
    let mut candidates = Vec::new();
    for key in ["SHELL", "ComSpec"] {
        if let Some(value) = std::env::var_os(key) {
            candidates.push(PathBuf::from(value));
        }
    }
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let root = PathBuf::from(root);
            candidates.push(root.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
            candidates.push(root.join("System32/cmd.exe"));
        }
    } else {
        candidates.extend(["/bin/bash", "/bin/zsh", "/bin/sh"].map(PathBuf::from));
    }
    let shells: Vec<_> = candidates
        .into_iter()
        .filter(|path| {
            if !path.is_absolute() || !path.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                path.metadata()
                    .map(|m| m.permissions().mode() & 0o111 != 0)
                    .unwrap_or(false)
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
        .fold(Vec::new(), |mut paths, path| {
            if !paths.contains(&path) {
                paths.push(path);
            }
            paths
        });
    json!({"workDir": work_dir, "shell": shells.first(), "shells": shells})
}

pub async fn serve(
    service: Arc<TaskService>,
    req: Value,
    mut send: SendStream,
    mut recv: RecvStream,
    mut decoder: FrameDecoder,
) {
    let result = handle(&service, &req, &mut send, &mut recv, &mut decoder).await;
    let data = match result {
        Ok(data) => data,
        Err(error) => json!({"event":"result","status":"FAILED","error":error}),
    };
    let _ = write_frame(&mut send, &Frame::Task(envelope(&service, &req, data))).await;
    let _ = send.finish();
}

async fn handle(
    service: &TaskService,
    req: &Value,
    send: &mut SendStream,
    recv: &mut RecvStream,
    decoder: &mut FrameDecoder,
) -> Result<Value, String> {
    if string(req, "deviceId")? != service.device {
        return Err("DEVICE_ID_MISMATCH".into());
    }
    let request = string(req, "requestId")?;
    {
        let mut seen = service.requests.lock().unwrap();
        if seen.len() >= 100_000 {
            return Err("REQUEST_LIMIT: reconnect explicitly".into());
        }
        if !seen.insert(request.to_owned()) {
            return Err("DUPLICATE_REQUEST: will not replay".into());
        }
    }
    if string(req, "action")? == "probe" {
        return Ok(
            json!({"event":"result","status":"SUCCESS","capabilities":["tasks","binary-files-v1"],"defaults":environment_defaults()}),
        );
    }
    if string(req, "action")? == "bind" {
        let root = std::fs::canonicalize(string(req, "workDir")?).map_err(|e| e.to_string())?;
        if !root.is_dir() {
            return Err("NOT_A_DIRECTORY".into());
        }
        std::fs::read_dir(&root).map_err(|e| e.to_string())?;
        let shell = string(req, "shell")?.to_owned();
        if !Path::new(&shell).is_absolute() || !Path::new(&shell).is_file() {
            return Err("SHELL_REQUIRES_EXISTING_ABSOLUTE_PATH".into());
        }
        let session = Uuid::new_v4().to_string();
        {
            let mut claims = service.claims.lock().unwrap();
            if let Some(owner) = claims.get(&root) {
                return Err(format!(
                    "WORKDIR_IN_USE: {} ({})",
                    root.display(),
                    &owner[..8]
                ));
            }
            claims.insert(root.clone(), session.clone());
        }
        let binding = Binding {
            root,
            shell,
            version: Uuid::new_v4().to_string(),
        };
        let result = json!({"event":"result","status":"SUCCESS","binding":{"sessionId":session,"bindingVersion":binding.version,"workDir":binding.root,"shell":binding.shell}});
        let mut bindings = service.bindings.lock().unwrap();
        if bindings.len() >= 1024 {
            service.claims.lock().unwrap().remove(&binding.root);
            return Err("BINDING_LIMIT".into());
        }
        bindings.insert(session, binding);
        return Ok(result);
    }
    let binding = service
        .bindings
        .lock()
        .unwrap()
        .get(string(req, "sessionId")?)
        .cloned()
        .ok_or("UNKNOWN_SESSION")?;
    if string(req, "bindingVersion")? != binding.version {
        return Err("BINDING_MISMATCH".into());
    }
    if string(req, "action")? == "command.run" {
        let _permit = service.commands.try_acquire().map_err(|_| "DEVICE_BUSY")?;
        run_command(service, req, &binding, send, recv, decoder).await
    } else {
        let req = req.clone();
        let result = tokio::task::spawn_blocking(move || file_operation(&binding, &req))
            .await
            .map_err(|e| e.to_string())??;
        Ok(json!({"event":"result","status":"SUCCESS","result":result}))
    }
}

// A private process group avoids terminating the Agent's own session.
struct ProcessTree(u32);
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            unsafe extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            kill(-(self.0 as i32), 9);
        }
    }
}

async fn pump<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    channel: &'static str,
    tx: mpsc::Sender<(&'static str, Vec<u8>)>,
) {
    let mut buf = vec![0; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if tx.send((channel, buf[..n].to_vec())).await.is_err() {
                    break;
                }
            }
        }
    }
}

async fn run_command(
    service: &TaskService,
    req: &Value,
    binding: &Binding,
    send: &mut SendStream,
    recv: &mut RecvStream,
    decoder: &mut FrameDecoder,
) -> Result<Value, String> {
    let command = string(req, "command")?;
    let timeout = req
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(120_000)
        .clamp(1, 3_600_000);
    let mut cmd = tokio::process::Command::new(&binding.shell);
    #[cfg(unix)]
    {
        cmd.arg("-c");
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        if binding.shell.to_lowercase().ends_with("cmd.exe") {
            cmd.args(["/D", "/S", "/C"]);
        } else {
            cmd.args(["-NoProfile", "-NonInteractive", "-Command"]);
        }
    }
    cmd.arg(command)
        .current_dir(&binding.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("COMMAND_START_FAILED: {e}"))?;
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
        if exit.is_some() && drained {
            break "SUCCESS";
        }
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
    if exit.is_none() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    stdout.abort();
    stderr.abort();
    let code = exit.and_then(|s| s.code());
    let status = if outcome == "SUCCESS" && code != Some(0) {
        "FAILED"
    } else {
        outcome
    };
    Ok(json!({"event":"result","status":status,"exitCode":code}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_roundtrip_and_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let binding = Binding {
            root: dir.path().canonicalize().unwrap(),
            shell: "/bin/sh".into(),
            version: "v1".into(),
        };
        file_operation(
            &binding,
            &json!({"action":"fs.write","path":"hello.txt","content":"你好\n"}),
        )
        .unwrap();
        assert_eq!(
            file_operation(&binding, &json!({"action":"fs.read","path":"hello.txt"})).unwrap()
                ["content"],
            "你好\n"
        );
        assert!(file_operation(&binding, &json!({"action":"fs.read","path":"../secret"})).is_err());
        assert!(file_operation(&binding, &json!({"action":"fs.delete","path":"."})).is_err());
        assert!(file_operation(
            &binding,
            &json!({"action":"fs.write","path":"big","content":"x".repeat(FILE_LIMIT as usize+1)})
        )
        .is_err());
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
    #[test]
    fn binary_upload_rejects_conflicts_and_wrong_offsets() {
        let dir = tempfile::tempdir().unwrap();
        let b = Binding {
            root: dir.path().canonicalize().unwrap(),
            shell: "/bin/sh".into(),
            version: "v1".into(),
        };
        let start = file_operation(
            &b,
            &json!({"action":"fs.uploadStart","path":"file.bin","size":3}),
        )
        .unwrap();
        let id = &start["upload"];
        assert!(file_operation(&b, &json!({"action":"fs.uploadChunk","path":"file.bin","upload":id,"offset":1,"data":"AP+A"})).is_err());
        file_operation(&b, &json!({"action":"fs.uploadChunk","path":"file.bin","upload":id,"offset":0,"data":"AP+A"})).unwrap();
        assert!(file_operation(
            &b,
            &json!({"action":"fs.uploadCommit","path":"file.bin","upload":id,"size":4})
        )
        .is_err());
        std::fs::write(dir.path().join("file.bin"), "existing").unwrap();
        assert!(file_operation(
            &b,
            &json!({"action":"fs.uploadCommit","path":"file.bin","upload":id,"size":3})
        )
        .is_err());
        assert_eq!(
            std::fs::read(dir.path().join("file.bin")).unwrap(),
            b"existing"
        );
        file_operation(&b, &json!({"action":"fs.uploadCommit","path":"file.bin","upload":id,"size":3,"overwrite":true})).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("file.bin")).unwrap(),
            vec![0, 255, 128]
        );
        let meta = file_operation(&b, &json!({"action":"fs.stat","path":"file.bin"})).unwrap();
        let read = file_operation(&b, &json!({"action":"fs.readChunk","path":"file.bin","offset":0,"identity":meta["identity"]})).unwrap();
        assert_eq!(read["data"], "AP+A");
        assert!(file_operation(
            &b,
            &json!({"action":"fs.readChunk","path":"file.bin","offset":0,"identity":"old"})
        )
        .is_err());
        assert!(file_operation(
            &b,
            &json!({"action":"fs.uploadAbort","path":"file.bin","upload":"file.bin"})
        )
        .is_err());
    }
}
