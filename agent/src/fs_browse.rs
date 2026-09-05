//! Directory listing for the directory-tree panel's remote data source
//! (candidate doc "目录树与双向文件传输", phase 2A).
//!
//! Deliberately not path-confined: candidate doc §6.5 - a controller that
//! can already `cd`/`ls` anywhere the OS lets it via a terminal session
//! gains no real safety from a narrower tree, only an inconsistent UI
//! ("terminal can reach it, tree can't"). `paths.rs`'s validation is a
//! different problem (containing an inbound relative path under a fixed
//! receive root) and does not apply here - there is no root to escape.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::termstream::FsEntry;
use crate::transfer::{MAX_FILE_BYTES, MAX_TRANSFER_BYTES};

fn resolve_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn expand_tilde_path(path: &Path, home_dir: Option<&Path>) -> PathBuf {
    let raw = path.to_string_lossy();
    let Some(home_dir) = home_dir else {
        return path.to_path_buf();
    };

    if raw == "~" {
        return home_dir.to_path_buf();
    }

    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        let mut expanded = home_dir.to_path_buf();
        if !rest.is_empty() {
            expanded.push(rest);
        }
        return expanded;
    }

    path.to_path_buf()
}

pub(crate) fn expand_user_path(path: &Path) -> PathBuf {
    expand_tilde_path(path, resolve_home_dir().as_deref())
}

/// Lists the direct children of `path` (not recursive), directories
/// before files, each group alphabetical - same ordering `directoryTreeSource.ts`
/// applies on the local side, so the two data sources behave identically
/// from the panel's point of view.
pub fn list_directory(path: &Path) -> io::Result<Vec<FsEntry>> {
    let path = expand_user_path(path);

    let mut entries: Vec<FsEntry> = fs::read_dir(path)?
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let is_directory = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            FsEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_directory,
            }
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    Ok(entries)
}

/// One file `walk_for_pull` found, ready to be read and sent (candidate doc
/// phase 2B). `relative_path` is what the wire manifest and the vault write
/// on the other end use; `absolute_path` is only for this process's own
/// `fs::read`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullEntry {
    pub index: usize,
    pub relative_path: String,
    pub absolute_path: PathBuf,
    pub size: u64,
}

/// What `walk_for_pull` found: files ready to be streamed, and every
/// directory encountered along the way (v1.9 D-01) - including one with no
/// files in it, and including the root itself when the pulled path is a
/// directory. The receiving end creates every entry in `directories` before
/// writing `entries`, so an empty folder (or a folder containing only other
/// empty folders) still lands on the other side instead of vanishing once
/// its file list is empty.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PullWalkResult {
    pub entries: Vec<PullEntry>,
    pub directories: Vec<String>,
}

/// Collects everything a "copy to vault" pull needs to send for `path`: one
/// entry if it is a file, or every file and directory under it (recursively,
/// symlinks skipped rather than followed) if it is a directory - same shape
/// as the existing inbound `TransferSession` limits (`transfer::MAX_FILE_BYTES`
/// etc.), reused here so a pull cannot be used to exfiltrate an unbounded
/// amount of data any more than a push can be used to write one.
pub fn walk_for_pull(path: &Path) -> Result<PullWalkResult, String> {
    let path = expand_user_path(path);
    let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    let base_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    let mut entries = Vec::new();
    let mut directories = Vec::new();
    if metadata.is_dir() {
        // The pulled directory itself is recorded even when it turns out to
        // have no children at all - D-01-1: an empty folder must still be
        // representable, not just an empty folder found while recursing.
        directories.push(base_name.clone());
        walk_dir_for_pull(&path, &base_name, &mut entries, &mut directories)
            .map_err(|e| e.to_string())?;
    } else if metadata.is_file() {
        entries.push(PullEntry {
            index: 0,
            relative_path: base_name,
            absolute_path: path.to_path_buf(),
            size: metadata.len(),
        });
    } else {
        return Err(format!(
            "{} is neither a file nor a directory",
            path.display()
        ));
    }

    // D-01-1: "nothing to send" is now reserved for a path that resolved to
    // neither a file nor any directory at all - a directory pull always
    // yields at least its own entry in `directories`, so this branch is
    // effectively dead for that case and only guards the truly-nothing one.
    if entries.is_empty() && directories.is_empty() {
        return Err("nothing to send".into());
    }
    let mut total = 0u64;
    for entry in &entries {
        if entry.size > MAX_FILE_BYTES {
            return Err(format!(
                "{} is over the per-file limit",
                entry.relative_path
            ));
        }
        total = total.saturating_add(entry.size);
    }
    if total > MAX_TRANSFER_BYTES {
        return Err(format!("{total} bytes exceeds the transfer limit"));
    }

    Ok(PullWalkResult {
        entries,
        directories,
    })
}

fn walk_dir_for_pull(
    dir: &Path,
    prefix: &str,
    out: &mut Vec<PullEntry>,
    dirs: &mut Vec<String>,
) -> io::Result<()> {
    let mut children: Vec<_> = fs::read_dir(dir)?.filter_map(|entry| entry.ok()).collect();
    children.sort_by_key(|entry| entry.file_name());

    for entry in children {
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative_path = format!("{prefix}/{name}");
        let entry_path = entry.path();
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            dirs.push(relative_path.clone());
            walk_dir_for_pull(&entry_path, &relative_path, out, dirs)?;
        } else if file_type.is_file() {
            out.push(PullEntry {
                index: out.len(),
                relative_path,
                size: entry.metadata()?.len(),
                absolute_path: entry_path,
            });
        }
        // Symlinks are skipped rather than followed: this walk has no root
        // to confine a followed link's target to (see the module doc), so
        // silently following one could pull in an arbitrary, unbounded
        // amount of unrelated data.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_directories_before_files_alphabetically_within_each_group() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("b.txt"), "").unwrap();
        fs::write(dir.path().join("a.txt"), "").unwrap();
        fs::create_dir(dir.path().join("zeta")).unwrap();
        fs::create_dir(dir.path().join("alpha")).unwrap();

        let entries = list_directory(dir.path()).unwrap();
        assert_eq!(
            entries,
            vec![
                FsEntry {
                    name: "alpha".into(),
                    is_directory: true
                },
                FsEntry {
                    name: "zeta".into(),
                    is_directory: true
                },
                FsEntry {
                    name: "a.txt".into(),
                    is_directory: false
                },
                FsEntry {
                    name: "b.txt".into(),
                    is_directory: false
                },
            ]
        );
    }

    #[test]
    fn a_missing_directory_is_an_io_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert!(list_directory(&missing).is_err());
    }

    #[test]
    fn an_empty_directory_lists_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(list_directory(dir.path()).unwrap(), Vec::new());
    }

    #[test]
    fn walk_for_pull_of_a_single_file_is_one_entry_named_by_its_basename() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("demo.md");
        fs::write(&file_path, b"hello world").unwrap();

        let result = walk_for_pull(&file_path).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].relative_path, "demo.md");
        assert_eq!(result.entries[0].absolute_path, file_path);
        assert_eq!(result.entries[0].size, 11);
        assert_eq!(result.entries[0].index, 0);
        assert!(
            result.directories.is_empty(),
            "a lone file has no directories"
        );
    }

    #[test]
    fn walk_for_pull_of_a_directory_recurses_with_prefixed_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("readme.md"), b"root file").unwrap();
        fs::create_dir(root.join("assets")).unwrap();
        fs::write(root.join("assets/img.png"), b"\x89PNG").unwrap();

        let mut result = walk_for_pull(&root).unwrap();
        result
            .entries
            .sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].relative_path, "project/assets/img.png");
        assert_eq!(result.entries[0].size, 4);
        assert_eq!(result.entries[1].relative_path, "project/readme.md");
        assert_eq!(result.entries[1].size, 9);

        let indices: std::collections::HashSet<usize> =
            result.entries.iter().map(|e| e.index).collect();
        assert_eq!(
            indices,
            std::collections::HashSet::from([0, 1]),
            "indices must be unique"
        );

        // Both the pulled root itself and the "assets" subdirectory must be
        // reported, not just directories that turned out to be empty.
        assert_eq!(
            result.directories,
            vec!["project".to_string(), "project/assets".to_string()]
        );
    }

    #[test]
    fn walk_for_pull_of_a_missing_path_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert!(walk_for_pull(&missing).is_err());
    }

    /// D-01-1: an empty folder (or one containing only other empty folders)
    /// must succeed, not be rejected as "nothing to send" - the folder
    /// itself is representable via `directories` even with zero files.
    #[test]
    fn walk_for_pull_of_an_empty_directory_succeeds_as_a_bare_directory_entry() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty");
        fs::create_dir(&empty).unwrap();

        let result = walk_for_pull(&empty).unwrap();
        assert!(result.entries.is_empty());
        assert_eq!(result.directories, vec!["empty".to_string()]);
    }

    /// D-01-1: a folder that contains only (nested) empty subfolders and no
    /// files at all must also succeed and report every level.
    #[test]
    fn walk_for_pull_of_nested_empty_directories_reports_every_level() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("outer");
        fs::create_dir_all(root.join("inner")).unwrap();

        let result = walk_for_pull(&root).unwrap();
        assert!(result.entries.is_empty());
        assert_eq!(
            result.directories,
            vec!["outer".to_string(), "outer/inner".to_string()]
        );
    }

    #[test]
    fn expand_tilde_path_uses_the_home_directory_when_present() {
        let home = tempfile::tempdir().unwrap();
        let expanded = super::expand_tilde_path(Path::new("~/notes/demo.md"), Some(home.path()));
        assert_eq!(expanded, home.path().join("notes/demo.md"));
    }

    #[test]
    fn walk_for_pull_rejects_a_file_over_the_per_file_limit() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.bin");
        let file = fs::File::create(&big).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        let err = walk_for_pull(&big).unwrap_err();
        assert!(err.contains("per-file limit"), "got: {err}");
    }
}
