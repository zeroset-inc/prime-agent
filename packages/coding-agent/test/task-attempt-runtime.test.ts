import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeResult } from "../src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../src/core/agent-session-services.js";
import { acquireSessionLease, SESSION_LEASES_ENABLED_ENV } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import { AgentTaskGraph } from "../src/core/task-graph.js";

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

it("fences a replacement built while the task attempt is retiring and releases its lease", async () => {
	const directory = mkdtempSync(join(tmpdir(), "prime-attempt-replacement-"));
	directories.push(directory);
	vi.stubEnv(SESSION_LEASES_ENABLED_ENV, "1");
	const graph = AgentTaskGraph.open({ directory, root: { ownerAgentId: "root", objective: "Review" } });
	const task = graph.reserveDelegation({
		parentTaskId: graph.rootTaskId,
		callerAgentId: "root",
		childAgentId: "child",
		task: { objective: "Review", scope: "command", questions: ["Safe?"], delegationReason: "Narrow" },
	});
	const buildStarted = deferred();
	const buildFinished = deferred();
	const shutdownFinished = deferred();
	const requestAbort = vi.fn();
	const oldDispose = vi.fn(async () => {});
	const replacementDispose = vi.fn(async () => {});
	const session = {
		taskGraph: graph,
		taskId: task.id,
		taskActorId: "child",
		sessionManager: SessionManager.inMemory(directory, directory),
		requestAbort,
		disposeAsync: oldDispose,
		setSubagentRuntimeHost: () => {},
		extensionRunner: {
			hasHandlers: (event: string) => event === "session_shutdown",
			emit: async (event: { reason: string }) => {
				if (event.reason === "quit") await shutdownFinished.promise;
			},
		},
	} as unknown as AgentSession;
	const replacement = {
		disposeAsync: replacementDispose,
		setSubagentRuntimeHost: () => {},
	} as unknown as AgentSession;
	const services = { cwd: directory, agentDir: directory } as AgentSessionServices;
	let replacementPath: string | undefined;
	const createRuntime = vi.fn(async (options: { sessionManager: SessionManager }) => {
		replacementPath = options.sessionManager.getSessionFile();
		buildStarted.resolve();
		await buildFinished.promise;
		return { session: replacement, services, diagnostics: [] } as unknown as CreateAgentSessionRuntimeResult;
	});
	const runtime = new AgentSessionRuntime(session, services, createRuntime, [], undefined, undefined, {
		kind: "subagent",
		createdAt: 1,
		taskId: task.id,
	});
	const replaced = vi.fn();
	runtime.onSessionReplaced(replaced);
	const switchResult = runtime.newSession();
	await buildStarted.promise;
	graph.reassignTask(task.id, "root", "successor");
	expect(requestAbort).toHaveBeenCalledTimes(1);
	const rejected = expect(switchResult).rejects.toThrow("runtime disposal started");
	buildFinished.resolve();
	await rejected;
	expect(runtime.session).toBe(session);
	expect(replaced).not.toHaveBeenCalled();
	expect(replacementDispose).toHaveBeenCalledTimes(1);
	expect(replacementPath).toBeDefined();
	const lease = acquireSessionLease(replacementPath, directory);
	expect(lease).toBeDefined();
	lease?.release();
	await expect(runtime.newSession()).rejects.toThrow("runtime disposal started");
	await expect(runtime.fork("unused")).rejects.toThrow("runtime disposal started");
	await expect(runtime.switchSession("unused")).rejects.toThrow("runtime disposal started");
	await expect(runtime.importFromJsonl("unused")).rejects.toThrow("runtime disposal started");
	expect(createRuntime).toHaveBeenCalledTimes(1);
	shutdownFinished.resolve();
	await runtime.dispose();
	expect(oldDispose).toHaveBeenCalledTimes(2);
	expect(replacementDispose).toHaveBeenCalledTimes(1);
	expect(runtime.diagnostics).toEqual([]);
});

it("immediately aborts the superseded session and disposes it exactly once", async () => {
	const directory = mkdtempSync(join(tmpdir(), "prime-attempt-runtime-"));
	directories.push(directory);
	const graph = AgentTaskGraph.open({ directory, root: { ownerAgentId: "root", objective: "Review" } });
	const task = graph.reserveDelegation({
		parentTaskId: graph.rootTaskId,
		callerAgentId: "root",
		childAgentId: "child",
		task: {
			objective: "Review command",
			scope: "command",
			questions: ["Is it safe?"],
			delegationReason: "Narrow command",
		},
	});
	const requestAbort = vi.fn();
	const disposeAsync = vi.fn(async () => {});
	const session = {
		taskGraph: graph,
		taskId: task.id,
		taskActorId: "child",
		requestAbort,
		disposeAsync,
		setSubagentRuntimeHost: () => {},
		extensionRunner: { hasHandlers: () => false },
	} as unknown as AgentSession;
	const runtime = new AgentSessionRuntime(
		session,
		{} as AgentSessionServices,
		() => {
			throw new Error("not used");
		},
		[],
		undefined,
		undefined,
		{ kind: "subagent", createdAt: 1, taskId: task.id },
	);
	graph.reassignTask(task.id, "root", "successor");
	expect(requestAbort).toHaveBeenCalledTimes(1);
	await runtime.dispose();
	expect(disposeAsync).toHaveBeenCalledTimes(1);
	expect(graph.getTask(task.id).ownerAgentId).toBe("successor");
	expect(runtime.diagnostics).toEqual([]);
});
