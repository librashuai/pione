import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { connectServer, loadConfig, type Connection, type McpConfig, type RemoteTool } from "./mcp-client.ts";
import { setCompactFooter } from "./footer.ts";

type Stage = "late" | "direct";
type Selection = { server: string; stage: Stage; fingerprint: string };
const ENTRY = "pione:mcp-selection";
const MESSAGE = "pione:mcp-tools";
const BRIDGE = "pione_mcp_call";
const PREFIX = "pione_mcp_";

function toolName(server: string, remote: string): string {
	if (!remote.trim()) throw new Error("MCP tool name must not be empty");
	return `${PREFIX}${server}_${remote.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

/** Extract only the current branch; later entries override previous selection stages. */
export function selections(branch: SessionEntry[]): Map<string, Selection> {
	const selected = new Map<string, Selection>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const value = entry.data as Selection | undefined;
		if (value && typeof value.server === "string" && (value.stage === "late" || value.stage === "direct") &&
			typeof value.fingerprint === "string") selected.set(value.server, value);
	}
	return selected;
}

function resultContent(result: unknown) {
	const value = result as { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
	if (value?.isError) throw new Error(JSON.stringify(value.content ?? []).slice(0, 4000));
	const blocks = value?.content ?? [];
	const content = blocks.slice(0, 10).map(block => block.type === "text" && typeof block.text === "string"
		? { type: "text" as const, text: block.text.length > 20000 ? `${block.text.slice(0, 20000)}\n[truncated]` : block.text }
		: block.type === "image" && block.data && block.mimeType
			? { type: "image" as const, data: block.data, mimeType: block.mimeType }
			: { type: "text" as const, text: JSON.stringify(block).slice(0, 4000) });
	if (blocks.length > 10) content.push({ type: "text", text: `[${blocks.length - 10} further MCP content blocks omitted]` });
	return content;
}

/** Injectable connector/config for offline simulations. */
export function registerMcp(pi: ExtensionAPI, options: {
	config?: () => Promise<McpConfig>;
	connect?: typeof connectServer;
} = {}) {
	const config = options.config ?? (() => loadConfig(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")));
	const connect = options.connect ?? connectServer;
	let settings: McpConfig = { servers: {} };
	let selected = new Map<string, Stage>();
	const connections = new Map<string, Connection>();
	const opening = new Map<string, Promise<Connection>>();
	const expectedSnapshots = new Map<string, string>();
	const registered = new Set<string>();
	const owners = new Map<string, string>();
	const toolSnapshots = new Map<string, string>();
	let refreshFooter = () => {};

	async function closeAll() {
		const old = [...connections.values()];
		connections.clear();
		expectedSnapshots.clear();
		await Promise.all(old.map(c => c.close().catch(() => {})));
	}
	function activate() {
		const active = pi.getActiveTools().filter(name => !registered.has(name));
		if (!active.includes(BRIDGE)) active.push(BRIDGE);
		for (const [server, stage] of selected) {
			if (stage !== "direct" || !connections.has(server)) continue;
			for (const tool of connections.get(server)!.tools) active.push(toolName(server, tool.name));
		}
		if (active.join("\0") !== pi.getActiveTools().join("\0")) pi.setActiveTools(active);
		refreshFooter();
	}
	function registerDirect(server: string, conn: Connection) {
		for (const remote of conn.tools) {
			const name = toolName(server, remote.name);
			if (registered.has(name)) continue;
			pi.registerTool({
				name, label: `${server}: ${remote.name}`,
				description: remote.description || `MCP ${server}/${remote.name}`,
				parameters: Type.Unsafe<Record<string, unknown>>(remote.inputSchema),
				executionMode: "sequential", // All MCP tools can share a single mutable server state.
				async execute(_id, args, signal) {
					if (selected.get(server) !== "direct") throw new Error("MCP tool is not active on this branch");
					const current = await open(server);
					return { content: resultContent(await current.call(remote.name, args, signal)), details: undefined };
				},
			});
			registered.add(name);
			owners.set(name, server);
			toolSnapshots.set(name, JSON.stringify(remote));
		}
	}
	async function open(server: string): Promise<Connection> {
		const current = connections.get(server);
		if (current?.isHealthy()) return current;
		if (opening.has(server)) return opening.get(server)!;
		const promise = (async () => {
			if (current) {
				connections.delete(server);
				await current.close().catch(() => {});
			}
			const spec = settings.servers[server];
			if (!spec) throw new Error(`Unknown MCP server: ${server}`);
			const conn = await connect(spec);
			try {
				const names = conn.tools.map(t => toolName(server, t.name));
				const existing = new Set([...connections].flatMap(([s, c]) => c.tools.map(t => toolName(s, t.name))));
				if ((expectedSnapshots.has(server) && expectedSnapshots.get(server) !== JSON.stringify(conn.tools)) ||
					new Set(names).size !== names.length || conn.tools.some((tool, index) => {
						const name = names[index];
						return existing.has(name) || (owners.has(name) && owners.get(name) !== server) ||
							(toolSnapshots.has(name) && toolSnapshots.get(name) !== JSON.stringify(tool)) ||
							pi.getAllTools().some(t => t.name === name && !registered.has(name));
					})) throw new Error(`MCP tool schemas changed or names collided: ${server}; start a new session`);
				connections.set(server, conn);
				return conn;
			} catch (error) {
				await conn.close().catch(() => {});
				throw error;
			}
		})();
		opening.set(server, promise);
		try { return await promise; } finally { opening.delete(server); }
	}
	function describe(server: string, conn: Connection): string {
		return `MCP server ${server} is available via ${BRIDGE}. Call it with {"tool":"<name>","arguments":{...}}. ` +
			`Allowed tools and exact JSON input schemas:\n${conn.tools.map(t => `${toolName(server, t.name)}: ${t.description ?? ""}\n${JSON.stringify(t.inputSchema)}`).join("\n")}`;
	}
	async function enable(server: string, stage: Stage) {
		if (selected.has(server)) return false;
		const conn = await open(server);
		if (stage === "direct") registerDirect(server, conn);
		selected.set(server, stage);
		expectedSnapshots.set(server, JSON.stringify(conn.tools));
		pi.appendEntry(ENTRY, { server, stage, fingerprint: JSON.stringify(conn.tools) } satisfies Selection);
		if (stage === "late") pi.sendMessage({ customType: MESSAGE, content: describe(server, conn), display: false,
			details: { server } }, { triggerTurn: false });
		activate();
		return true;
	}

	pi.registerTool({ name: BRIDGE, label: "MCP call", description: "Call an MCP tool explicitly announced in this conversation. Only tools enabled for this session can be called.",
		parameters: Type.Object({ tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
		executionMode: "sequential",
		async execute(_id, args, signal) {
			for (const [server, stage] of selected) {
				if (stage !== "late") continue;
				const known = connections.get(server)?.tools.find(t => toolName(server, t.name) === args.tool);
				if (!known) continue;
				const conn = await open(server);
				return { content: resultContent(await conn.call(known.name, args.arguments, signal)), details: undefined };
			}
			throw new Error("MCP tool is not enabled as a late tool in this session");
		},
	});

	async function restore(branch: SessionEntry[], defaults: boolean, notify: (message: string) => void) {
		await closeAll();
		selected = new Map();
		const saved = selections(branch);
		if (defaults && saved.size === 0 && !branch.some(e => e.type === "message" && e.message.role === "user")) {
			for (const server of settings.defaultServers ?? []) {
				try { await enable(server, "direct"); } catch (error) { notify(`MCP ${server}: ${String(error)}`); }
			}
		} else {
			for (const [server, record] of saved) {
				// A server removed from config must not be revived by historical session entries.
				if (!Object.hasOwn(settings.servers, server)) continue;
				try {
					const conn = await open(server);
					if (JSON.stringify(conn.tools) !== record.fingerprint) throw new Error("MCP tool schemas changed; start a new session");
					if (record.stage === "direct") registerDirect(server, conn);
					selected.set(server, record.stage);
					expectedSnapshots.set(server, record.fingerprint);
				} catch (error) {
					const conn = connections.get(server);
					connections.delete(server);
					expectedSnapshots.delete(server);
					await conn?.close().catch(() => {});
					notify(`MCP ${server}: ${String(error)}`);
				}
			}
		}
		activate();
	}
	pi.on("session_start", async (_event, ctx) => {
		try {
			settings = await config();
			await restore(ctx.sessionManager.getBranch(), true, text => ctx.ui.notify(text, "error"));
		} catch (error) {
			settings = { servers: {} };
			selected.clear();
			await closeAll();
			activate();
			ctx.ui.notify(`MCP config: ${String(error)}`, "error");
		}
		refreshFooter = setCompactFooter(ctx, () => selected.size);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await restore(ctx.sessionManager.getBranch(), false, text => ctx.ui.notify(text, "error"));
	});
	pi.on("session_compact", (_event, ctx) => {
		for (const [server, stage] of selected) {
			if (stage !== "late" || !connections.has(server)) continue;
			registerDirect(server, connections.get(server)!);
			selected.set(server, "direct");
			pi.appendEntry(ENTRY, { server, stage: "direct", fingerprint: JSON.stringify(connections.get(server)!.tools) } satisfies Selection);
		}
		activate();
	});
	// A recent late announcement may survive compaction; omit it once its tools are first-class.
	pi.on("context", event => {
		const messages = event.messages.filter(message =>
			message.role !== "custom" || message.customType !== MESSAGE ||
			selected.get((message.details as { server?: string } | undefined)?.server ?? "") === "late");
		return messages.length === event.messages.length ? undefined : { messages };
	});
	// Pi snapshots the old tool state before emitting session_compact. The promoted tools
	// therefore arrive as a system delta *after* the retained history. Rebase only our
	// declarations into the request's leading system message; leave the persisted
	// transcript and other extensions' system changes intact. This happens after the
	// `context` handler above (which may already have collapsed system messages).
	pi.on("context_with_system", (event, ctx) => {
		if (!ctx.sessionManager.getBranch().some(e => e.type === "compaction")) return;
		const head = event.messages[0];
		if (head?.role !== "system") return;
		const directNames = new Set<string>();
		for (const [server, stage] of selected) {
			if (stage !== "direct") continue;
			for (const tool of connections.get(server)?.tools ?? []) directNames.add(toolName(server, tool.name));
		}
		if (directNames.size === 0) return;
		const inHead = new Set((head.toolsAdded ?? []).map(tool => tool.name));
		const effective = new Map((head.toolsAdded ?? []).map(tool => [tool.name, tool] as const));
		for (const message of event.messages.slice(1)) {
			if (message.role !== "system") continue;
			for (const tool of message.toolsRemoved ?? []) effective.delete(tool.name);
			for (const tool of message.toolsAdded ?? []) effective.set(tool.name, tool);
		}
		const moved = [...directNames].filter(name => !inHead.has(name) && effective.has(name));
		if (moved.length === 0) return;
		const movedNames = new Set(moved);
		return { messages: [
			{ ...head, toolsAdded: [...(head.toolsAdded ?? []), ...moved.map(name => effective.get(name)!)] },
			...event.messages.slice(1).map(message => message.role === "system" ? {
				...message,
				...(message.toolsAdded ? { toolsAdded: message.toolsAdded.filter(tool => !movedNames.has(tool.name)) } : {}),
				...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved.filter(tool => !movedNames.has(tool.name)) } : {}),
			} : message),
		] };
	});
	pi.on("session_shutdown", async () => { await closeAll(); selected.clear(); refreshFooter = () => {}; });
	pi.registerCommand("mcp", {
		description: "MCP servers: /mcp list | /mcp on <server>",
		handler: async (args, ctx) => {
			const [action, server, extra] = args.trim().split(/\s+/);
			if (action === "list" && !server) {
				ctx.ui.notify(Object.keys(settings.servers).map(n => `${n}: ${selected.get(n) ?? "off"}`).join("\n") || "No MCP servers configured", "info");
				return;
			}
			if (action !== "on" || !server || extra) { ctx.ui.notify("Usage: /mcp list | /mcp on <server>", "warning"); return; }
			await ctx.waitForIdle();
			try {
				// Before the first user turn, tools enter the cached prefix. Later additions stay at the tail.
				const first = !ctx.sessionManager.getBranch().some(e => e.type === "message" && e.message.role === "user");
				ctx.ui.notify(await enable(server, first ? "direct" : "late") ? `MCP ${server} enabled (${first ? "direct" : "late"})` : `MCP ${server} already enabled`, "info");
			} catch (error) { ctx.ui.notify(`MCP ${server}: ${String(error)}`, "error"); }
		},
	});
}
