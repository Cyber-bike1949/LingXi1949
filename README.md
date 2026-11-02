# LingXi Monorepo

5.0 起采用单仓库多子包：

- `packages/obsidian-plugin`：Obsidian 插件。发布时必须生成可直接安装的 `main.js`、`manifest.json`、`styles.css`，并按平台附带原生 PTY 和 Iroh 运行库。
- `packages/remote`：Agent、主控 CLI、MCP 和远程产品发布包。
- `packages/core`：内部共享协议、身份、配对和文件操作库，不单独面向用户发布。

产品仍分别构建、测试和发布；共享代码在同一提交中变更。
