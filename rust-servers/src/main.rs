// Terminal Server Main Program
// Standalone terminal server that provides PTY functionality

mod server;
mod router;

// Feature modules
pub mod pty;

use server::{Server, ServerConfig};
use std::env;

const SERVER_VERSION: &str = match option_env!("TERMINAL_SERVER_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// Logging macro
macro_rules! log_info {
    ($($arg:tt)*) => {
        eprintln!("[INFO] {}", format!($($arg)*));
    };
}

macro_rules! log_debug {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("[DEBUG] {}", format!($($arg)*));
        }
    };
}

/// Parse command-line arguments
fn parse_args() -> u16 {
    let args: Vec<String> = env::args().collect();
    let mut port: u16 = 0;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-p" | "--port" => {
                if i + 1 < args.len() {
                    port = args[i + 1].parse().unwrap_or(0);
                    i += 1;
                }
            }
            arg if arg.starts_with("--port=") => {
                port = arg.trim_start_matches("--port=").parse().unwrap_or(0);
            }
            "-h" | "--help" => {
                eprintln!("Usage: termy-server [OPTIONS]");
                eprintln!("Options:");
                eprintln!("  -p, --port <PORT>         监听端口 (0 表示随机端口) [默认: 0]");
                eprintln!("  -h, --help                显示帮助信息");
                eprintln!("  -V, --version             显示版本信息");
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("{}", SERVER_VERSION);
                std::process::exit(0);
            }
            _ => {}
        }
        i += 1;
    }

    port
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().any(|arg| arg == "--fs-operation") {
        use std::io::Read;
        let mut body = String::new();
        std::io::stdin().take(65537).read_to_string(&mut body)?;
        if body.len() > 65536 { return Err("File operation request too large".into()); }
        let request: lingxi_fs_operations::Request = serde_json::from_str(&body)?;
        let extra = env::var_os("LINGXI_FILE_ROOT").map(std::path::PathBuf::from).into_iter().collect();
        let result = lingxi_fs_operations::Engine::for_user(extra).execute(request);
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    // Parse command-line arguments
    let port = parse_args();
    log_debug!("启动参数: port={}", port);

    // Create the server configuration
    let config = ServerConfig { port };

    // Create and start the server
    let server = Server::new(config);
    let port = server.start().await?;

    // Keep the main thread running
    log_info!("Terminal Server 已启动，监听端口: {}", port);

    // Wait for the Ctrl+C signal
    tokio::signal::ctrl_c().await?;
    log_info!("收到退出信号，正在关闭服务器...");

    Ok(())
}
