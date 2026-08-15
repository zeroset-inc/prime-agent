import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createPolicyControlledSubagentRuntimeHost,
	RlmSubagentCapacityPool,
	type RlmSubagentRuntime,
	type SubagentRuntimeHost,
} from "../src/core/rlm-runtime.js";

function options(id: string): CreateRlmSubagentRuntimeOptions {
	return {
		id,
		sessionName: id,
		thinkingLevel: "medium",
	} as CreateRlmSubagentRuntimeOptions;
}

function runtime(): RlmSubagentRuntime {
	return { session: {} as AgentSession };
}

describe("policy-controlled RLM subagent runtime host", () => {
	it("serializes admission and rejects concurrent work beyond policy capacity", async () => {
		let finishCreate: ((value: RlmSubagentRuntime) => void) | undefined;
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(
				() =>
					new Promise<RlmSubagentRuntime>((resolve) => {
						finishCreate = resolve;
					}),
			),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
		};
		const host = createPolicyControlledSubagentRuntimeHost(delegate, ({ snapshot }) =>
			snapshot.activeChildren < 1 ? { allowed: true } : { allowed: false, reason: "wave capacity reached" },
		);

		const first = host.createRlmSubagentRuntime(options("first"));
		await vi.waitFor(() => expect(delegate.createRlmSubagentRuntime).toHaveBeenCalledTimes(1));
		await expect(host.createRlmSubagentRuntime(options("second"))).rejects.toEqual(
			expect.objectContaining({
				name: "RlmSubagentAdmissionError",
				reason: "wave capacity reached",
			}),
		);
		expect(host.getSnapshot()).toMatchObject({ activeChildren: 1, totalChildren: 1 });

		finishCreate?.(runtime());
		await first;
		expect(host.getSnapshot().children[0]?.status).toBe("running");
	});

	it("applies admitted overrides and tracks lifecycle transitions", async () => {
		const child = runtime();
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(async () => child),
			completeRlmSubagentRuntime: vi.fn(() => true),
			releaseRlmSubagentRuntime: vi.fn(async () => undefined),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
			disposeRlmSubagentRuntimes: vi.fn(async () => undefined),
		};
		const host = createPolicyControlledSubagentRuntimeHost(delegate, () => ({
			allowed: true,
			overrides: { thinkingLevel: "high", rlmMaxDepth: 1 },
		}));

		await host.createRlmSubagentRuntime(options("child"));
		expect(delegate.createRlmSubagentRuntime).toHaveBeenCalledWith(
			expect.objectContaining({ thinkingLevel: "high", rlmMaxDepth: 1 }),
		);
		expect(host.completeRlmSubagentRuntime("child", child.session)).toBe(true);
		expect(host.getSnapshot().children[0]?.status).toBe("completed");

		await host.releaseRlmSubagentRuntime(child, options("child"), "cancelled");
		expect(host.getSnapshot().children[0]?.status).toBe("cancelled");
		await host.deleteRlmSubagentRuntime("child", child.session);
		expect(host.getSnapshot()).toMatchObject({ activeChildren: 0, totalChildren: 1 });
		expect(host.getSnapshot().children[0]?.status).toBe("deleted");
	});

	it("does not complete a child when the delegate refuses completion", async () => {
		const child = runtime();
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(async () => child),
			completeRlmSubagentRuntime: vi.fn(() => false),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
		};
		const host = createPolicyControlledSubagentRuntimeHost(delegate, () => ({ allowed: true }));

		await host.createRlmSubagentRuntime(options("child"));
		expect(host.completeRlmSubagentRuntime("child", child.session)).toBe(false);
		expect(host.getSnapshot().children[0]?.status).toBe("running");
	});

	it("queues excess execution capacity and admits it after release without a total-child cap", async () => {
		const releases = new Map<string, (runtime: RlmSubagentRuntime) => void>();
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(
				(childOptions) =>
					new Promise<RlmSubagentRuntime>((resolve) => {
						releases.set(childOptions.id, resolve);
					}),
			),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
		};
		const host = createPolicyControlledSubagentRuntimeHost(delegate, () => ({ allowed: true }), {
			maxConcurrentChildren: 1,
		});

		const first = host.createRlmSubagentRuntime(options("first"));
		await vi.waitFor(() => expect(delegate.createRlmSubagentRuntime).toHaveBeenCalledTimes(1));
		const second = host.createRlmSubagentRuntime(options("second"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(delegate.createRlmSubagentRuntime).toHaveBeenCalledTimes(1);
		expect(host.getSnapshot()).toMatchObject({
			activeChildren: 1,
			totalChildren: 2,
			children: expect.arrayContaining([expect.objectContaining({ id: "second", status: "queued" })]),
		});

		releases.get("first")?.(runtime());
		const firstRuntime = await first;
		host.completeRlmSubagentRuntime("first", firstRuntime.session);
		await vi.waitFor(() => expect(delegate.createRlmSubagentRuntime).toHaveBeenCalledTimes(2));
		releases.get("second")?.(runtime());
		await second;
	});

	it("cancels queued children without consuming capacity", async () => {
		let finishFirst: ((runtime: RlmSubagentRuntime) => void) | undefined;
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(
				(childOptions) =>
					new Promise<RlmSubagentRuntime>((resolve) => {
						if (childOptions.id === "first") finishFirst = resolve;
					}),
			),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
		};
		const host = createPolicyControlledSubagentRuntimeHost(delegate, () => ({ allowed: true }), {
			maxConcurrentChildren: 1,
		});
		const first = host.createRlmSubagentRuntime(options("first"));
		await vi.waitFor(() => expect(delegate.createRlmSubagentRuntime).toHaveBeenCalledTimes(1));
		const abortController = new AbortController();
		const queuedOptions = { ...options("queued"), signal: abortController.signal };
		const queued = host.createRlmSubagentRuntime(queuedOptions);
		abortController.abort();
		await expect(queued).rejects.toThrow("cancelled while queued");
		expect(host.getSnapshot().children.find((child) => child.id === "queued")?.status).toBe("cancelled");

		finishFirst?.(runtime());
		await first;
	});

	it("shares FIFO execution capacity across independent recursive parents", async () => {
		const calls: string[] = [];
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(async (childOptions) => {
				calls.push(childOptions.id);
				return runtime();
			}),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
		};
		const capacityPool = new RlmSubagentCapacityPool(1);
		const firstParent = createPolicyControlledSubagentRuntimeHost(delegate, () => ({ allowed: true }), {
			capacityPool,
		});
		const secondParent = createPolicyControlledSubagentRuntimeHost(delegate, () => ({ allowed: true }), {
			capacityPool,
		});

		const firstRuntime = await firstParent.createRlmSubagentRuntime(options("first-parent-child"));
		const queued = secondParent.createRlmSubagentRuntime(options("second-parent-child"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toEqual(["first-parent-child"]);

		firstParent.completeRlmSubagentRuntime("first-parent-child", firstRuntime.session);
		await queued;
		expect(calls).toEqual(["first-parent-child", "second-parent-child"]);
	});
});
