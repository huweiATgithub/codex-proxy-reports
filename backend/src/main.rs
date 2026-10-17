//! 独立插件进程入口，标准输出只承载 SDK 协议
use gateway_plugin_sdk::client::{PluginSession, SessionConfig};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("reports: {error}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let session = PluginSession::accept(
        tokio::io::stdin(),
        tokio::io::stdout(),
        SessionConfig::default(),
    )
    .await?;
    session.run(codex_proxy_reports::runtime::plugin()?).await?;
    Ok(())
}
