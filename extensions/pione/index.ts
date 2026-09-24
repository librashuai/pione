import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lastTurn, renderTurn } from "./turn.ts";

// Executed inside Fresh, not in Pi. Only the quoted absolute path is interpolated.
function openInTopPane(file: string): string {
	return `const file = ${JSON.stringify(file)};
const panes = editor.describeWorkspace().panes;
const top = panes.filter(p => p.kind !== "terminal").sort((a, b) => a.y - b.y || a.x - b.x)[0];
if (top) {
  if (!editor.openFileInSplit(top.splitId, file)) throw new Error("Cannot open file in pane");
  await editor.flush();
} else {
  await editor.splitWindow({ direction: "horizontal", place: "before", file, keepFocus: true });
}
return true;`;
}

function runFresh(script: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// No shell, so paths containing spaces/metacharacters are safe.
		const child = spawn("fresh", ["--cmd", "script", "run", "-"], {
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		let output = "";
		const timer = setTimeout(() => child.kill(), 15000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { output = (output + chunk).slice(-4096); });
		child.stderr.resume(); // Drain without retaining possibly sensitive output.
		child.stdin.on("error", () => {}); // The CLI may exit before consuming stdin.
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0 && output.trim() === "true") resolve();
			else reject(new Error("Fresh script failed or timed out"));
		});
		child.stdin.end(script);
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fresh-show-turn", {
		description: "Export the last turn of this Pi session to Markdown and show it in Fresh's top pane",
		handler: async (_args, ctx) => {
			if (!process.env.FRESH_CMD_TOKEN?.trim()) {
				ctx.ui.notify("缺少 Fresh token (FRESH_CMD_TOKEN)，fresh-show-turn 功能不可用。", "warning");
				return;
			}
			if (!process.env.FRESH_SESSION?.trim()) {
				ctx.ui.notify("缺少 FRESH_SESSION，请在 Fresh 内的终端运行 Pi。", "warning");
				return;
			}
			await ctx.waitForIdle();
			const turn = lastTurn(ctx.sessionManager.getBranch());
			if (!turn.length) {
				ctx.ui.notify("当前会话还没有可导出的用户回合。", "warning");
				return;
			}

			let directory: string | undefined;
			try {
				// Keep successful exports on disk: Fresh displays the file, not a disposable virtual buffer.
				directory = await mkdtemp(join(tmpdir(), "pione-turn-"));
				const file = join(directory, "last-turn.md");
				await writeFile(file, renderTurn(turn), "utf8");
				await runFresh(openInTopPane(file));
				ctx.ui.notify(`已在 Fresh 顶部打开：${file}`, "info");
			} catch {
				if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
				// Do not echo Fresh stderr: it may contain a token or private session data.
				ctx.ui.notify("无法在 Fresh 中打开会话，请确认 fresh 已安装、Fresh 会话可连接且 token 有效。", "error");
			}
		},
	});
}
