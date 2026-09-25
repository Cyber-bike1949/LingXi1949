//! Explicit user file operations, shared by the local helper and remote Agent.
use cap_std::{ambient_authority, fs::Dir};
use serde::{Deserialize, Serialize};
use std::{fs, io::{self, Write}, path::{Component, Path, PathBuf}};
use fs2::FileExt;
use cap_fs_ext::DirExt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Request {
    pub action: String,
    pub root: String,
    #[serde(default)] pub path: String,
    #[serde(default)] pub target: Option<String>,
    #[serde(default)] pub expected_identity: Option<String>,
    #[serde(default)] pub operation_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase")]
pub struct Response {
    pub status: String,
    #[serde(skip_serializing_if="Option::is_none")] pub code: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] pub identity: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] pub entry_type: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] pub new_path: Option<String>,
    pub mutation_version: u32,
}
impl Response {
    fn ok() -> Self { Self {status:"success".into(),code:None,identity:None,entry_type:None,new_path:None,mutation_version:1} }
    fn error(code:&str) -> Self { Self {status:if code=="UNKNOWN_RESULT" {"unknown"} else if code=="PARTIAL_DELETE" {"partial"} else {"failed"}.into(),code:Some(code.into()),..Self::ok()} }
}
fn code(error: &io::Error) -> &'static str {
    match error.kind() {io::ErrorKind::NotFound=>"NOT_FOUND",io::ErrorKind::PermissionDenied=>"PERMISSION_DENIED",io::ErrorKind::AlreadyExists=>"TARGET_EXISTS",io::ErrorKind::Unsupported=>"ATOMIC_MOVE_UNSUPPORTED",_=>{
        #[cfg(unix)] {if error.raw_os_error()==Some(libc::EXDEV){return "CROSS_DEVICE";}if error.raw_os_error()==Some(libc::ELOOP){return "OUTSIDE_ROOT";}if [Some(libc::EINVAL),Some(libc::ENOSYS),Some(libc::ENOTSUP)].contains(&error.raw_os_error()){return "ATOMIC_MOVE_UNSUPPORTED";}}
        "IO_ERROR"
    }}
}
fn relative(path:&str,allow_empty:bool)->Result<PathBuf,&'static str>{
    if path.contains('\0')||path.contains('\\')||path.contains(':'){return Err("OUTSIDE_ROOT");}
    let p=Path::new(path);if !allow_empty&&path.is_empty(){return Err("PROTECTED_PATH");}
    if p.components().any(|c| !matches!(c,Component::Normal(_))){return Err("OUTSIDE_ROOT");}Ok(p.to_owned())
}
fn identity(metadata:&cap_std::fs::Metadata)->String{
    #[cfg(any(unix,windows))] {
        use cap_fs_ext::MetadataExt;
        format!("{}:{}:{}",metadata.dev(),metadata.ino(),metadata.nlink())
    }
    #[cfg(not(any(unix,windows)))] {format!("{:?}",metadata.modified())}
}
fn open_parent(root:&Dir,path:&Path)->io::Result<(Dir,std::ffi::OsString)>{
    let name=path.file_name().ok_or_else(||io::Error::from(io::ErrorKind::InvalidInput))?.to_owned();
    let mut dir=root.try_clone()?;
    for part in path.parent().unwrap_or(Path::new("")).components(){
        let Component::Normal(name)=part else{return Err(io::Error::from(io::ErrorKind::PermissionDenied));};
        if dir.symlink_metadata(name)?.file_type().is_symlink(){return Err(io::Error::from(io::ErrorKind::PermissionDenied));}
        dir=dir.open_dir_nofollow(name)?;
    }
    Ok((dir,name))
}
fn open_target(root:&Dir,path:&Path)->io::Result<Dir>{
    if path.as_os_str().is_empty(){return root.try_clone();}
    let (parent,name)=open_parent(root,path)?;
    if parent.symlink_metadata(&name)?.file_type().is_symlink(){return Err(io::Error::from(io::ErrorKind::PermissionDenied));}
    parent.open_dir_nofollow(name)
}

pub struct Engine { pub allowed:Vec<PathBuf>, pub protected:Vec<PathBuf>, pub journal:PathBuf }
impl Engine {
    pub fn for_user(extra:Vec<PathBuf>)->Self{
        let home=std::env::var_os(if cfg!(windows){"USERPROFILE"}else{"HOME"}).map(PathBuf::from).unwrap_or_default();
        let journal=home.join(".lingxi-file-operations");
        let mut allowed=vec![home.clone()];allowed.extend(extra);
        Self{allowed,protected:vec![journal.clone(),home.join(".config/lingxi1949"),home.join(".config/termesh-agent"),home.join("AppData/Roaming/LingXi1949"),home.join(".local/bin/lingxi1949")],journal}
    }
    fn root(&self,request:&Request)->Result<(Dir,PathBuf),&'static str>{
        let input=Path::new(&request.root);
        if !input.is_absolute()||input.components().any(|c|matches!(c,Component::ParentDir)){return Err("OUTSIDE_ROOT");}
        let root=fs::canonicalize(input).map_err(|e|code(&e))?;
        if root.parent().is_none(){return Err("PROTECTED_PATH");}
        let allowed=self.allowed.iter().filter_map(|p|fs::canonicalize(p).ok()).any(|p|p.parent().is_some()&&root.starts_with(p));
        if !allowed{return Err("OUTSIDE_ROOT");}
        if self.protected.iter().any(|p|root.starts_with(p)){return Err("PROTECTED_PATH");}
        let dir=Dir::open_ambient_dir(&root,ambient_authority()).map_err(|e|code(&e))?;
        Ok((dir,root))
    }
    fn protected_path(&self,path:&Path)->bool{self.protected.iter().any(|p|path.starts_with(p)||p.starts_with(path))||self.allowed.iter().any(|p|p==path)}
    pub fn execute(&self,request:Request)->Response{
        let (root,root_path)=match self.root(&request){Ok(v)=>v,Err(c)=>return Response::error(c)};
        if request.action=="capabilities" {return Response::ok();}
        let path=match relative(&request.path,false){Ok(p)=>p,Err(c)=>return Response::error(c)};
        if self.protected_path(&root_path.join(&path)){return Response::error("PROTECTED_PATH");}
        if request.action=="inspect" {
            return match open_parent(&root,&path).and_then(|(p,n)|p.symlink_metadata(n)){
                Ok(m)=>Response{identity:Some(identity(&m)),entry_type:Some(if m.file_type().is_symlink(){"link"}else if m.is_dir(){"directory"}else{"file"}.into()),..Response::ok()},Err(e)=>Response::error(code(&e))};
        }
        if !["delete","move","status"].contains(&request.action.as_str()){return Response::error("INVALID_ACTION");}
        let Some(id)=request.operation_id.as_ref().filter(|s|uuid::Uuid::parse_str(s).is_ok()) else{return Response::error("INVALID_OPERATION_ID");};
        // The journal is private and cannot itself be modified through this API.
        if fs::symlink_metadata(&self.journal).is_ok_and(|m|m.file_type().is_symlink()){return Response::error("PROTECTED_PATH");}
        if fs::create_dir_all(&self.journal).is_err(){return Response::error("JOURNAL_UNAVAILABLE");}
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;if fs::set_permissions(&self.journal,fs::Permissions::from_mode(0o700)).is_err(){return Response::error("JOURNAL_UNAVAILABLE");}}
        let journal=match Dir::open_ambient_dir(&self.journal,ambient_authority()){Ok(d)=>d,Err(_)=>return Response::error("JOURNAL_UNAVAILABLE")};
        let lock=match journal.open_with("operations.lock",cap_std::fs::OpenOptions::new().read(true).write(true).create(true)){Ok(f)=>f.into_std(),Err(_)=>return Response::error("JOURNAL_UNAVAILABLE")};
        if lock.try_lock_exclusive().is_err(){return Response::error("BUSY");}
        let record=format!("{id}.json");
        if let Ok(data)=journal.read(&record){
            if let Ok((old,result))=serde_json::from_slice::<(Request,Response)>(&data){
                if request.action=="status" {return result;}
                return if old==request {result}else{Response::error("OPERATION_CONFLICT")};
            }
            return Response::error("UNKNOWN_RESULT");
        }
        if request.action=="status"{return Response::error("UNKNOWN_RESULT");}
        let save=|response:&Response|->io::Result<()>{let bytes=serde_json::to_vec(&(&request,response))?;let tmp=format!("{id}.tmp");let mut file=journal.create(&tmp)?;file.write_all(&bytes)?;file.sync_all()?;journal.rename(&tmp,&journal,&record)?;Ok(())};
        if save(&Response::error("UNKNOWN_RESULT")).is_err(){return Response::error("JOURNAL_UNAVAILABLE");}
        let result=self.mutate(&root,&root_path,&path,&request);
        if save(&result).is_err(){return Response::error("UNKNOWN_RESULT");}
        result
    }
    fn mutate(&self,root:&Dir,root_path:&Path,path:&Path,request:&Request)->Response{
        let (parent,name)=match open_parent(root,path){Ok(v)=>v,Err(e)=>return Response::error(code(&e))};
        let metadata=match parent.symlink_metadata(&name){Ok(m)=>m,Err(e)=>return Response::error(code(&e))};
        if request.expected_identity.as_deref()!=Some(identity(&metadata).as_str()){return Response::error("STALE_ENTRY");}
        if request.action=="delete"{
            let result=if metadata.is_dir()&&!metadata.file_type().is_symlink(){remove_tree(&parent,Path::new(&name),&metadata)}else{parent.remove_file(&name)};
            return match result {Ok(())=>Response::ok(),Err(e)=>Response::error(if metadata.is_dir(){"PARTIAL_DELETE"}else{code(&e)})};
        }
        let target=match relative(request.target.as_deref().unwrap_or(""),true){Ok(p)=>p,Err(c)=>return Response::error(c)};
        let dest_path=target.join(&name);
        if path==dest_path||metadata.is_dir()&&target.starts_with(path){return Response::error("INVALID_TARGET");}
        if self.protected_path(&root_path.join(&dest_path)){return Response::error("PROTECTED_PATH");}
        let dest=match open_target(root,&target){Ok(d)=>d,Err(e)=>return Response::error(code(&e))};
        match rename_no_replace(&parent,Path::new(&name),&dest,Path::new(&name)) {Ok(())=>Response{new_path:Some(root_path.join(dest_path).to_string_lossy().into()),..Response::ok()},Err(e)=>Response::error(code(&e))}
    }
}
fn remove_tree(parent:&Dir,name:&Path,expected:&cap_std::fs::Metadata)->io::Result<()> {
    let dir=parent.open_dir_nofollow(name)?;
    if identity(&dir.dir_metadata()?)!=identity(expected){return Err(io::Error::from(io::ErrorKind::PermissionDenied));}
    for entry in dir.entries()? {
        let entry=entry?;let name=entry.file_name();let m=dir.symlink_metadata(&name)?;
        #[cfg(unix)] {use cap_std::fs::MetadataExt;if m.dev()!=expected.dev(){return Err(io::Error::from(io::ErrorKind::PermissionDenied));}}
        if m.is_dir()&&!m.file_type().is_symlink(){remove_tree(&dir,Path::new(&name),&m)?;}else{dir.remove_file(&name)?;}
    }
    parent.remove_dir(name)
}
#[cfg(unix)]
fn rename_no_replace(from:&Dir,source:&Path,to:&Dir,target:&Path)->io::Result<()> {
    use std::os::{fd::AsRawFd,unix::ffi::OsStrExt};use std::ffi::CString;
    let source=CString::new(source.as_os_str().as_bytes())?;let target=CString::new(target.as_os_str().as_bytes())?;
    #[cfg(target_os="linux")]
    let result=unsafe{libc::renameat2(from.as_raw_fd(),source.as_ptr(),to.as_raw_fd(),target.as_ptr(),libc::RENAME_NOREPLACE)};
    #[cfg(target_os="macos")]
    let result=unsafe{libc::renameatx_np(from.as_raw_fd(),source.as_ptr(),to.as_raw_fd(),target.as_ptr(),libc::RENAME_EXCL)};
    #[cfg(not(any(target_os="linux",target_os="macos")))] let result=-1;
    if result==0{Ok(())}else{Err(io::Error::last_os_error())}
}
#[cfg(windows)]
fn rename_no_replace(from:&Dir,source:&Path,to:&Dir,target:&Path)->io::Result<()> {
    use cap_std::fs::OpenOptionsExt;
    use std::os::windows::{io::AsRawHandle,ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::*;
    let mut options=cap_std::fs::OpenOptions::new();
    options.access_mode(DELETE|FILE_READ_ATTRIBUTES).share_mode(FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS);
    let file=from.open_with(source,&options)?;
    let name:Vec<u16>=target.as_os_str().encode_wide().collect();
    let offset=std::mem::offset_of!(FILE_RENAME_INFO,FileName);let len=offset+name.len()*2;
    let mut buffer=vec![0u64;(len+7)/8];let info=buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists=0;
        (*info).RootDirectory=to.as_raw_handle();
        (*info).FileNameLength=(name.len()*2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(),(*info).FileName.as_mut_ptr(),name.len());
        if SetFileInformationByHandle(file.as_raw_handle(),FileRenameInfo,info.cast(),len as u32)==0{return Err(io::Error::last_os_error());}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn engine(root:&Path)->Engine{Engine{allowed:vec![root.to_owned()],protected:vec![root.join("protected")],journal:root.join("journal")}}
    fn req(root:&Path,action:&str,path:&str)->Request{Request{action:action.into(),root:root.to_string_lossy().into(),path:path.into(),target:None,expected_identity:None,operation_id:None}}
    fn mutation(e:&Engine,root:&Path,action:&str,path:&str)->Request{let mut r=req(root,action,path);r.expected_identity=e.execute(req(root,"inspect",path)).identity;r.operation_id=Some(uuid::Uuid::new_v4().to_string());r}
    #[test] fn move_does_not_replace_and_retries_return_receipt(){
        let tmp=tempfile::tempdir().unwrap();let root=tmp.path();let e=engine(root);
        fs::write(root.join("source.txt"),"source").unwrap();fs::create_dir(root.join("folder")).unwrap();fs::write(root.join("folder/source.txt"),"target").unwrap();
        let mut r=mutation(&e,root,"move","source.txt");r.target=Some("folder".into());assert_eq!(e.execute(r.clone()).code.as_deref(),Some("TARGET_EXISTS"));
        assert_eq!(fs::read_to_string(root.join("source.txt")).unwrap(),"source");assert_eq!(fs::read_to_string(root.join("folder/source.txt")).unwrap(),"target");
        fs::remove_file(root.join("folder/source.txt")).unwrap();
        assert_eq!(e.execute(r.clone()).code.as_deref(),Some("TARGET_EXISTS"));
        r.operation_id=Some(uuid::Uuid::new_v4().to_string());let result=e.execute(r.clone());assert_eq!(result.status,"success");assert_eq!(e.execute(r),result);
    }
    #[test] fn stale_identity_and_protected_paths_are_rejected(){
        let tmp=tempfile::tempdir().unwrap();let root=tmp.path();let e=engine(root);fs::write(root.join("file"),"first").unwrap();
        let r=mutation(&e,root,"delete","file");fs::rename(root.join("file"),root.join("old")).unwrap();fs::write(root.join("file"),"replacement").unwrap();
        assert_eq!(e.execute(r).code.as_deref(),Some("STALE_ENTRY"));assert!(root.join("file").exists());
        assert_eq!(e.execute(req(root,"inspect","../escape")).code.as_deref(),Some("OUTSIDE_ROOT"));
        assert_eq!(e.execute(req(root,"delete","")).code.as_deref(),Some("PROTECTED_PATH"));
        fs::create_dir(root.join("protected")).unwrap();assert_eq!(e.execute(req(root,"inspect","protected")).code.as_deref(),Some("PROTECTED_PATH"));
    }
    #[cfg(unix)]
    #[test] fn recursive_delete_does_not_follow_links(){
        use std::os::unix::fs::symlink;
        let tmp=tempfile::tempdir().unwrap();let outside=tempfile::tempdir().unwrap();let root=tmp.path();let e=engine(root);
        fs::write(outside.path().join("keep"),"safe").unwrap();fs::create_dir(root.join("folder")).unwrap();symlink(outside.path(),root.join("folder/link")).unwrap();
        let result=e.execute(mutation(&e,root,"delete","folder"));assert_eq!(result.status,"success");assert!(outside.path().join("keep").exists());
        symlink(outside.path(),root.join("escape")).unwrap();assert_ne!(e.execute(req(root,"inspect","escape/keep")).status,"success");
    }
    #[test] fn rejects_descendant_move(){
        let tmp=tempfile::tempdir().unwrap();let root=tmp.path();let e=engine(root);fs::create_dir_all(root.join("folder/child")).unwrap();let mut r=mutation(&e,root,"move","folder");r.target=Some("folder/child".into());assert_eq!(e.execute(r).code.as_deref(),Some("INVALID_TARGET"));
    }
}
