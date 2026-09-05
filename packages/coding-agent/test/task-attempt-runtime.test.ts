import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../src/core/agent-session-services.js";
import { AgentTaskGraph } from "../src/core/task-graph.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
