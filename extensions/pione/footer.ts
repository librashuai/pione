import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function shortPath(cwd: string): string {
	const home = homedir();
	const rest = relative(resolve(home), resolve(cwd));
	return rest === "" ? "~" : rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest) ? `~${sep}${rest}` : cwd;
}

function tokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : n < 1000000 ? `${Math.round(n / 1000)}k` : `${(n / 1000000).toFixed(1)}M`;
}

/** Replace the built-in footer without computing or showing session costs. */
export function setCompactFooter(ctx: ExtensionContext, activeServers: () => number): () => void {
	if (ctx.mode !== "tui") return () => {};
	let refresh = () => {};
	ctx.ui.setFooter((tui, theme, data) => {
		refresh = () => tui.requestRender();
		const unsubscribe = data.onBranchChange(refresh);
		return {
			invalidate() {},
			dispose() { unsubscribe(); refresh = () => {}; },
			render(width: number): string[] {
			const branch = data.getGitBranch();
			const name = ctx.sessionManager.getSessionName();
			const location = shortPath(ctx.sessionManager.getCwd()) + (branch ? ` (${branch})` : "") + (name ? ` • ${name}` : "");
			let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
			for (const entry of ctx.sessionManager.getEntries()) {
				const usage = entry.type === "usage" ? entry.usage : entry.type === "message" &&
					(entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage :
					(entry.type === "compaction" || entry.type === "branch_summary") ? entry.usage : undefined;
				if (!usage) continue;
				input += usage.input ?? 0;
				output += usage.output ?? 0;
				cacheRead += usage.cacheRead ?? 0;
				cacheWrite += usage.cacheWrite ?? 0;
			}
			const context = ctx.getContextUsage();
			const percent = context?.percent == null ? "?" : context.percent.toFixed(1) + "%";
			const window = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const parts = [
				`MCP:${activeServers()}`,
				...(input ? [`↑${tokens(input)}`] : []), ...(output ? [`↓${tokens(output)}`] : []),
				...(cacheRead ? [`R${tokens(cacheRead)}`] : []), ...(cacheWrite ? [`W${tokens(cacheWrite)}`] : []),
				`${percent}/${tokens(window)}`,
			];
			const left = theme.fg("dim", parts.join(" "));
			const model = ctx.model?.id ?? "no-model";
			const right = theme.fg("dim", ctx.model?.reasoning ? `${model} • ${ctx.thinkingLevel ?? "off"}` : model);
			const leftFit = truncateToWidth(left, Math.max(0, width), "…");
			const space = width - visibleWidth(leftFit) - visibleWidth(right);
			const stats = space >= 2 ? leftFit + " ".repeat(space) + right :
				leftFit + (width - visibleWidth(leftFit) >= 2 ? "  " + truncateToWidth(right, width - visibleWidth(leftFit) - 2, "") : "");
			const lines = [truncateToWidth(theme.fg("dim", location), width, "…"), stats];
			const statuses = [...data.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => text.replace(/[\r\n\t]/g, " ").trim());
			if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, "…"));
			return lines;
			},
		};
	});
	return () => refresh();
}
