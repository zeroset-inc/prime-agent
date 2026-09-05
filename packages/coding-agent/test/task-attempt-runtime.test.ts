import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeResult } from "../src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../src/core/agent-session-services.js";
import type { CreateRlmSubagentRuntimeOptions } from "../src/core/rlm-runtime.js";
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

it("preserves completed-session hydration without requiring an active task", async () => {
	const getAttemptSignal = vi.fn(() => {
		throw new Error("Completed tasks have no active attempt");
	});
	const requestAbort = vi.fn();
	const disposeAsync = vi.fn(async () => {});
	const session = {
		taskGraph: { getTask: () => ({ status: "completed" }), getAttemptSignal },
		taskId: "completed-task",
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
			throw new Error("Not used for hydration");
		},
		[],
		undefined,
		undefined,
		{ kind: "subagent", createdAt: 1, taskId: "completed-task", rehydratedCompleted: true },
	);
	expect(runtime.session).toBe(session);
	expect(getAttemptSignal).not.toHaveBeenCalled();
	expect(requestAbort).not.toHaveBeenCalled();
	await runtime.dispose();
	expect(disposeAsync).toHaveBeenCalledTimes(1);
});

it.each([
	{ stage: "factory", retirement: "task", cleanupFails: false },
	{ stage: "factory", retirement: "host", cleanupFails: false },
	{ stage: "binding", retirement: "task", cleanupFails: false },
	{ stage: "binding", retirement: "host", cleanupFails: false },
	{ stage: "factory", retirement: "task", cleanupFails: true },
	{ stage: "factory", retirement: "cancelled", cleanupFails: false },
	{ stage: "factory", retirement: "interrupted", cleanupFails: false },
	{ stage: "factory", retirement: "completed", cleanupFails: false },
	{ stage: "binding", retirement: "cancelled", cleanupFails: false },
	{ stage: "binding", retirement: "interrupted", cleanupFails: false },
	{ stage: "binding", retirement: "completed", cleanupFails: false },
])(
	"cleans up $stage startup after $retirement retirement (cleanupFails=$cleanupFails)",
	async ({ stage, retirement, cleanupFails }) => {
		const directory = mkdtempSync(join(tmpdir(), "prime-attempt-startup-"));
		directories.push(directory);
		vi.stubEnv(SESSION_LEASES_ENABLED_ENV, "1");
		const graph = AgentTaskGraph.open({ directory, root: { ownerAgentId: "root", objective: "Review" } });
		const task = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root",
			childAgentId: "child",
			task: { objective: "Review", scope: "command", questions: ["Safe?"], delegationReason: "Narrow" },
		});
		const startupPaused = deferred();
		const startupContinues = deferred();
		const cleanupError = new Error("Session cleanup failed");
		const childDispose = vi.fn(async () => {
			if (cleanupFails) throw cleanupError;
		});
		const bindExtensions = vi.fn(async () => {
			if (stage === "binding") {
				startupPaused.resolve();
				await startupContinues.promise;
			}
		});
		const child = {
			taskGraph: graph,
			taskId: task.id,
			taskActorId: "child",
			sessionName: "child",
			requestAbort: vi.fn(),
			disposeAsync: childDispose,
			bindExtensions,
			setSubagentRuntimeHost: () => {},
			extensionRunner: { hasHandlers: () => false },
		} as unknown as AgentSession;
		const parent = {
			taskGraph: graph,
			sessionManager: SessionManager.inMemory(directory, directory),
			setSubagentRuntimeHost: () => {},
			disposeAsync: async () => {},
			extensionRunner: { hasHandlers: () => false },
			getRlmChildRunStatus: () => "queued",
		} as unknown as AgentSession;
		const services = { cwd: directory, agentDir: directory } as AgentSessionServices;
		let childPath: string | undefined;
		const createRuntime = vi.fn(async (options: { sessionManager: SessionManager }) => {
			childPath = options.sessionManager.getSessionFile();
			if (stage === "factory") {
				startupPaused.resolve();
				await startupContinues.promise;
			}
			return { session: child, services, diagnostics: [] } as unknown as CreateAgentSessionRuntimeResult;
		});
		const runtime = new AgentSessionRuntime(parent, services, createRuntime);
		const published = vi.fn();
		const options = {
			parentSession: parent,
			id: "child",
			taskId: task.id,
			taskActorId: "child",
			sessionName: "child",
			sessionDir: directory,
			onSessionPublished: published,
		} as unknown as CreateRlmSubagentRuntimeOptions;
		const startupResult = runtime.createRlmSubagentRuntime(options).then(
			() => undefined,
			(error: unknown) => error,
		);
		await startupPaused.promise;
		if (retirement === "task") graph.reassignTask(task.id, "root", "successor");
		else if (retirement === "cancelled") graph.cancelTask(task.id, "root", "No longer needed");
		else if (retirement === "interrupted") graph.interruptTask(task.id, "root", "Execution stopped");
		else if (retirement === "completed")
			graph.completeTask(task.id, "child", {
				summary: "Already completed",
				verification: [],
				candidateFindings: [],
				unresolvedQuestions: [],
				coverageGaps: [],
				evidenceRefs: [],
			});
		else await runtime.dispose();
		startupContinues.resolve();
		const error = await startupResult;
		if (cleanupFails) {
			expect(error).toBeInstanceOf(AggregateError);
			expect(error).toMatchObject({
				errors: [expect.objectContaining({ message: expect.stringContaining("does not own") }), cleanupError],
				cause: expect.objectContaining({ message: expect.stringContaining("does not own") }),
			});
		} else {
			expect(error).toBeInstanceOf(Error);
			const terminalStatus = ["cancelled", "interrupted", "completed"].includes(retirement);
			const expectedMessage =
				terminalStatus && (stage === "factory" || retirement === "completed")
					? `status ${retirement}`
					: stage === "factory" && retirement === "task"
						? "does not own"
						: "runtime disposal started";
			expect(error).toMatchObject({
				message: expect.stringContaining(expectedMessage),
			});
		}
		expect(childDispose).toHaveBeenCalledTimes(1);
		expect(published).not.toHaveBeenCalled();
		expect(runtime.listSubagentRuntimes()).toEqual([]);
		if (stage === "factory") expect(bindExtensions).not.toHaveBeenCalled();
		expect(childPath).toBeDefined();
		const lease = acquireSessionLease(childPath, directory);
		expect(lease).toBeDefined();
		lease?.release();
		await runtime.dispose();
		await expect(runtime.createRlmSubagentRuntime(options)).rejects.toThrow("runtime disposal started");
		expect(createRuntime).toHaveBeenCalledTimes(1);
	},
);

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
