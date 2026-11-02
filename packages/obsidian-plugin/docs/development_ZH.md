# 开发指南

想参与贡献 LingXi1949 的人从这一份文档看起就够了：各部分是什么、怎么构建和测试、提交前要遵守哪些规则。（English version: [development.md](development.md)。）

## 1. 总览

LingXi1949 是一个给 Obsidian 内嵌真实终端的插件，还带一个可选的远程终端功能：Windows/桌面版 Obsidian 作为控制端，通过 `iroh`（QUIC）与目标设备（Windows 或无桌面 Ubuntu）上的 `lingxi1949` 直连，不需要账号，也不需要自建服务端。

| 目录 | 内容 |
| --- | --- |
| `src/` | TypeScript 插件本体。`src/services/` 放运行时/集成逻辑（`terminal/`、`server/`、`codexCli/`、`context/`、`remote/`），`src/ui/` 放视图和弹窗，`src/settings/` 放设置模型与渲染器，`src/i18n/` 放多语言，`src/utils/` 放共享工具函数。 |
| `agent/` | Rust 编写的远程终端 Agent（`lingxi1949`）：设备身份、`iroh` Endpoint、连接码配对、多会话 PTY 服务。 |
| `rust-servers/` | 插件通过本地 WebSocket 连接的本机 PTY 后端。 |
| `crates/fs-operations/` | 本机后端和远程 Agent 共用的文件操作实现。 |
| `relay/`、`protocol/` | V1（账号 + 云端 Relay）遗留实现——见[第 7 节](#7-v1-遗留代码)。 |
| `docs/` | 本文档及其引用的截图/素材。 |
| `scripts/` | 构建、打包、发布相关的 Node 脚本。 |
| `e2e/` | 端到端驱动脚本，用真实回环 Agent + 真实 `@number0/iroh` binding 跑一遍。 |

构建产物（仓库根目录的 `main.js`、`styles.css`，以及 `binaries/`）由构建过程生成，不作为源码提交。

## 2. 前置条件

- **Rust 1.97.1**——版本由 `rust-toolchain.toml` 锁定，`rustup` 会自动选择，不要手动使用别的版本。
- **Node.js 22 或 24**——CI 使用 22，本轮构建、lint 和反馈测试也已在 24 上验证；测试命令使用 `--experimental-strip-types`。
- **pnpm**——版本见 `package.json` 的 `packageManager` 字段。
- **要在 Windows 上构建 Agent 的贡献者**：必须在 Windows 本机构建，见[第 3.3 节](#33-rust-agentlingxi1949)。

## 3. 构建

### 3.1 首次搭建

```bash
pnpm install
pnpm build                # tsc --noEmit + esbuild + 打包体积自检 -> main.js
```

需要对着真实 vault 迭代开发时：

```bash
pnpm install:dev <vault-path>   # 构建两层并装进该 vault
pnpm dev                        # esbuild watch 模式
```

只改了 TypeScript、没碰原生 PTY 服务端时，给 `install:dev` 加 `--no-rust` 可以跳过那部分重新构建。

### 3.2 插件打包

```bash
pnpm package        # 组装出可分发的 plugin-package/ 目录
pnpm package:zip     # 打成 lingxi1949-<version>.zip
```

`pnpm package` 产出 `main.js` + `manifest.json` + `styles.css` + `node_modules/@number0/`（远程终端功能依赖的原生模块，见下）。打包后确认没有遗漏符号链接：

```bash
find plugin-package/node_modules -type l   # 应该没有任何输出
```

**`@number0/iroh` 原生模块**：这是远程终端功能依赖的 N-API 模块。`esbuild.config.mjs` 把它标为 `external`，因为安装好的 Obsidian 插件目录本身没有 `node_modules`。分发路径有两条：社区市场/BRAT 安装的插件会在首次使用远程设备时，从 unpkg、jsDelivr 或 GitHub Release 下载对应平台的固定版本 `.node` 文件，并用内置的 SHA-256 校验；离线完整包则直接携带这个模块。`scripts/package-plugin.js` 的第 5b 步会通过 `require.resolve()`（而不是硬编码的平台映射表——pnpm 的隔离 store 会把这些包安装成 `node_modules/.pnpm/` 下的符号链接，平台矩阵本身也会变）找出当前平台真正装上的那个原生包，解引用后拷进 `plugin-package/node_modules/@number0/`。两条分发路径都要求在目标操作系统和架构上构建——`pnpm install` 只会拉当前平台对应的原生包。

### 3.3 Rust Agent（`lingxi1949`）

**Linux：**

在仓库根目录编译后，以普通用户运行本地产物：

```bash
cargo build --manifest-path agent/Cargo.toml --release
./agent/target/release/lingxi1949 run
```

保持进程运行，将输出的连接码粘贴到插件“添加设备”。本地 PTY 后端另用 `pnpm build:rust` 构建。

`agent/packaging/install-linux.sh` 用于安装固定 Release，不接收本地二进制路径。它通过 root/sudo 为 `--user NAME` 指定的普通账户安装（默认 `monkey`），按需创建账户、启用 linger 并启动 systemd 用户服务；Agent 本身不以 root 运行。当前固定版本为 `2.1.0`，安装前需先发布该版本的二进制和 SHA-256 文件。脚本必须先下载到文件，具体用法见 [README](../README_ZH.md#连接远程-linux-agent)。

**Windows：只能在 Windows 本机构建。** 这不是图省事的问题，是几条硬阻塞：

1. `agent/Cargo.toml` 的 `[target.'cfg(windows)'.dependencies]` 依赖 `windows-sys`——进程树终止（Job Object）和存活检测（`OpenProcess`/`GetExitCodeProcess`）都是 Windows 专属实现；
2. `portable-pty` 在 Windows 上走 ConPTY，链接 Windows 系统库；
3. `x86_64-pc-windows-msvc` 需要 MSVC 链接器，Linux 上没有。

```powershell
rustup toolchain install 1.97.1
cargo build --manifest-path agent\Cargo.toml --release
# 产物：agent\target\release\lingxi1949.exe
```

`rustup toolchain install 1.97.1` 用于提前下载并安装本项目锁定的 Rust 编译器与 Cargo 工具链；随后在仓库目录执行 `cargo` 时，`rustup` 会根据 `rust-toolchain.toml` 自动选择该版本。这个命令只安装开发工具链，不会编译或安装 LingXi1949。

Windows 侧目前没有开机自启的安装脚本，用任务计划程序或注册为服务；要保持运行的命令是 `lingxi1949.exe run`。

### 3.4 2.1 功能与反馈网站

- `src/services/terminal/builtinShortcutGroups.ts` 组合内置安装快捷组；平台和 Shell 对应命令在执行前预览。
- `src/ui/terminal/directoryTreePanel.ts` 和 `src/services/terminal/fileOperations.ts` 处理目录树删除、移动及操作结果；`crates/fs-operations/` 提供后端实现。写操作受能力探测控制，旧后端不支持时不可用。修改后需同步验证 Agent 和本机后端，检查删除确认、移动后刷新及远程 `~` 路径。
- `src/services/feedbackLink.ts` 定义反馈网址并只允许 `pluginVersion`、`lang`、`os` 查询参数；`src/ui/home/deviceHomeView.ts` 在用户点击后通过浏览器打开页面。`os` 是本机的 Node 平台标识，如 `win32`、`darwin`、`linux`。

反馈网站位于独立的 [statics 仓库](https://github.com/Cyber-bike1949/statics)，单独构建部署，不随插件打包。表单从 URL 读取版本和系统并随内容提交，中英文由 `lang` 优先选择、否则跟随浏览器；无需标题、确认框或隐私说明链接。后台列表标题由内容生成。插件不在后台提交反馈、上传笔记或发送遥测。

网站维护时，`SITE_ORIGIN` 必须与浏览器访问地址的协议、主机和端口一致；否则有效 Cookie 和 CSRF token 仍会触发 `CSRF_INVALID`。当前反馈入口是 `http://cyber-bike.duckdns.org:3000/feedback`，对应来源是 `http://cyber-bike.duckdns.org:3000`。HTTP 页面生成 UUID 时需保留 `crypto.getRandomValues()` 兼容处理，不能只调用 `crypto.randomUUID()`。网站代码和检查命令见其 README。

### 3.5 快捷组输出匹配

`ShortcutStep.outputMatch?: string` 保存去除首尾空白后的字面量，属于组内步骤配置，不写回 `OperationRecord`。配置非空值时，`src/main.ts` 中的 `observeShortcutStepCompletion` 最多等待 15 秒：输出命中即完成，超时按状态未知暂停；此分支不会额外等待成功的 `command_end`。未配置匹配条件时，有 Shell 事件则以事件判断完成；交互式启动及没有 Shell 事件的终端使用定时回退逻辑。

`TerminalInstance.waitForOutputMatch` 合并输出游标之后的数据块并规范化终端输出。回放控制器目前只接受 Shell 步骤，交互式 CLI 启动只允许放在最后一步。完成状态未知时暂停，不自动重发；用户可继续等待、手动确认或停止。实现和测试见 `shortcutReplayController.ts`、`terminalInstance.ts` 及其测试文件。

## 4. 测试

```bash
cargo test --manifest-path agent/Cargo.toml     # Rust 单测 + 真实回环 QUIC 集成测试
pnpm test:remote                                # 插件端远程模块，Node 22/24
pnpm test:terminal                              # 本地终端层回归测试
cargo test --manifest-path rust-servers/Cargo.toml
cargo test --manifest-path crates/fs-operations/Cargo.toml
pnpm test:scripts
node --experimental-strip-types --test src/services/feedbackLink.test.ts
pnpm lint                                       # 通用 ESLint 配置，可选、起补充作用
```

**`pnpm lint:obsidian` 是强制项，不是可选项**——只要改动涉及 `src/**/*.ts`，就要跑这个命令，修完所有违规、跑到干净为止，才算改完。它用的是 `eslint.obsidian.config.js`，比通用配置多强制了几条规则：`@microsoft/sdl/no-inner-html`、`@typescript-eslint/no-base-to-string`、`@typescript-eslint/no-redundant-type-constituents`、`@typescript-eslint/no-unnecessary-type-assertion`、`@typescript-eslint/require-await`、`obsidianmd/ui/sentence-case-locale-module`。它会忽略 `src/**/*.test.ts`、`scripts/`、`rust-servers/`、`binaries/`、`plugin-package/`、`main.js`、`styles.css`——改动完全落在这些路径内时可以跳过，否则就要跑。

Rust 侧 CI 门槛：

```bash
cargo fmt --manifest-path agent/Cargo.toml --check
cargo clippy --manifest-path agent/Cargo.toml --all-targets -- -D warnings
```

端到端（真实回环 Agent + 真实 `@number0/iroh` binding，验证真实 shell 回显与 resize；**不覆盖文件传输**）：

```bash
pnpm install
cargo build --manifest-path agent/Cargo.toml
./e2e-run.sh
```

Node 18 不适用于当前完整工具链；请切换到 Node 24 后执行检查。

## 5. 代码风格

- TypeScript 用 2 空格缩进，Rust 用 4 空格。
- TypeScript 偏 `strict`：保持单引号、分号，能提升可读性的地方写明确类型。
- 类和 UI 类型用 `PascalCase`，函数和变量用 `camelCase`，文件名用有描述性的小驼峰（如 `terminalPathUtils.ts`、`settingsTab.ts`）。
- 代码注释一律用英文，不管你改的是哪个语言的 locale 文件。

## 6. Obsidian 开发者政策——不可触碰的红线

以下条目直接来自 [Obsidian 官方开发者政策](https://docs.obsidian.md/Developer+policies#Not+allowed)，违反任何一条都会导致插件被社区列表拒绝，已上架的会被下架。拿不准时就问自己一句："一个理性的人会不会把这个描述成下面某一条？"——会的话就不要做。

- **不能混淆代码来隐藏其用途。** `main.js` 用 esbuild 的 `minify: true` 压缩体积是允许的，因为 GitHub 上的可读 TypeScript 源码才是上游真相——不要在此之上再加编码字符串、运行时解码的函数体、不透明打包器或基于 eval 的加载器。
- **不能插入广告**，无论动态还是静态，除非它出现在 LingXi1949 自己的界面里（设置页、自己的弹窗/视图），且确实与 LingXi1949 本身相关。
- **不能包含客户端遥测。** 不允许分析 SDK、使用情况上报、错误上报端点，或任何"首次运行打个招呼"式的行为。允许的出站网络调用只有：从 GitHub Release 下载对应版本的 `termy-server` 二进制；下载固定版本、对应平台的 iroh 原生运行时（unpkg/jsDelivr/GitHub Release，SHA-256 校验，离线模式下禁用）；到 PTY 后端和 Claude Code IDE bridge 的纯本地 WebSocket 连接；以及默认关闭的 AI 启动器更新检查（同样受离线模式抑制）。这个开关必须保持默认关闭。
- **不能包含插件自更新机制。** 只有 Obsidian 自己的插件更新器能替换 `main.js`/`styles.css`/`manifest.json`。唯一允许的例外是把匹配的原生 `termy-server` 二进制下载到 `<plugin>/binaries/`——它是单独版本化的原生资源，经 SHA-256 校验，受离线模式禁用控制，且绝不会覆盖插件的 JS/CSS/JSON 文件。
- **不能加载网络资源。** 所有字体、图片、图标都要通过 esbuild 的 `loader` 表或 `assets/` 打进包里，样式表里不要出现 `https://...` 的引用。

## 7. V1 遗留代码

`relay/`（云端 Relay 服务端）和 `protocol/`（三端协议契约生成器）是 V1（账号 + 云端 Relay）的实现。当前 Agent 已经不再连接任何 Relay——相关客户端代码已经删除——但插件侧仍有一部分 V1 模块（`relayClient.ts`、`remoteService.ts`、`authClient.ts`、`deviceClient.ts` 等）在被实际使用，并且依赖 `protocol/generated/` 生成的类型。**不要在没有单独、明确的移除任务的前提下删除或大改它们**——它们支撑的功能仍在正常使用。这两个目录仍可独立编译测试，CI 也一直在跑，防止它们不知不觉烂掉：

```bash
cd protocol && npm ci && npm test
cargo test --manifest-path relay/Cargo.toml
```

除非你确实要改这部分代码，否则不需要构建或重新生成它们。

## 8. 测试用例的隐私要求

不要在测试、快照、文档或示例数据里提交真实的个人信息——本地用户名、绝对的用户主目录路径、云存储路径、Vault 名称、私人笔记/课程/考试相关的文件夹名，或任何看起来像凭据、API key 的东西。改用中性的示例代替，比如 `/Users/example/Documents/Notes/Example.md`、`F:\example-vault\notes\demo`、`notes/路径示例.md`、`archive/12345/`。提交带路径或笔记名的测试改动前，扫一遍改动过的文件，确认没有不小心带进去的私人字符串。

## 9. 提交与 PR

- 提交信息开头要是 Conventional Commit 的类型之一：`feat:`、`fix:`、`chore:`、`docs:`、`refactor:`、`test:`、`build:`、`ci:`、`perf:`、`style:`、`revert:`；能让意思更清楚时鼓励加 scope（如 `feat(terminal):`、`fix(settings):`）；前面加个 emoji 也可以，只要必需的类型前缀还在。
- 提交信息保持简短、祈使句、说清楚具体改了什么。
- PR 要说明用户可见的影响、本地做过哪些验证、关联相关 issue；涉及 UI 的改动要附截图或短录屏。
- 只要涉及打包、发布说明或带版本号的行为变化，就要更新 `CHANGELOG.md`，让发布自动化能把改动映射到正确的版本段落。

## 10. 想找更早的设计历史？

原来放在 `docs/需求/` 和 `docs/开发/` 下的早期草案、分阶段实现方案，以及一次性的交接/验收清单，现在已经把仍然有用的部分并进了这份文档，其余随着代码落地已经过时的部分不再保留。需要那个细节层级时，`git log -- docs/` 里还在。
