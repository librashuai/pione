import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Use the active branch, not the session file (which also contains abandoned branches). */
export function lastTurn(branch: SessionEntry[]): SessionEntry[] {
	const start = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
	return start < 0 ? [] : branch.slice(start);
}

function code(value: unknown): string {
	const text = JSON.stringify(value, null, 2) ?? String(value);
	const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length + 1)));
	return `${fence}json\n${text}\n${fence}`;
}

export function renderTurn(entries: SessionEntry[]): string {
	const lines = ["# Pi · Last turn", ""];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			lines.push("## User", "");
		} else if (message.role === "assistant") {
			lines.push("## Assistant", "");
		} else if (message.role === "toolResult") {
			lines.push(`## Tool result: ${message.toolName}`, "");
		} else {
			continue;
		}

		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") lines.push(block.text, "");
				if (block.type === "toolCall") lines.push(`### Tool call: ${block.name}`, "", code(block.arguments), "");
			}
		} else {
			const content = message.content;
			for (const block of typeof content === "string" ? [{ type: "text", text: content }] : content) {
				if (block.type === "text") lines.push(block.text, "");
				else if (block.type === "image") lines.push("[Image omitted]", "");
			}
			if (message.role === "toolResult" && message.isError) lines.push("**Tool error**", "");
		}
	}
	return lines.join("\n").trimEnd() + "\n";
}
