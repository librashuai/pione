# Pione

个人 Pi 扩展，提供 `/fresh-show-turn` 和按会话选择的两阶段 MCP（stdio / Streamable HTTP）。交互模式下使用紧凑的底部状态栏：不计算或显示费用，保留路径、token、上下文、模型及其他插件状态，并在统计行显示 `MCP:N`（当前活动分支已成功激活的服务数，含 direct / late；无服务时为 0）。`/fresh-show-turn` 把当前 session **活动分支**的最后一个用户回合（用户消息、助手文本、工具调用与工具结果）导出为 Markdown，在 [Fresh](https://github.com/sinelaw/fresh) 的顶部文件 pane 打开。思考内容和图片数据不导出。

## 安装（Windows PowerShell）

```powershell
pwsh -File .\install.ps1
```

脚本将 `extensions/pione` 复制到 `~/.pi/agent/extensions/pione`；设置了 `PI_CODING_AGENT_DIR` 时则使用该目录。已有同名插件目录会被覆盖。安装后在 Pi 中执行 `/reload` 或重启。

## MCP 配置和使用

在 `~/.pi/agent/pione-mcp.json`（或 `$PI_CODING_AGENT_DIR/pione-mcp.json`）配置服务：

```json
{
  "servers": {
    "local": { "command": "node", "args": ["/path/to/server.js"] },
    "remote_http": { "transport": "http", "url": "https://example.com/mcp" }
  },
  "defaultServers": []
}
```

省略 `transport` 表示 stdio；HTTP 使用 MCP **Streamable HTTP**（不支持旧 SSE），支持可选 `headers`（如 HTTPS 服务的 `Authorization`）。出于安全考虑明文 HTTP 只允许回环地址，远程连接必须使用 HTTPS；不能把带用户名密码的 URL 当作认证配置。`callTimeoutMs` 默认 60000，范围 10–600000 毫秒。stdio 命令不经 shell。服务端进程和远程 HTTP 服务都可能读取敏感数据，配置文件中的令牌、对话内容及浏览器页面不要随意分享。

配置文件仅在会话启动或 `/reload` 时读取；`defaultServers` 在**新会话**首轮前注册为原生 tools，可留空。用 `/mcp list` 查看状态，`/mcp on <server>` 为当前会话增加服务：首轮用户消息前直接注册原生 tools；首轮后在会话尾部插入一次带完整 JSON schema 的描述，通过固定的 `pione_mcp_call` 工具调用。**成功**压缩后，晚加入的工具才转成原生 tools，描述不再发送给模型。Pi 会先保存压缩快照、再将这些工具写作会话末尾的 system 变更；pione 通过 `context_with_system` **仅在后续模型请求中**把已升级的工具声明移到系统头部，而不改写会话记录或其他插件的 system 变更。失败或取消压缩不会升级。会话恢复和 `/tree` 切换按活动分支恢复，底部 `MCP:N` 随之更新；已从配置删除的服务不会被历史会话重新激活。服务端工具 schema 变化时需新建会话。工具调用顺序执行；超时后重置该连接，进程或远程会话内的状态可能丢失。晚加入的桥接调用不享有提供商侧原生工具 schema 校验，压缩后缓存也不保证保留。

### Chrome DevTools MCP（本机 stdio）

[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) 本身使用 stdio；它的 `--browser-url=http://...` 是 Chrome 调试接口（CDP），不是 HTTP MCP 地址。本配置让 pione 直接启动本地 MCP 进程，**无需 HTTP 代理或独立常驻服务**。Windows PowerShell 安装：

```powershell
npm install --prefix "$HOME/.pi/agent/bin/chrome-devtools-mcp" chrome-devtools-mcp@1.10.1
```

在 `pione-mcp.json` 的 `servers` 内添加 `chrome`（按实际安装路径调整）：

```json
"chrome": {
  "command": "C:/Apps/nodejs/node.exe",
  "args": [
    "C:/Users/<用户名>/.pi/agent/bin/chrome-devtools-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    "--headless", "--isolated", "--slim", "--no-usage-statistics", "--no-performance-crux",
    "--executable-path=C:/Program Files/Google/Chrome/Application/chrome.exe"
  ],
  "env": { "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1" },
  "callTimeoutMs": 90000
}
```

`--slim` 仅暴露导航、页面脚本和截图；`--isolated` 使用隔离的临时 Chrome 配置文件。浏览器工具可以读取页面和执行脚本，请勿在此浏览器中打开敏感账户。当前本机配置的 `defaultServers` 为空，需要时在 Pi 执行 `/reload`（或重启）及 `/mcp on chrome`。

真实链路测试（PowerShell）：

```powershell
$env:PIONE_CHROME_MCP_TEST = '1'
node --test test/chrome-stdio.test.mjs
```

测试经由 pione 的 `pione_mcp_call` 桥接工具和 stdio MCP，使用 Chrome 打开 `https://pi.dev/`，读取页面标题和正文。

## Fresh 使用

在带有 `FRESH_CMD_TOKEN` 和 `FRESH_SESSION` 环境变量的 Fresh 终端中启动 Pi，执行 `/fresh-show-turn`。缺少 token 时命令只提示功能不可用，不会导出文件；`fresh` 可执行文件也必须在 `PATH` 中。若顶部尚无文件 pane，则新建顶部 pane，并保持终端焦点。

每次导出生成独立的临时目录（`pione-turn-*`）和 `last-turn.md`，成功打开后保留文件以供 Fresh 显示；不需要时可自行清理。文件可能包含敏感对话或工具输出。

离线测试：先在 `extensions/pione` 运行 `npm ci`，再从仓库根目录运行 `node --test test/*.test.mjs`（Node.js 22.19+）；包含模拟 Pi 会话、stdio 与 Streamable HTTP 测试。真实 Chrome 网站测试须设置上文的 `PIONE_CHROME_MCP_TEST`，否则自动跳过。
