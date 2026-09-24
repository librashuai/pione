# Pione

个人 Pi 扩展，目前提供 `/fresh-show-turn`：把当前 session **活动分支**的最后一个用户回合（用户消息、助手文本、工具调用与工具结果）导出为 Markdown，在 [Fresh](https://github.com/sinelaw/fresh) 的顶部文件 pane 打开。思考内容和图片数据不导出。

## 安装（Windows PowerShell）

```powershell
pwsh -File .\install.ps1
```

脚本将 `extensions/pione` 复制到 `~/.pi/agent/extensions/pione`；设置了 `PI_CODING_AGENT_DIR` 时则使用该目录。已有同名插件目录会被覆盖。安装后在 Pi 中执行 `/reload` 或重启。

## 使用

在带有 `FRESH_CMD_TOKEN` 和 `FRESH_SESSION` 环境变量的 Fresh 终端中启动 Pi，执行 `/fresh-show-turn`。缺少 token 时命令只提示功能不可用，不会导出文件；`fresh` 可执行文件也必须在 `PATH` 中。若顶部尚无文件 pane，则新建顶部 pane，并保持终端焦点。

每次导出生成独立的临时目录（`pione-turn-*`）和 `last-turn.md`，成功打开后保留文件以供 Fresh 显示；不需要时可自行清理。文件可能包含敏感对话或工具输出。

测试：`node --test test/*.test.mjs`（Node.js 22.19+）。
