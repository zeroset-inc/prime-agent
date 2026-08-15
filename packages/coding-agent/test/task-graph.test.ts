import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTaskGraph, AgentTaskGraphError, formatAgentTaskContextEnvelope } from "../src/core/task-graph.js";

function claim(key: string) {
	return { namespace: "repo:file", key };
}

describe("AgentTaskGraph", () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	function open() {
		directory = mkdtempSync(join(tmpdir(), "prime-task-graph-"));
		return AgentTaskGraph.open({
			directory,
			root: {
				ownerAgentId: "root-agent",
				objective: "Review the change",
				scope: "Entire pull request",
				exclusiveClaims: [claim("a.ts"), claim("b.ts"), claim("c.ts")],
				rootContext: { baseRevision: "base", headRevision: "head" },
			},
			policy: { requireExclusiveClaims: true },
		});
	}

	it("atomically transfers exclusive ownership and builds inherited context", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "child-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts runtime behavior",
				exclusiveClaims: [claim("a.ts")],
				sharedClaims: [claim("b.ts")],
				questions: ["Does the contract remain compatible?"],
				delegationReason: "Independent runtime boundary",
			},
		});

		expect(graph.getTask(graph.rootTaskId).exclusiveClaims).toEqual([claim("b.ts"), claim("c.ts")]);
		expect(child.exclusiveClaims).toEqual([claim("a.ts")]);
		const envelope = graph.contextEnvelope(child.id);
		expect(envelope).toMatchObject({
			rootObjective: "Review the change",
			rootContext: { baseRevision: "base", headRevision: "head" },
			lineage: [graph.rootTaskId, child.id],
		});
		expect(formatAgentTaskContextEnvelope(envelope)).toContain("a.ts runtime behavior");
		expect(existsSync(join(directory!, "task-graph.snapshot.json"))).toBe(true);
		expect(readFileSync(join(directory!, "task-graph.events.jsonl"), "utf8")).toContain("task.delegated");
	});

	it("rejects overlap, non-owned claims, duplicate work, and spoofed callers", () => {
		const graph = open();
		const input = {
			objective: "Review a.ts",
			scope: "a.ts",
			exclusiveClaims: [claim("a.ts")],
			questions: ["Is it correct?"],
			delegationReason: "Independent file",
		};
		graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "first-child",
			task: input,
		});
		expect(() =>
			graph.reserveDelegation({
				parentTaskId: graph.rootTaskId,
				callerAgentId: "root-agent",
				childAgentId: "second-child",
				task: input,
			}),
		).toThrow("does not own exclusive claim repo:file:a.ts");
		expect(() => graph.updateProgress(graph.rootTaskId, "spoofed-agent", { summary: "no" })).toThrow(
			"does not own task",
		);
	});

	it("rejects delegation that does not reduce responsibility", () => {
		const graph = open();
		expect(() =>
			graph.reserveDelegation({
				parentTaskId: graph.rootTaskId,
				callerAgentId: "root-agent",
				childAgentId: "duplicate-agent",
				task: {
					objective: "Review the change",
					scope: "Entire pull request",
					exclusiveClaims: [claim("a.ts"), claim("b.ts"), claim("c.ts")],
					delegationReason: "Repeat the parent review",
				},
			}),
		).toThrow("meaningfully narrower");
	});

	it("supports recursive delegation and reclaims a failed subtree exactly once", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "child-agent",
			task: {
				objective: "Review runtime",
				scope: "a.ts and b.ts",
				exclusiveClaims: [claim("a.ts"), claim("b.ts")],
				delegationReason: "Runtime boundary",
			},
		});
		graph.startTask(child.id, "child-agent");
		const grandchild = graph.reserveDelegation({
			parentTaskId: child.id,
			callerAgentId: "child-agent",
			childAgentId: "grandchild-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts only",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent concurrency concern",
			},
		});
		graph.startTask(grandchild.id, "grandchild-agent");

		graph.interruptTask(child.id, "child-agent", "child runtime failed");
		expect(graph.getTask(child.id).status).toBe("interrupted");
		expect(graph.getTask(grandchild.id).status).toBe("interrupted");
		expect(
			graph
				.getTask(graph.rootTaskId)
				.exclusiveClaims.map((item) => item.key)
				.sort(),
		).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("enforces direct-parent supervision while granting the root global authority", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "child-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.startTask(child.id, "child-agent");
		expect(() => graph.cancelTask(child.id, "unrelated-agent", "stop")).toThrow(AgentTaskGraphError);
		expect(graph.cancelTask(child.id, "root-agent", "root intervention").status).toBe("cancelled");
	});

	it("persists completion and interrupts live children during recovery", () => {
		const graph = open();
		const completed = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "completed-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.startTask(completed.id, "completed-agent");
		graph.completeTask(completed.id, "completed-agent", {
			summary: "No issue",
			verification: [],
			candidateFindings: [],
			unresolvedQuestions: [],
			coverageGaps: [],
			evidenceRefs: ["artifact://a"],
		});
		const interrupted = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "interrupted-agent",
			task: {
				objective: "Review b.ts",
				scope: "b.ts",
				exclusiveClaims: [claim("b.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.startTask(interrupted.id, "interrupted-agent");

		const restored = AgentTaskGraph.open({
			directory: directory!,
			root: { ownerAgentId: "new-root-agent", objective: "Review the change" },
			policy: { requireExclusiveClaims: true },
		});
		expect(restored.getTask(completed.id).status).toBe("completed");
		expect(restored.getTask(interrupted.id).status).toBe("interrupted");
		expect(restored.rootAgentId).toBe("new-root-agent");
		expect(
			restored
				.getTask(restored.rootTaskId)
				.exclusiveClaims.map((item) => item.key)
				.sort(),
		).toEqual(["b.ts", "c.ts"]);
	});

	it("recovers an active recursive subtree once without resurrecting its coordinator", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "child-agent",
			task: {
				objective: "Review runtime files",
				scope: "a.ts and b.ts",
				exclusiveClaims: [claim("a.ts"), claim("b.ts")],
				delegationReason: "Runtime boundary",
			},
		});
		graph.startTask(child.id, "child-agent");
		const grandchild = graph.reserveDelegation({
			parentTaskId: child.id,
			callerAgentId: "child-agent",
			childAgentId: "grandchild-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Narrow concurrency concern",
			},
		});
		graph.startTask(grandchild.id, "grandchild-agent");

		const restored = AgentTaskGraph.open({
			directory: directory!,
			root: { ownerAgentId: "restored-root", objective: "Review the change" },
			policy: { requireExclusiveClaims: true },
		});
		expect(restored.getTask(child.id).status).toBe("interrupted");
		expect(restored.getTask(grandchild.id).status).toBe("interrupted");
		expect(
			restored
				.getTask(restored.rootTaskId)
				.exclusiveClaims.map((item) => item.key)
				.sort(),
		).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("requires open gaps and delegated tasks to be resolved before completion", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "child-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.startTask(child.id, "child-agent");
		const gap = graph.reportGap(child.id, "child-agent", {
			kind: "context",
			description: "Missing generated contract",
			neededInformation: "Generated output",
		});
		expect(() => graph.completeTaskFromRuntime(child.id, "child-agent", "Cannot finish")).toThrow("open gaps");
		graph.resolveGap(child.id, gap.id, "root-agent", {
			status: "resolved",
			resolution: "Generated output is artifact://generated",
		});
		graph.completeTaskFromRuntime(child.id, "child-agent", "Verified");
		expect(() => graph.assertDelegatedTasksComplete()).not.toThrow();
	});

	it("surfaces generic root-visible supervision signals without taking workflow decisions", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "child-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				questions: ["Is the new behavior safe?"],
				delegationReason: "Independent file",
			},
		});
		graph.startTask(child.id, "child-agent");
		const gap = graph.reportGap(child.id, "child-agent", {
			kind: "context",
			description: "Generated contract is missing",
		});
		const stalledAt = Date.parse(graph.getTask(child.id).updatedAt) + 10_000;
		expect(graph.getSupervisionAlerts({ now: stalledAt, stallAfterMs: 1_000 })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: child.id, kind: "blocked_gap", directParentTaskId: graph.rootTaskId }),
			]),
		);
		graph.resolveGap(child.id, gap.id, "root-agent", { status: "resolved", resolution: "Found it" });
		graph.completeTaskFromRuntime(child.id, "child-agent", "No issue");
		expect(graph.getSupervisionAlerts()).toEqual(
			expect.arrayContaining([expect.objectContaining({ taskId: graph.rootTaskId, kind: "ready_for_synthesis" })]),
		);
	});
});
