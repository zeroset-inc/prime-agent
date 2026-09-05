import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { AgentTaskGraph } from "../src/core/task-graph.js";
import { createTestResourceLoader } from "./utilities.js";

let directory: string;
const sessions: AgentSession[] = [];
const releases: Array<() => void> = [];
const runtimes: AgentSessionRuntime[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "prime-quiescence-retirement-"));
});

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	for (const session of sessions.splice(0)) await session.disposeAsync();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createSession(extra: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model: getModel("anthropic", "claude-sonnet-4-5"), tools: [], systemPrompt: "" },
			streamFn: () => {
				throw new Error("This regression must not call a model");
			},
		}),
		sessionManager: SessionManager.inMemory(directory),
		settingsManager: SettingsManager.inMemory(),
		cwd: directory,
		modelRegistry: ModelRegistry.create(AuthStorage.inMemory(), join(directory, "models.json")),
		resourceLoader: createTestResourceLoader(),
		...extra,
	});
	sessions.push(session);
	return session;
}

async function gatedWork(session: AgentSession) {
	const started = deferred();
	const finish = deferred();
	releases.push(finish.resolve);
	const done = session.executeBash("in-memory gate", undefined, {
		operations: {
			exec: async () => {
				started.resolve();
				await finish.promise;
				return { exitCode: 0 };
			},
		},
	});
	await started.promise;
	return { finish: finish.resolve, done };
}

function waits(session: AgentSession) {
	return (session as unknown as { _rlmQuiescenceWaitAborts: Set<AbortController> })._rlmQuiescenceWaitAborts.size;
}

function taskRuntime(child: AgentSession) {
	const runtime = new AgentSessionRuntime(
		child,
		{ cwd: directory, agentDir: directory } as AgentSessionServices,
		async () => {
			throw new Error("No runtime construction expected");
		},
		[],
		undefined,
		undefined,
		{ kind: "subagent", createdAt: Date.now(), taskId: child.taskId },
	);
	runtimes.push(runtime);
	return runtime;
}

it.each(["replace", "cancel", "interrupt"] as const)(
	"keeps the parent alive during task %s and waits for remaining work",
	async (action) => {
		const graph = AgentTaskGraph.open({
			directory: join(directory, "graph"),
			root: { ownerAgentId: "root", objective: "Review" },
		});
		const task = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root",
			childAgentId: "child",
			task: {
				objective: "Inspect command",
				scope: "command",
				questions: ["Is it safe?"],
				delegationReason: "Independent command",
			},
		});
		graph.startTask(task.id, "child");
		const root = createSession();
		const child = createSession({ taskGraph: graph, taskId: task.id, taskActorId: "child" });
		const runtime = taskRuntime(child);
		const oldWork = await gatedWork(child);
		root.registerRlmChildSession("child", child);
		let settled = false;
		const barrier = root.waitForRlmQuiescence().then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(waits(root)).toBe(2));
		if (action === "replace") graph.reassignTask(task.id, "root", "successor");
		else if (action === "cancel") graph.cancelTask(task.id, "root", "No longer required");
		else graph.interruptTask(task.id, "root", "Execution interrupted");
		const successor = createSession();
		const nextWork = await gatedWork(successor);
		root.registerRlmChildSession("successor", successor);
		oldWork.finish();
		await oldWork.done;
		await runtime.dispose();
		await vi.waitFor(() => expect(waits(root)).toBeGreaterThan(1));
		expect(settled).toBe(false);
		nextWork.finish();
		await nextWork.done;
		await barrier;
		expect(settled).toBe(true);
		expect(waits(root)).toBe(0);
	},
);

it("waits for retired child cleanup before completing", async () => {
	const root = createSession();
	const child = createSession();
	const work = await gatedWork(child);
	root.registerRlmChildSession("child", child);
	let settled = false;
	const barrier = root.waitForRlmQuiescence().then(() => {
		settled = true;
	});
	await vi.waitFor(() => expect(waits(root)).toBe(2));
	const cleanup = deferred();
	releases.push(cleanup.resolve);
	child.registerDisposeCallback(() => cleanup.promise);
	child.requestAbort();
	const disposal = child.disposeAsync();
	work.finish();
	await work.done;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(settled).toBe(false);
	cleanup.resolve();
	await disposal;
	await barrier;
});

it.each(["root", "external"] as const)("preserves %s cancellation across nested descendants", async (source) => {
	const root = createSession();
	const child = createSession();
	const grandchild = createSession();
	const work = await gatedWork(grandchild);
	root.registerRlmChildSession("child", child);
	child.registerRlmChildSession("grandchild", grandchild);
	const external = new AbortController();
	const barrier = root.waitForRlmQuiescence(external.signal);
	const rejected = expect(barrier).rejects.toThrow("RLM quiescence wait cancelled");
	await vi.waitFor(() => expect(waits(root)).toBe(3));
	if (source === "root") root.requestAbort();
	else external.abort();
	await rejected;
	await vi.waitFor(() => expect(waits(root)).toBe(0));
	work.finish();
	await work.done;
});

it("propagates genuine descendant barrier errors and releases sibling waiters", async () => {
	const root = createSession();
	const child = createSession();
	const sibling = createSession();
	const work = await gatedWork(sibling);
	const failure = deferred();
	releases.push(failure.resolve);
	vi.spyOn(child, "waitForHeadlessIdle").mockImplementation(async () => {
		await failure.promise;
		throw new Error("Headless continuation failed");
	});
	root.registerRlmChildSession("child", child);
	root.registerRlmChildSession("sibling", sibling);
	const barrier = root.waitForRlmQuiescence();
	const rejected = expect(barrier).rejects.toThrow("Headless continuation failed");
	await vi.waitFor(() => expect(waits(root)).toBe(3));
	failure.resolve();
	await rejected;
	await vi.waitFor(() => expect(waits(root)).toBe(0));
	work.finish();
	await work.done;
});
