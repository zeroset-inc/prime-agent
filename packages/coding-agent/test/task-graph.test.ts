import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

	function admitPendingResume(graph: AgentTaskGraph, taskId: string, ownerAgentId: string) {
		const request = graph.getPendingResumeRequests().find((candidate) => candidate.taskId === taskId);
		expect(request).toBeDefined();
		graph.markResumeAdmitted(taskId, request!.id, ownerAgentId);
		return request!;
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

	it("inherits a bounded projection while retaining full root context on demand", () => {
		directory = mkdtempSync(join(tmpdir(), "prime-task-graph-"));
		const graph = AgentTaskGraph.open({
			directory,
			root: {
				ownerAgentId: "root-agent",
				objective: "Review the change",
				rootContext: { manifest: ["a.ts", "b.ts"], contract: "full" },
				inheritedContext: { baseRevision: "base", headRevision: "head" },
			},
		});

		const envelope = graph.contextEnvelope(graph.rootTaskId);
		expect(envelope.rootContext).toEqual({ baseRevision: "base", headRevision: "head" });
		expect(envelope.rootContextDescriptor).toMatchObject({
			byteLength: expect.any(Number),
			sha256: expect.any(String),
		});
		expect(graph.getRootContext()).toEqual({ manifest: ["a.ts", "b.ts"], contract: "full" });
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

	it("waits event-first for every active descendant in a recursive subtree", async () => {
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

		let settled = false;
		const wait = graph.waitForDescendantsComplete(graph.rootTaskId).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		graph.interruptTask(child.id, "child-agent", "child runtime failed");
		await wait;
		expect(graph.hasActiveDescendants(graph.rootTaskId)).toBe(false);
	});

	it("durably defers a coordinator and exposes one resume only after all descendants are terminal", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "child-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent boundary",
			},
		});
		graph.startTask(child.id, "child-agent");

		const waiting = graph.deferUntilDescendantsComplete(graph.rootTaskId, "root-agent");
		expect(waiting).toMatchObject({
			state: "waiting",
			task: { status: "pending" },
			request: { reason: "descendants_terminal", status: "pending" },
		});
		expect(graph.getPendingResumeRequests()).toEqual([]);
		expect(graph.getSupervisionAlerts()).toContainEqual(
			expect.objectContaining({ taskId: graph.rootTaskId, kind: "waiting_for_descendants" }),
		);

		graph.completeTaskFromRuntime(child.id, "child-agent", "Reviewed a.ts");
		expect(graph.getPendingResumeRequests()).toHaveLength(1);
		expect(graph.getPendingResumeRequests()[0]).toMatchObject({
			taskId: graph.rootTaskId,
			reason: "descendants_terminal",
			gaps: [],
		});
		expect(graph.deferUntilDescendantsComplete(graph.rootTaskId, "root-agent")).toMatchObject({
			state: "ready",
			task: { status: "running", resumeRequest: { status: "admitted" } },
		});
		expect(graph.getPendingResumeRequests()).toEqual([]);
	});

	it("recovers a durable descendant wait and resumes after orphaned children are interrupted", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "child-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent boundary",
			},
		});
		graph.startTask(child.id, "child-agent");
		graph.deferUntilDescendantsComplete(graph.rootTaskId, "root-agent");

		const restored = AgentTaskGraph.open({
			directory: directory!,
			root: { ownerAgentId: "restored-root", objective: "Review the change" },
			policy: { requireExclusiveClaims: true },
		});

		expect(restored.getTask(child.id).status).toBe("interrupted");
		expect(restored.getTask(restored.rootTaskId)).toMatchObject({
			ownerAgentId: "restored-root",
			status: "pending",
			resumeRequest: { reason: "descendants_terminal", status: "pending" },
		});
		expect(restored.getPendingResumeRequests()).toEqual([
			expect.objectContaining({
				taskId: restored.rootTaskId,
				ownerAgentId: "restored-root",
				reason: "descendants_terminal",
			}),
		]);
	});

	it("cancels descendant waits and wakes them on fatal journal failure", async () => {
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
		const controller = new AbortController();
		const cancelled = graph.waitForDescendantsComplete(graph.rootTaskId, { signal: controller.signal });
		controller.abort();
		await expect(cancelled).rejects.toThrow("cancelled");

		const failed = graph.waitForDescendantsComplete(graph.rootTaskId);
		chmodSync(join(directory!, "task-graph.events.jsonl"), 0o400);
		expect(() => graph.updateProgress(child.id, "child-agent", { summary: "still working" })).toThrow(
			"journal write failed",
		);
		await expect(failed).rejects.toThrow("durability failed");
	});

	it("rejects unrelated supervision while granting the root global authority", () => {
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

	it("lets the nearest available ancestor supervise through a blocked parent", () => {
		directory = mkdtempSync(join(tmpdir(), "prime-task-graph-"));
		const graph = AgentTaskGraph.open({
			directory,
			root: {
				ownerAgentId: "root-agent",
				objective: "Review the change",
				exclusiveClaims: [claim("a.ts"), claim("b.ts"), claim("c.ts"), claim("d.ts")],
			},
			policy: { requireExclusiveClaims: true },
		});
		const ancestor = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "ancestor-agent",
			task: {
				objective: "Review subsystem",
				scope: "a.ts, b.ts, and c.ts",
				exclusiveClaims: [claim("a.ts"), claim("b.ts"), claim("c.ts")],
				delegationReason: "Independent subsystem",
			},
		});
		graph.startTask(ancestor.id, "ancestor-agent");
		const parent = graph.reserveDelegation({
			parentTaskId: ancestor.id,
			callerAgentId: "ancestor-agent",
			childAgentId: "parent-agent",
			task: {
				objective: "Review runtime",
				scope: "a.ts and b.ts",
				exclusiveClaims: [claim("a.ts"), claim("b.ts")],
				delegationReason: "Independent runtime boundary",
			},
		});
		graph.startTask(parent.id, "parent-agent");
		const leaf = graph.reserveDelegation({
			parentTaskId: parent.id,
			callerAgentId: "parent-agent",
			childAgentId: "leaf-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.startTask(leaf.id, "leaf-agent");

		graph.reportGap(parent.id, "parent-agent", { kind: "context", description: "Parent needs context" });
		admitPendingResume(graph, ancestor.id, "ancestor-agent");
		const leafGap = graph.reportGap(leaf.id, "leaf-agent", {
			kind: "dependency",
			description: "Leaf needs a dependency decision",
		});
		const supervision = admitPendingResume(graph, ancestor.id, "ancestor-agent");
		expect(supervision.supervisionAlerts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: parent.id, kind: "blocked_gap" }),
				expect.objectContaining({ taskId: leaf.id, gapId: leafGap.id, kind: "blocked_gap" }),
			]),
		);
		expect(
			graph.resolveGap(leaf.id, leafGap.id, "ancestor-agent", {
				status: "declined",
				resolution: "Proceed with the documented default",
			}).status,
		).toBe("declined");
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

	it("persists root rebinding through a journal-only graph patch", () => {
		const graph = open();
		graph.rebindRootAgent("rebound-root");

		const restored = AgentTaskGraph.open({
			directory: directory!,
			root: { ownerAgentId: "rebound-root", objective: "Review the change" },
			policy: { requireExclusiveClaims: true },
		});
		expect(restored.rootAgentId).toBe("rebound-root");
		expect(restored.getTask(restored.rootTaskId).ownerAgentId).toBe("rebound-root");
	});

	it("recovers pending and blocked tasks instead of stranding their claims", () => {
		const graph = open();
		const pending = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "pending-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent file",
			},
		});
		const blocked = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "blocked-agent",
			task: {
				objective: "Review b.ts",
				scope: "b.ts",
				exclusiveClaims: [claim("b.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.reportGap(blocked.id, "blocked-agent", { kind: "context", description: "Need generated data" });

		const restored = AgentTaskGraph.open({
			directory: directory!,
			root: { ownerAgentId: "restored-root", objective: "Review the change" },
			policy: { requireExclusiveClaims: true },
		});
		expect(restored.getTask(pending.id).status).toBe("interrupted");
		expect(restored.getTask(blocked.id).status).toBe("interrupted");
		expect(
			restored
				.getTask(restored.rootTaskId)
				.exclusiveClaims.map((item) => item.key)
				.sort(),
		).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("replays compact usage deltas and checkpoints them into the snapshot", () => {
		const graph = open();
		graph.recordUsage(graph.rootTaskId, { input: 10, output: 3, cacheRead: 4, cost: 0.25 }, "root-agent");
		expect(graph.getTotalUsage()).toEqual({
			input: 10,
			output: 3,
			cacheRead: 4,
			cacheWrite: 0,
			cost: 0.25,
		});
		const journal = readFileSync(join(directory!, "task-graph.events.jsonl"), "utf8");
		expect(journal).toContain('"usageDelta"');
		expect(journal).toContain('"tasks":[]');

		const restored = AgentTaskGraph.open({
			directory: directory!,
			root: { ownerAgentId: "root-agent", objective: "Review the change" },
			policy: { requireExclusiveClaims: true },
		});
		expect(restored.getTask(restored.rootTaskId).usage).toMatchObject({
			input: 10,
			output: 3,
			cacheRead: 4,
			cost: 0.25,
		});
		expect(restored.getTotalUsage()).toEqual(graph.getTotalUsage());
		restored.checkpoint();
		expect(readFileSync(join(directory!, "task-graph.events.jsonl"), "utf8")).toBe("");
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
		const supervision = admitPendingResume(graph, graph.rootTaskId, "root-agent");
		expect(supervision).toMatchObject({
			reason: "supervision_required",
			supervisionAlerts: [expect.objectContaining({ taskId: child.id, gapId: gap.id, kind: "blocked_gap" })],
		});
		expect(() => graph.completeTaskFromRuntime(child.id, "child-agent", "Cannot finish")).toThrow("open gaps");
		graph.resolveGap(child.id, gap.id, "root-agent", {
			status: "resolved",
			resolution: "Generated output is artifact://generated",
		});
		expect(graph.getTask(child.id).status).toBe("pending");
		const [resume] = graph.getPendingResumeRequests();
		expect(resume).toMatchObject({ taskId: child.id, ownerAgentId: "child-agent", gapIds: [gap.id] });
		graph.markResumeAdmitted(child.id, resume!.id, "child-agent");
		graph.completeTaskFromRuntime(child.id, "child-agent", "Verified");
		expect(() => graph.assertDelegatedTasksComplete()).not.toThrow();
	});

	it("creates one bounded resume epoch for each blocking cycle", () => {
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
		const first = graph.reportGap(child.id, "child-agent", { kind: "context", description: "Need first input" });
		admitPendingResume(graph, graph.rootTaskId, "root-agent");
		graph.resolveGap(child.id, first.id, "root-agent", { status: "resolved", resolution: "First input" });
		const firstResume = graph.getPendingResumeRequests()[0]!;
		expect(firstResume.gapIds).toEqual([first.id]);
		graph.markResumeAdmitted(child.id, firstResume.id, "child-agent");

		const second = graph.reportGap(child.id, "child-agent", { kind: "dependency", description: "Need second input" });
		admitPendingResume(graph, graph.rootTaskId, "root-agent");
		graph.resolveGap(child.id, second.id, "root-agent", { status: "declined", resolution: "Proceed without it" });
		const secondResume = graph.getPendingResumeRequests()[0]!;
		expect(secondResume.id).not.toBe(firstResume.id);
		expect(secondResume.gapIds).toEqual([second.id]);
		expect(secondResume.gaps.map((gap) => gap.id)).toEqual([second.id]);
	});

	it("coalesces a descendant supervision wake with the supervisor's pending gap resume", () => {
		const graph = open();
		const supervisor = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "supervisor-agent",
			task: {
				objective: "Review runtime",
				scope: "a.ts and b.ts",
				exclusiveClaims: [claim("a.ts"), claim("b.ts")],
				delegationReason: "Independent runtime boundary",
			},
		});
		graph.startTask(supervisor.id, "supervisor-agent");
		const leaf = graph.reserveDelegation({
			parentTaskId: supervisor.id,
			callerAgentId: "supervisor-agent",
			childAgentId: "leaf-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.startTask(leaf.id, "leaf-agent");

		const supervisorGap = graph.reportGap(supervisor.id, "supervisor-agent", {
			kind: "context",
			description: "Supervisor needs context",
		});
		admitPendingResume(graph, graph.rootTaskId, "root-agent");
		graph.resolveGap(supervisor.id, supervisorGap.id, "root-agent", {
			status: "resolved",
			resolution: "Context supplied",
		});
		const leafGap = graph.reportGap(leaf.id, "leaf-agent", {
			kind: "dependency",
			description: "Leaf needs a dependency decision",
		});

		const [resume] = graph.getPendingResumeRequests();
		expect(resume).toMatchObject({
			taskId: supervisor.id,
			reason: "supervision_required",
			gapIds: [supervisorGap.id],
			gaps: [expect.objectContaining({ id: supervisorGap.id, status: "resolved" })],
			supervisionAlerts: [expect.objectContaining({ taskId: leaf.id, gapId: leafGap.id })],
		});
	});

	it("preserves pending gap resumes across recovery and interrupts unrelated active work", () => {
		const graph = open();
		const resumable = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "resume-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent file",
			},
		});
		const unrelated = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "other-agent",
			task: {
				objective: "Review b.ts",
				scope: "b.ts",
				exclusiveClaims: [claim("b.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.startTask(resumable.id, "resume-agent");
		graph.startTask(unrelated.id, "other-agent");
		const gap = graph.reportGap(resumable.id, "resume-agent", { kind: "context", description: "Need context" });
		admitPendingResume(graph, graph.rootTaskId, "root-agent");
		graph.resolveGap(resumable.id, gap.id, "root-agent", { status: "resolved", resolution: "Context found" });
		graph.checkpoint();

		const restored = AgentTaskGraph.open({
			directory: directory!,
			root: { ownerAgentId: "restored-root", objective: "Review the change" },
			policy: { requireExclusiveClaims: true },
		});
		expect(restored.getTask(resumable.id).status).toBe("pending");
		expect(restored.getPendingResumeRequests()).toHaveLength(1);
		expect(restored.getTask(unrelated.id).status).toBe("interrupted");
	});

	it("preserves and retargets a root resume across checkpoint recovery", () => {
		const graph = open();
		const gap = graph.reportGap(graph.rootTaskId, "root-agent", {
			kind: "context",
			description: "Need deployment context",
		});
		graph.resolveGap(graph.rootTaskId, gap.id, "root-agent", {
			status: "resolved",
			resolution: "Deployment context found",
		});
		graph.checkpoint();

		const restored = AgentTaskGraph.open({
			directory: directory!,
			root: { ownerAgentId: "restored-root", objective: "Review the change" },
			policy: { requireExclusiveClaims: true },
		});
		const [resume] = restored.getPendingResumeRequests();
		expect(restored.getTask(restored.rootTaskId)).toMatchObject({
			status: "pending",
			ownerAgentId: "restored-root",
			resumeRequest: { ownerAgentId: "restored-root", status: "pending" },
		});
		expect(resume).toMatchObject({
			taskId: restored.rootTaskId,
			ownerAgentId: "restored-root",
			gapIds: [gap.id],
		});
	});

	it("bounds unstructured runtime conclusions without turning success into interruption", () => {
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
		const completed = graph.completeTaskFromRuntime(child.id, "child-agent", "x".repeat(8_000));
		expect(completed.status).toBe("completed");
		expect(completed.result?.summary.length).toBeLessThanOrEqual(4_000);
		expect(completed.result?.summary).toContain("[truncated by task runtime]");
	});

	it("revokes the previous actor immediately when a task is reassigned", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "old-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.reassignTask(child.id, "root-agent", "new-agent");
		expect(() => graph.updateProgress(child.id, "old-agent", { summary: "Still working" })).toThrow(
			"does not own task",
		);
		expect(graph.updateProgress(child.id, "new-agent", { summary: "Replacement working" }).ownerAgentId).toBe(
			"new-agent",
		);
	});

	it("retargets a pending resume when its task is reassigned", () => {
		const graph = open();
		const child = graph.reserveDelegation({
			parentTaskId: graph.rootTaskId,
			callerAgentId: "root-agent",
			childAgentId: "old-agent",
			task: {
				objective: "Review a.ts",
				scope: "a.ts",
				exclusiveClaims: [claim("a.ts")],
				delegationReason: "Independent file",
			},
		});
		graph.startTask(child.id, "old-agent");
		const gap = graph.reportGap(child.id, "old-agent", { kind: "context", description: "Need context" });
		admitPendingResume(graph, graph.rootTaskId, "root-agent");
		graph.resolveGap(child.id, gap.id, "root-agent", { status: "resolved", resolution: "Context found" });
		graph.reassignTask(child.id, "root-agent", "replacement-agent");
		const [resume] = graph.getPendingResumeRequests();
		expect(resume).toMatchObject({ taskId: child.id, ownerAgentId: "replacement-agent" });
		expect(() => graph.markResumeAdmitted(child.id, resume!.id, "old-agent")).toThrow("does not own task");
		graph.startTask(child.id, "replacement-agent");
		expect(graph.getTask(child.id)).toMatchObject({
			status: "running",
			resumeRequest: { id: resume!.id, ownerAgentId: "replacement-agent", status: "admitted" },
		});
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
		admitPendingResume(graph, graph.rootTaskId, "root-agent");
		graph.resolveGap(child.id, gap.id, "root-agent", { status: "resolved", resolution: "Found it" });
		graph.completeTaskFromRuntime(child.id, "child-agent", "No issue");
		expect(graph.getSupervisionAlerts()).toEqual(
			expect.arrayContaining([expect.objectContaining({ taskId: graph.rootTaskId, kind: "ready_for_synthesis" })]),
		);
	});
});
