import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

interface CommonConfig { callTimeoutMs?: number }
export type ServerConfig = CommonConfig & (
	{ transport?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string } |
	{ transport: "http"; url: string; headers?: Record<string, string> }
);
export interface McpConfig {
	servers: Record<string, ServerConfig>;
	defaultServers?: string[];
}
export interface RemoteTool {
	name: string;
	description?: string;
	inputSchema: { type: "object"; properties?: Record<string, unknown>; [key: string]: unknown };
}
export interface Connection {
	tools: RemoteTool[];
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
	isHealthy(): boolean;
	close(): Promise<void>;
}

const validName = /^[a-zA-Z0-9_]+$/;
export function validateConfig(value: unknown): McpConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP config must be an object");
	const cfg = value as McpConfig;
	if (!cfg.servers || typeof cfg.servers !== "object" || Array.isArray(cfg.servers)) throw new Error("MCP servers must be an object");
	for (const [name, spec] of Object.entries(cfg.servers)) {
		const server = spec as ServerConfig;
		if (!validName.test(name) || !server || typeof server !== "object" ||
			(server.callTimeoutMs !== undefined && (!Number.isSafeInteger(server.callTimeoutMs) || server.callTimeoutMs < 10 || server.callTimeoutMs > 600000)))
			throw new Error(`Invalid MCP server config: ${name}`);
		if (server.transport === "http") {
			if ("command" in server || "args" in server || "env" in server || "cwd" in server || typeof server.url !== "string")
				throw new Error(`Invalid HTTP MCP server: ${name}`);
			let url: URL;
			try { url = new URL(server.url); } catch { throw new Error(`Invalid HTTP MCP URL: ${name}`); }
			if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.hash ||
				(url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
				throw new Error(`HTTP MCP requires HTTPS or loopback: ${name}`);
			if (server.headers !== undefined && (typeof server.headers !== "object" || Array.isArray(server.headers) ||
				!Object.entries(server.headers).every(([key, v]) => typeof v === "string" &&
					!/^(host|mcp-session-id|content-type|accept)$/i.test(key))))
				throw new Error(`Invalid HTTP MCP headers: ${name}`);
		} else if ((server.transport !== undefined && server.transport !== "stdio") ||
			!("command" in server) || typeof server.command !== "string" || !server.command.trim() || "url" in server || "headers" in server ||
			(server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(a => typeof a === "string"))) ||
			(server.env !== undefined && (typeof server.env !== "object" || Array.isArray(server.env) || !Object.values(server.env).every(v => typeof v === "string"))) ||
			(server.cwd !== undefined && typeof server.cwd !== "string")) throw new Error(`Invalid stdio MCP server: ${name}`);
	}
	if (cfg.defaultServers !== undefined && (!Array.isArray(cfg.defaultServers) || !cfg.defaultServers.every(n => typeof n === "string" && n in cfg.servers)))
		throw new Error("Invalid defaultServers");
	return cfg;
}

export async function loadConfig(agentDir: string): Promise<McpConfig> {
	try { return validateConfig(JSON.parse(await readFile(join(agentDir, "pione-mcp.json"), "utf8"))); }
	catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
		throw e;
	}
}

/** One session-scoped MCP client, using either stdio or MCP Streamable HTTP (not Chrome's CDP HTTP API). */
export async function connectServer(config: ServerConfig): Promise<Connection> {
	const client = new Client({ name: "pione", version: "1.0.0" });
	const http = config.transport === "http";
	const transport = http
		? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: "error" } })
		: new StdioClientTransport({ command: config.command, args: config.args ?? [], cwd: config.cwd,
			env: { ...process.env, ...config.env } as Record<string, string>, stderr: "pipe" });
	if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {}); // Drain without leaking secrets.
	// HTTP sessions SHOULD be deleted on exit. Bound cleanup time if the remote endpoint is unresponsive.
	const close = async () => {
		if (transport instanceof StreamableHTTPClientTransport) {
			await Promise.race([transport.terminateSession().catch(() => {}),
				new Promise<void>(resolve => { setTimeout(resolve, 2000).unref(); })]);
		}
		await client.close().catch(() => {});
	};
	try {
		await client.connect(transport, { timeout: 15000 });
		const tools: RemoteTool[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			if (++pages > 100) throw new Error("MCP tools pagination limit exceeded");
			const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15000 });
			for (const tool of result.tools) {
				if (!tool.inputSchema || tool.inputSchema.type !== "object") throw new Error(`Invalid MCP tool schema: ${tool.name}`);
				tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
			}
			cursor = result.nextCursor;
		} while (cursor);
		let healthy = true;
		let queue: Promise<unknown> = Promise.resolve();
		// A single MCP session may have mutable state. Don't queue calls inside the server behind a slow call.
		const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
			const run = async () => {
				if (!healthy) throw new Error("MCP connection was reset; session state may have been lost.");
				const timeout = config.callTimeoutMs ?? 60000;
				try { return await client.callTool({ name, arguments: args }, undefined, { signal, timeout }); }
				catch (error) {
					if ((error instanceof McpError && (error.code === ErrorCode.RequestTimeout || error.code === ErrorCode.ConnectionClosed)) || signal?.aborted) {
						healthy = false;
						// A request timeout doesn't stop the operation server-side; discard the session.
						await close();
						throw new Error(`MCP ${name} timed out or was interrupted after ${timeout} ms. The connection was reset; remote session state may have been lost.`, { cause: error });
					}
					throw error;
				}
			};
			const pending = queue.then(run);
			queue = pending.catch(() => {});
			return pending;
		};
		return { tools, call, isHealthy: () => healthy, close: async () => { healthy = false; await close(); } };
	} catch (error) {
		await close();
		throw error;
	}
}
