//! Agent configuration file (v2.0 doc 7.3).
//!
//! v2.0 removed the V1 cloud fields (`deviceId`, `deviceToken`, `relayUrl`):
//! identity is the Ed25519 keypair (doc 5.1), and there is no relay account.
//! Every remaining field has a default, so the agent runs with no config
//! file at all - "免账号、免配置" is the point of v2.0. The file exists only
//! to override defaults, and is created the first time `config set-*` runs.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::AgentError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShellConfig {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    #[serde(rename = "deviceName", default = "default_device_name")]
    pub device_name: String,
    /// Where the Ed25519 identity lives (doc 7.3). Points at the standard
    /// location unless overridden; `run`, `status` and `rotate-identity`
    /// all resolve the key through this field so an override affects every
    /// command consistently.
    #[serde(rename = "identityKeyPath", default = "default_identity_key_path")]
    pub identity_key_path: PathBuf,
    /// Fallback landing directory for received files when a transfer's
    /// session cwd is unknown (doc 7.6 rule 2).
    #[serde(rename = "receiveRoot", default = "Config::default_receive_root")]
    pub receive_root: PathBuf,
    /// Soft cap on concurrent remote terminal sessions (doc 7.3). "Soft" as
    /// in: enforced when a session is opened (the request past the cap gets
    /// SESSION_LIMIT_REACHED, see `session_table`), never by killing
    /// existing sessions when the value is lowered.
    #[serde(
        rename = "maxConcurrentSessions",
        default = "default_max_concurrent_sessions"
    )]
    pub max_concurrent_sessions: usize,
    #[serde(default = "Config::default_shell")]
    pub shell: ShellConfig,
}

fn default_max_concurrent_sessions() -> usize {
    8
}

fn default_identity_key_path() -> PathBuf {
    crate::identity::identity_path()
}

/// The system hostname, matching what V1's `bind` defaulted to.
pub fn default_device_name() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "lingxi1949".into())
}

impl Default for Config {
    fn default() -> Self {
        // Every field is serde-defaulted, so the empty object IS the default
        // config; going through serde keeps the two definitions of "default"
        // from drifting apart.
        serde_json::from_str("{}").expect("the empty config must be valid")
    }
}

impl Config {
    /// Matches LingXi1949's local terminal server, which starts a login shell
    /// (`rust-servers/src/pty/shell.rs`, `get_shell_login_args`). Without `-l`
    /// bash reads only `~/.bashrc`, and on Ubuntu it is `~/.profile` that puts
    /// `~/.local/bin` on PATH - so everything installed there (pipx, cargo, npm
    /// globals, Claude Code) is missing from the remote terminal while an SSH
    /// session finds it fine. That mismatch is very hard to trace back to a
    /// login shell, and a remote terminal is supposed to behave like the local
    /// one.
    ///
    /// PowerShell has no login-shell concept and reads its profile either way.
    pub fn default_shell() -> ShellConfig {
        if cfg!(windows) {
            ShellConfig {
                program: "powershell.exe".into(),
                args: vec![],
            }
        } else {
            ShellConfig {
                program: "/bin/bash".into(),
                args: vec!["-l".into()],
            }
        }
    }

    pub fn default_receive_root() -> PathBuf {
        home_dir().join("TermyReceive")
    }

    /// Missing file = defaults (v2.0 runs configless); present file must
    /// parse and validate. Only a present-but-broken file is an error.
    pub fn load_or_default(path: &Path) -> Result<Self, AgentError> {
        match std::fs::read_to_string(path) {
            Ok(raw) => {
                let config: Config = serde_json::from_str(&raw).map_err(|e| {
                    AgentError::Config(format!("{} is not valid: {e}", path.display()))
                })?;
                config.validate()?;
                Ok(config)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), AgentError> {
        self.validate()?;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            harden_dir(parent)?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| AgentError::Config(format!("cannot serialise config: {e}")))?;

        // Write to a temp file and rename, so an interrupted save cannot leave
        // a half-written config behind.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json.as_bytes())?;
        harden_file(&tmp)?;
        std::fs::rename(&tmp, path)?;

        Ok(())
    }

    fn validate(&self) -> Result<(), AgentError> {
        if self.device_name.is_empty() || self.device_name.chars().count() > 64 {
            return Err(AgentError::Config(
                "deviceName must be 1..64 characters".into(),
            ));
        }
        if !self.receive_root.is_absolute() {
            return Err(AgentError::Config(
                "receiveRoot must be an absolute path".into(),
            ));
        }
        // The upper bound guards against a typo (80 -> 800) quietly removing
        // the resource cap this field exists to provide.
        if self.max_concurrent_sessions == 0 || self.max_concurrent_sessions > 256 {
            return Err(AgentError::Config(
                "maxConcurrentSessions must be 1..=256".into(),
            ));
        }
        if self.shell.program.is_empty() {
            return Err(AgentError::Config("shell.program is empty".into()));
        }
        Ok(())
    }

    /// Doc 7.3: the receive root must exist (or be creatable) and be writable by
    /// the current user. Checked at startup rather than at first transfer so the
    /// failure shows up in `status`, not halfway through a file.
    pub fn ensure_receive_root(&self) -> Result<(), AgentError> {
        std::fs::create_dir_all(&self.receive_root).map_err(|e| {
            AgentError::Config(format!(
                "receiveRoot {} cannot be created: {e}",
                self.receive_root.display()
            ))
        })?;

        let probe = self.receive_root.join(".termy-write-probe");
        std::fs::write(&probe, b"").map_err(|e| {
            AgentError::Config(format!(
                "receiveRoot {} is not writable: {e}",
                self.receive_root.display()
            ))
        })?;
        let _ = std::fs::remove_file(&probe);
        Ok(())
    }
}

/// Doc 7.3, renamed under v1.9 R-01: `%APPDATA%\LingXi1949` on Windows,
/// `$XDG_CONFIG_HOME/lingxi1949` (defaulting to `~/.config/lingxi1949`)
/// elsewhere. `migrate_legacy_config_dir` moves anything found at the
/// pre-rename location (see `legacy_config_dir`) here before this is ever
/// read.
pub fn config_dir() -> PathBuf {
    if cfg!(windows) {
        match std::env::var_os("APPDATA") {
            Some(appdata) => PathBuf::from(appdata).join("LingXi1949"),
            None => home_dir()
                .join("AppData")
                .join("Roaming")
                .join("LingXi1949"),
        }
    } else {
        match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            Some(base) => PathBuf::from(base).join("lingxi1949"),
            None => home_dir().join(".config").join("lingxi1949"),
        }
    }
}

/// The pre-v1.9 config directory (`termesh-agent`/`TermeshAgent`), kept only
/// as the source for the one-time migration in `migrate_legacy_config_dir` -
/// there is no long-term `termesh` compat alias (Q8).
fn legacy_config_dir() -> PathBuf {
    if cfg!(windows) {
        match std::env::var_os("APPDATA") {
            Some(appdata) => PathBuf::from(appdata).join("TermeshAgent"),
            None => home_dir()
                .join("AppData")
                .join("Roaming")
                .join("TermeshAgent"),
        }
    } else {
        match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            Some(base) => PathBuf::from(base).join("termesh-agent"),
            None => home_dir().join(".config").join("termesh-agent"),
        }
    }
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// v1.9 R-01-3: one-time, idempotent migration of the whole pre-rename config
/// directory - including the Ed25519 identity key `identity.json` - to the
/// new location, so an upgrading device keeps its identity and never needs
/// to re-pair. Must run before anything reads config or identity (design doc
/// §5.3): if the new directory already exists, this is a no-op (already
/// migrated, or a fresh v1.9 install); if neither directory exists, this is
/// also a no-op (fresh install, nothing to migrate).
///
/// The copy lands in a staging directory next to the destination and is
/// moved into place with one atomic rename, so a failure partway through
/// (permissions, disk full) can never leave a half-populated new directory
/// that a later run would mistake for "already migrated". On failure this
/// returns an error instead of falling back to silently generating a new
/// identity or silently continuing to use the old directory - doc §5.3's
/// explicit "no silent fallback" rule, because either fallback would look
/// like a successful upgrade while quietly discarding the device's identity.
pub fn migrate_legacy_config_dir() -> Result<(), AgentError> {
    migrate_config_dir(&legacy_config_dir(), &config_dir())
}

/// The testable core of `migrate_legacy_config_dir`, taking explicit paths so
/// it doesn't depend on the process environment (same convention as
/// `load_or_default` taking a path instead of calling `config_path()`).
fn migrate_config_dir(old_dir: &Path, new_dir: &Path) -> Result<(), AgentError> {
    if new_dir.exists() {
        return Ok(());
    }

    if !old_dir.exists() {
        return Ok(());
    }

    let staging_dir = new_dir.with_file_name(format!(
        "{}.migrating",
        new_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("lingxi1949")
    ));
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir).map_err(|e| {
            AgentError::Config(format!(
                "cannot clear leftover migration staging directory {}: {e}",
                staging_dir.display()
            ))
        })?;
    }

    copy_dir_recursive(old_dir, &staging_dir).map_err(|e| {
        AgentError::Config(format!(
            "failed to migrate {} to {}: {e}",
            old_dir.display(),
            staging_dir.display()
        ))
    })?;

    if let Some(parent) = new_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&staging_dir, new_dir).map_err(|e| {
        AgentError::Config(format!(
            "failed to finish migrating config to {}: {e}",
            new_dir.display()
        ))
    })?;

    // Renamed rather than deleted, so a botched migration still leaves a
    // manual rollback path (design doc §5.3): move the old dir back and
    // downgrade.
    let migrated_marker = old_dir.with_file_name(format!(
        "{}.migrated",
        old_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("termesh-agent")
    ));
    let _ = std::fs::rename(old_dir, &migrated_marker);

    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(unix)]
pub fn harden_dir(path: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(unix)]
pub fn harden_file(path: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// On Windows the file inherits the user profile's ACL, which is already
/// restricted to the current user; there is no chmod equivalent worth emulating.
#[cfg(not(unix))]
pub fn harden_dir(_path: &Path) -> Result<(), AgentError> {
    Ok(())
}

#[cfg(not(unix))]
pub fn harden_file(_path: &Path) -> Result<(), AgentError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: the agent shipped `/bin/bash` with no arguments, so the
    /// remote terminal ran a non-login shell. On Ubuntu `~/.local/bin` is added
    /// to PATH by `~/.profile`, which a non-login bash never reads - `claude`,
    /// pipx shims and cargo binaries were all "command not found" remotely
    /// while working over SSH. The local terminal server has always used a
    /// login shell; these must agree.
    #[test]
    #[cfg(not(windows))]
    fn the_default_unix_shell_is_a_login_shell() {
        let shell = Config::default_shell();
        assert_eq!(shell.program, "/bin/bash");
        assert_eq!(shell.args, vec!["-l".to_string()]);
    }

    #[test]
    #[cfg(windows)]
    fn powershell_takes_no_login_flag() {
        let shell = Config::default_shell();
        assert_eq!(shell.program, "powershell.exe");
        assert!(shell.args.is_empty());
    }

    fn sample(root: &Path) -> Config {
        Config {
            device_name: "build-server".into(),
            identity_key_path: root.join("identity.json"),
            receive_root: root.join("TermyReceive"),
            max_concurrent_sessions: 8,
            shell: Config::default_shell(),
        }
    }

    #[test]
    fn a_missing_config_file_yields_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load_or_default(&dir.path().join("absent.json")).unwrap();

        assert_eq!(config, Config::default());
        assert_eq!(config.max_concurrent_sessions, 8);
        assert!(
            !config.device_name.is_empty(),
            "hostname default must apply"
        );
        assert!(config.receive_root.is_absolute());
    }

    #[test]
    fn a_present_but_broken_config_is_an_error_not_a_silent_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, b"not json").unwrap();

        assert!(Config::load_or_default(&path).is_err());
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.json");
        let config = sample(dir.path());

        config.save(&path).unwrap();
        assert_eq!(Config::load_or_default(&path).unwrap(), config);
    }

    /// A V1 config file still has deviceId/deviceToken/relayUrl in it. Those
    /// keys are simply ignored on load - an upgrade must not brick the agent
    /// over fields that no longer exist.
    #[test]
    fn a_leftover_v1_config_loads_with_its_cloud_fields_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            format!(
                r#"{{
                    "deviceId": "3d594650-3436-4c7a-9a15-9b5c3f0f4a11",
                    "deviceToken": "secret",
                    "relayUrl": "wss://relay.example.com",
                    "deviceName": "upgraded-box",
                    "receiveRoot": {:?},
                    "shell": {{ "program": "/bin/bash", "args": ["-l"] }}
                }}"#,
                dir.path().join("TermyReceive")
            ),
        )
        .unwrap();

        let config = Config::load_or_default(&path).unwrap();
        assert_eq!(config.device_name, "upgraded-box");
        assert_eq!(config.max_concurrent_sessions, 8, "new field defaults in");
    }

    #[cfg(unix)]
    #[test]
    fn permissions_are_restricted() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent").join("config.json");
        sample(dir.path()).save(&path).unwrap();

        let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let dir_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(file_mode, 0o600);
        assert_eq!(dir_mode, 0o700);
    }

    #[test]
    fn rejects_a_relative_receive_root() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = sample(dir.path());
        config.receive_root = PathBuf::from("relative/dir");
        assert!(config.save(&dir.path().join("c.json")).is_err());
    }

    #[test]
    fn rejects_a_session_cap_of_zero_or_an_absurd_one() {
        let dir = tempfile::tempdir().unwrap();

        let mut zero = sample(dir.path());
        zero.max_concurrent_sessions = 0;
        assert!(zero.save(&dir.path().join("zero.json")).is_err());

        let mut absurd = sample(dir.path());
        absurd.max_concurrent_sessions = 800;
        assert!(absurd.save(&dir.path().join("absurd.json")).is_err());
    }

    #[test]
    fn receive_root_is_created_and_probed() {
        let dir = tempfile::tempdir().unwrap();
        let config = sample(dir.path());
        config.ensure_receive_root().unwrap();
        assert!(config.receive_root.is_dir());
        // The probe file must not be left behind.
        assert!(!config.receive_root.join(".termy-write-probe").exists());
    }

    #[test]
    fn a_partial_write_cannot_corrupt_an_existing_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        sample(dir.path()).save(&path).unwrap();

        let mut broken = sample(dir.path());
        broken.max_concurrent_sessions = 0;
        assert!(broken.save(&path).is_err());

        // The original survives because validation runs before any write.
        assert_eq!(
            Config::load_or_default(&path)
                .unwrap()
                .max_concurrent_sessions,
            8
        );
    }

    // v1.9 R-01-3: one-time config directory migration.

    #[test]
    fn a_fresh_install_with_neither_directory_migrates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let old_dir = dir.path().join("termesh-agent");
        let new_dir = dir.path().join("lingxi1949");

        migrate_config_dir(&old_dir, &new_dir).unwrap();

        assert!(!old_dir.exists());
        assert!(!new_dir.exists());
    }

    #[test]
    fn migration_copies_the_whole_old_directory_including_the_identity_key() {
        let dir = tempfile::tempdir().unwrap();
        let old_dir = dir.path().join("termesh-agent");
        let new_dir = dir.path().join("lingxi1949");

        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(old_dir.join("config.json"), b"{\"deviceName\":\"box\"}").unwrap();
        std::fs::write(old_dir.join("identity.json"), b"top-secret-key-material").unwrap();

        migrate_config_dir(&old_dir, &new_dir).unwrap();

        assert_eq!(
            std::fs::read_to_string(new_dir.join("identity.json")).unwrap(),
            "top-secret-key-material"
        );
        assert_eq!(
            std::fs::read_to_string(new_dir.join("config.json")).unwrap(),
            "{\"deviceName\":\"box\"}"
        );

        // The old directory is renamed aside, not left in place and not deleted.
        assert!(!old_dir.exists());
        assert!(dir.path().join("termesh-agent.migrated").exists());
    }

    #[test]
    fn migration_is_a_one_time_idempotent_step() {
        let dir = tempfile::tempdir().unwrap();
        let old_dir = dir.path().join("termesh-agent");
        let new_dir = dir.path().join("lingxi1949");

        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(old_dir.join("identity.json"), b"original-identity").unwrap();
        migrate_config_dir(&old_dir, &new_dir).unwrap();

        // Simulate the old directory somehow reappearing (e.g. a stale
        // backup restored) - since the new directory already exists, a
        // second run must leave it alone rather than overwriting it.
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(old_dir.join("identity.json"), b"a-different-identity").unwrap();
        migrate_config_dir(&old_dir, &new_dir).unwrap();

        assert_eq!(
            std::fs::read_to_string(new_dir.join("identity.json")).unwrap(),
            "original-identity"
        );
    }

    #[test]
    fn migration_preserves_nested_subdirectories() {
        let dir = tempfile::tempdir().unwrap();
        let old_dir = dir.path().join("termesh-agent");
        let new_dir = dir.path().join("lingxi1949");

        std::fs::create_dir_all(old_dir.join("nested")).unwrap();
        std::fs::write(old_dir.join("nested").join("file.txt"), b"hi").unwrap();

        migrate_config_dir(&old_dir, &new_dir).unwrap();

        assert_eq!(
            std::fs::read_to_string(new_dir.join("nested").join("file.txt")).unwrap(),
            "hi"
        );
    }

    #[test]
    fn a_new_directory_that_already_exists_is_never_touched_by_migration() {
        let dir = tempfile::tempdir().unwrap();
        let old_dir = dir.path().join("termesh-agent");
        let new_dir = dir.path().join("lingxi1949");

        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(old_dir.join("identity.json"), b"old").unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(new_dir.join("identity.json"), b"already-here").unwrap();

        migrate_config_dir(&old_dir, &new_dir).unwrap();

        // A v1.9 install with its own fresh identity must never be clobbered
        // by a leftover old directory.
        assert_eq!(
            std::fs::read_to_string(new_dir.join("identity.json")).unwrap(),
            "already-here"
        );
        assert!(
            old_dir.exists(),
            "the old directory is left alone, not renamed away"
        );
    }
}
