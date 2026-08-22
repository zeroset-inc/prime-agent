import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_CUSTOM_TYPE, type AgentSessionMessage } from "../../../src/core/agent-messages.js";
import { createHarness, type Harness } from "../harness.js";

function terminalMessage(messages: readonly unknown[]): AgentSessionMessage | undefined {
	return messages.find(
		(message): message is AgentSessionMessage =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			"customType" in message &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === AGENT_MESSAGE_CUSTOM_TYPE,
	);
}

describe("#617 subagent terminal agent messages", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	it("delivers a child completion without a reply as an attributed agent message", async () => {
		const childSessionName = "terminal-worker";
		const sendAgentMessage = vi.fn(() => new Promise<never>(() => {}));
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage,
			},
		});
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		child.setResponses([fauxAssistantMessage("child completed")]);

		const spawned = await parent.session.runRlmChild("finish without replying", { name: childSessionName });

		await expect
			.poll(() => terminalMessage(parent!.session.messages))
			.toMatchObject({
				customType: AGENT_MESSAGE_CUSTOM_TYPE,
				details: {
					id: expect.stringMatching(/^agentmsg_/),
					fromRelationship: "child",
					from: { sessionId: child.session.sessionId, sessionName: childSessionName },
				},
				content: expect.stringContaining(`[from child:${childSessionName}]`),
			});
		expect(parent.session.messages).not.toContainEqual(
			expect.objectContaining({ customType: "rlm_child_terminal_notice" }),
		);
		expect(terminalMessage(parent.session.messages)?.content).toContain(spawned.rlm_child_id);
		expect(sendAgentMessage).not.toHaveBeenCalled();
	});
	it("does not depend on child message transport for attributed delivery", async () => {
		const sendAgentMessage = vi.fn(async () => {
			throw new Error("delivery unavailable");
		});
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage,
			},
		});
		parent = await createHarness({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			} as never,
		});
		child.setResponses([fauxAssistantMessage("done, no reply to parent")]);
		parent.setResponses([fauxAssistantMessage("parent ack")]);

		await parent.session.runRlmChild("do the work");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(terminalMessage(parent.session.messages)?.content).toContain("completed without sending a reply");
		expect(sendAgentMessage).not.toHaveBeenCalled();
	}, 60_000);
});
