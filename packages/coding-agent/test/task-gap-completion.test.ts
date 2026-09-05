import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTaskGraph, type AgentTaskGraphPolicy, type AgentTaskResult } from "../src/core/task-graph.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(policy: AgentTaskGraphPolicy = {}) {
	const directory = mkdtempSync(join(tmpdir(), "prime-gap-completion-"));
	directories.push(directory);
	const options = {
		directory,
		root: { ownerAgentId: "root", objective: "Review the change" },
		policy: { adjudicatedTaskCompletion: true, ...policy },
	};
	const graph = AgentTaskGraph.open(options);
	const task = graph.reserveDelegation({
		parentTaskId: graph.rootTaskId,
		callerAgentId: "root",
		childAgentId: "child",
		task: {
			objective: "Review xtask",
			scope: "xtask",
			questions: ["Is the new command correct?"],
			delegationReason: "Independent command",
		},
	});
	graph.startTask(task.id, "child");
	const gap = graph.reportGap(task.id, "child", { kind: "coverage", description: "Docker E2E unavailable" });
	const result: AgentTaskResult = {
		summary: "No defects; nine focused checks passed",
		verification: ["9 passed"],
		candidateFindings: [],
		unresolvedQuestions: [],
		coverageGaps: [{ gapId: gap.id }],
		evidenceRefs: [],
	};
	return { options, graph, task, gap, result };
}

describe("adjudicated task completion", () => {
	it("completes the saved PR 170 result without replacing or resuming the child", () => {
		const { graph, task, gap, result } = fixture();
		expect(graph.completeTask(task.id, "child", result).status).toBe("blocked");
		const decision = { status: "declined" as const, resolution: "Optional E2E is a nonblocking limitation" };
		graph.resolveGap(task.id, gap.id, "root", decision);
		const completed = graph.getTask(task.id);
		expect(completed.status).toBe("completed");
		expect(completed.result).toEqual(result);
		expect(completed.attempts).toHaveLength(1);
		expect(completed.pendingCompletion).toBeUndefined();
		expect(completed.gaps[0]?.adjudication).toEqual({
			byAgentId: "root",
			disposition: "accepted_limitation",
			taskAction: "completed_saved_result",
		});
		expect(graph.getPendingResumeRequests().filter((request) => request.taskId === task.id)).toEqual([]);
		expect(graph.completeTask(task.id, "child", result)).toEqual(completed);
		const version = graph.version;
		graph.resolveGap(task.id, gap.id, "root", decision);
		expect(graph.version).toBe(version);
	});

	it("resumes the same owner when the resolution supplies new information", () => {
		const { graph, task, gap, result } = fixture();
		graph.completeTask(task.id, "child", result);
		graph.resolveGap(task.id, gap.id, "root", { status: "resolved", resolution: "Docker is now available; run E2E" });
		expect(graph.getTask(task.id).status).toBe("pending");
		expect(graph.getTask(task.id).pendingCompletion).toBeUndefined();
		expect(graph.getTask(task.id).ownerAgentId).toBe("child");
		expect(graph.getPendingResumeRequests().some((request) => request.taskId === task.id)).toBe(true);
	});

	it("does not save a result that fails host coverage validation", () => {
		const { graph, task, result } = fixture({
			validateCompletion: () => {
				throw new Error("missing owned file");
			},
		});
		expect(() => graph.completeTask(task.id, "child", result)).toThrow("missing owned file");
		expect(graph.getTask(task.id).pendingCompletion).toBeUndefined();
	});

	it("revalidates a saved result against the current host contract", () => {
		let valid = true;
		const { graph, task, gap, result } = fixture({
			validateCompletion: () => {
				if (!valid) throw new Error("new verification needed");
			},
		});
		graph.completeTask(task.id, "child", result);
		valid = false;
		graph.resolveGap(task.id, gap.id, "root", { status: "declined", resolution: "Optional" });
		expect(graph.getTask(task.id).status).toBe("pending");
		expect(graph.getTask(task.id).gaps[0]?.adjudication?.validationError).toBe("new verification needed");
	});

	it("waits for every gap and does not auto-complete after a resolved gap", () => {
		const { graph, task, gap, result } = fixture();
		const second = graph.reportGap(task.id, "child", { kind: "context", description: "Need config" });
		graph.completeTask(task.id, "child", result);
		graph.resolveGap(task.id, gap.id, "root", { status: "declined", resolution: "Optional" });
		expect(graph.getTask(task.id).status).toBe("blocked");
		graph.resolveGap(task.id, second.id, "root", { status: "resolved", resolution: "Config supplied" });
		expect(graph.getTask(task.id).status).toBe("pending");
	});

	it("fences the saved result and aborts the previous attempt at replacement", () => {
		const { graph, task, gap, result } = fixture();
		graph.recordHandoff(task.id, "child", {
			summary: "Inspection complete",
			rejectedHypotheses: ["No parser regression"],
		});
		graph.completeTask(task.id, "child", result);
		const signal = graph.getAttemptSignal(task.id, "child");
		graph.reassignTask(task.id, "root", "successor");
		expect(signal.aborted).toBe(true);
		expect(graph.getTask(task.id).attempts[0]?.handoff?.rejectedHypotheses).toEqual(["No parser regression"]);
		expect(graph.getTask(task.id).attempts[0]?.handoff?.summary).toBe(
			`Replaced by supervising agent. ${result.summary}`,
		);
		graph.resolveGap(task.id, gap.id, "root", { status: "declined", resolution: "Optional" });
		expect(graph.getTask(task.id).status).toBe("pending");
		expect(() => graph.completeTask(task.id, "child", result)).toThrow("does not own");
		expect(graph.getAttemptSignal(task.id, "successor").aborted).toBe(false);
	});

	it("preserves the pending result and its attempt across journal recovery", () => {
		const { graph, options, task, gap, result } = fixture();
		const proposed = graph.completeTask(task.id, "child", result);
		const restored = AgentTaskGraph.open(options);
		expect(restored.getTask(task.id).pendingCompletion).toEqual(proposed.pendingCompletion);
		restored.resolveGap(task.id, gap.id, "root", { status: "declined", resolution: "Optional" });
		expect(restored.getTask(task.id).status).toBe("completed");
	});

	it("does not let the child adjudicate its own gap", () => {
		const { graph, task, gap } = fixture();
		expect(() => graph.resolveGap(task.id, gap.id, "child", { status: "declined", resolution: "Optional" })).toThrow(
			"not an ancestor",
		);
	});

	it("invalidates a saved result when the owner reports an additional gap", () => {
		const { graph, task, gap, result } = fixture();
		graph.completeTask(task.id, "child", result);
		const second = graph.reportGap(task.id, "child", { kind: "context", description: "New unresolved contract" });
		expect(graph.getTask(task.id).pendingCompletion).toBeUndefined();
		graph.resolveGap(task.id, gap.id, "root", { status: "declined", resolution: "Optional" });
		graph.resolveGap(task.id, second.id, "root", { status: "declined", resolution: "Out of scope" });
		expect(graph.getTask(task.id).status).toBe("pending");
	});

	it("does not auto-complete recovered proposals when the host disables the capability", () => {
		const { graph, options, task, gap, result } = fixture();
		graph.completeTask(task.id, "child", result);
		const restored = AgentTaskGraph.open({ ...options, policy: {} });
		restored.resolveGap(task.id, gap.id, "root", { status: "declined", resolution: "Optional" });
		expect(restored.getTask(task.id).status).toBe("pending");
	});
});
