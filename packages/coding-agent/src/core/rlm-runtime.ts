import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/index.js";
import type { HostRequestHandler } from "./kernel/index.js";

export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
	/** Source of the IPython cell that issued this rlm.run call, when available. */
	cellSourceCode?: string;
}

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
}

export type RlmSubagentRegistryStatus = "running" | "completed" | "error";

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmSubagentRegistryStatus;
}

export interface RlmListSubagentsResult {
	subagents: RlmSubagentRegistryEntry[];
}

export interface RlmDeleteSubagentResult {
	subagent: RlmSubagentRegistryEntry;
	outcome?: "deleted" | "skipped_running";
}

export interface RlmModelMatch {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export interface RlmFindModelsResult {
	models: RlmModelMatch[];
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<Record<string, unknown>>;
export type RlmListSubagentsHandler = () => RlmListSubagentsResult | Promise<RlmListSubagentsResult>;
export type RlmDeleteSubagentHandler = (target: string) => Promise<RlmDeleteSubagentResult>;
export type RlmFindModelsHandler = (query: string, limit: number) => RlmFindModelsResult | Promise<RlmFindModelsResult>;

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;

/** Validate and normalize an orchestrator-supplied subagent session name. */
export function normalizeRequestedRlmSubagentSessionName(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run name must be a string");
	}
	const name = value.trim();
	if (!name) {
		throw new Error("rlm.run name must not be empty");
	}
	if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`rlm.run name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

/** Validate and normalize an orchestrator-supplied subagent model reference. */
export function normalizeRequestedRlmSubagentModel(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run model must be a string");
	}
	const model = value.trim();
	if (!model) {
		throw new Error("rlm.run model must not be empty");
	}
	return model;
}

/** Create a readable, collision-resistant default name usable as an agent-message selector. */
export function createDefaultRlmSubagentSessionName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix =
		childId
			.replace(/^sub-/, "")
			.replace(/[^A-Za-z0-9]+/g, "")
			.slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findRlmModelMatches(query: string, models: Model<Api>[], limit: number): RlmModelMatch[] {
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models
		.map((model) => {
			const selector = `${model.provider}/${model.id}`;
			const fields = [selector, model.id, model.name || model.id];
			const normalizedFields = fields.map(normalizeModelSearchText);
			let score = normalizedQuery ? Number.POSITIVE_INFINITY : 0;
			if (normalizedQuery) {
				const exactIndex = normalizedFields.indexOf(normalizedQuery);
				const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
				const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
				if (exactIndex >= 0) score = exactIndex;
				else if (prefixIndex >= 0) score = 3 + prefixIndex;
				else if (partialIndex >= 0) score = 6 + partialIndex;
			}
			return { model, selector, score };
		})
		.filter((candidate) => Number.isFinite(candidate.score))
		.sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
		.slice(0, limit)
		.map(({ model, selector }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			selector,
		}));
}

/** Adapt an RlmRunHandler into the typed "rlm.run" handler for the kernel host bridge. */
export function createRlmRunHostHandler(handler: RlmRunHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.run prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
		const result = await handler({
			prompt: payload.prompt,
			kwargs,
			cellSourceCode,
		});
		return result as unknown as Record<string, unknown>;
	};
}

/** Search a bounded authenticated model catalog without adding it to the system prompt. */
export function createRlmFindModelsHostHandler(handler: RlmFindModelsHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.query !== "string") {
			throw new Error("rlm.find_models query must be a string");
		}
		const limit = payload.limit === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : payload.limit;
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RLM_MODEL_SEARCH_LIMIT) {
			throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`);
		}
		return { models: (await handler(payload.query, limit as number)).models };
	};
}

/** Expose the current parent session's RLM child registry to its kernel. */
export function createRlmListSubagentsHostHandler(handler: RlmListSubagentsHandler): HostRequestHandler {
	return async () => {
		const { subagents } = await handler();
		return { subagents };
	};
}

/** Delete one direct child selected from the current parent session's registry. */
export function createRlmDeleteSubagentHostHandler(handler: RlmDeleteSubagentHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.target !== "string" || !payload.target.trim()) {
			throw new Error("rlm.delete_subagent target must be a non-empty string");
		}
		const { subagent, outcome } = await handler(payload.target.trim());
		return outcome === undefined ? { subagent } : { subagent, outcome };
	};
}

export interface RlmSubagentRuntime {
	session: AgentSession;
}

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoals: boolean;
	includeCompactSkill: boolean;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
	/** Source of the IPython cell that spawned this subagent, for display. */
	spawnCode?: string;
	/** Publish the session to the parent before a host makes the runtime addressable. */
	onSessionPublished?: (session: AgentSession) => void;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	/** Persist host-owned completion before the child becomes passivation-eligible. */
	completeRlmSubagentRuntime?(childId: string, session: AgentSession): boolean;
	/** Release a host-owned child after its detached initial task settles. */
	releaseRlmSubagentRuntime?: (
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	/** Close or remove the host-owned child; session is absent when a persisted child is still passive. */
	deleteRlmSubagentRuntime(childId: string, session?: AgentSession): Promise<void>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}

export type RlmSubagentPolicyStatus = "creating" | "running" | "completed" | "error" | "cancelled" | "deleted";

export interface RlmSubagentPolicyEntry {
	id: string;
	sessionName: string;
	status: RlmSubagentPolicyStatus;
}

export interface RlmSubagentPolicySnapshot {
	activeChildren: number;
	totalChildren: number;
	children: readonly RlmSubagentPolicyEntry[];
}

export type RlmSubagentRuntimeOverrides = Partial<
	Pick<
		CreateRlmSubagentRuntimeOptions,
		| "model"
		| "thinkingLevel"
		| "serviceTier"
		| "scopedModels"
		| "activeToolNames"
		| "allowedToolNames"
		| "customTools"
		| "includeGoals"
		| "includeCompactSkill"
		| "rlmMaxDepth"
	>
>;

export interface RlmSubagentAdmissionRequest {
	options: Readonly<CreateRlmSubagentRuntimeOptions>;
	snapshot: RlmSubagentPolicySnapshot;
}

export type RlmSubagentAdmissionDecision =
	| { allowed: true; overrides?: RlmSubagentRuntimeOverrides }
	| { allowed: false; reason: string };

export type RlmSubagentAdmissionPolicy = (
	request: RlmSubagentAdmissionRequest,
) => RlmSubagentAdmissionDecision | Promise<RlmSubagentAdmissionDecision>;

export class RlmSubagentAdmissionError extends Error {
	constructor(readonly reason: string) {
		super(`RLM subagent admission denied: ${reason}`);
		this.name = "RlmSubagentAdmissionError";
	}
}

/**
 * Decorate a runtime host with an embedding-owned, workflow-agnostic admission
 * policy. Admission and reservation are serialized so concurrent spawns see a
 * consistent active-child count. The delegate retains ownership of runtimes.
 */
export class PolicyControlledSubagentRuntimeHost implements SubagentRuntimeHost {
	private readonly children = new Map<string, RlmSubagentPolicyEntry>();
	private admissionTail = Promise.resolve();

	constructor(
		private readonly delegate: SubagentRuntimeHost,
		private readonly policy: RlmSubagentAdmissionPolicy,
	) {}

	getSnapshot(): RlmSubagentPolicySnapshot {
		const children = [...this.children.values()].map((entry) => ({ ...entry }));
		return {
			activeChildren: children.filter((entry) => entry.status === "creating" || entry.status === "running").length,
			totalChildren: children.length,
			children,
		};
	}

	async createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime> {
		const admittedOptions = await this.reserve(options);
		try {
			const runtime = await this.delegate.createRlmSubagentRuntime(admittedOptions);
			this.update(admittedOptions.id, { status: "running" });
			return runtime;
		} catch (error) {
			this.update(admittedOptions.id, { status: "error" });
			throw error;
		}
	}

	completeRlmSubagentRuntime(childId: string, session: AgentSession): boolean {
		const completed = this.delegate.completeRlmSubagentRuntime?.(childId, session);
		if (completed !== false) this.update(childId, { status: "completed" });
		return completed ?? true;
	}

	async releaseRlmSubagentRuntime(
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	): Promise<void> {
		await this.delegate.releaseRlmSubagentRuntime?.(runtime, options, status);
		this.update(options.id, { status: status === "done" ? "completed" : status });
	}

	async deleteRlmSubagentRuntime(childId: string, session?: AgentSession): Promise<void> {
		await this.delegate.deleteRlmSubagentRuntime(childId, session);
		this.update(childId, { status: "deleted" });
	}

	async disposeRlmSubagentRuntimes(): Promise<void> {
		await this.delegate.disposeRlmSubagentRuntimes?.();
		for (const childId of this.children.keys()) this.update(childId, { status: "deleted" });
	}

	private async reserve(options: CreateRlmSubagentRuntimeOptions): Promise<CreateRlmSubagentRuntimeOptions> {
		let releaseAdmission: (() => void) | undefined;
		const previousAdmission = this.admissionTail;
		this.admissionTail = new Promise<void>((resolve) => {
			releaseAdmission = resolve;
		});
		await previousAdmission;
		try {
			if (this.children.has(options.id)) {
				throw new RlmSubagentAdmissionError(`child id is already registered: ${options.id}`);
			}
			const decision = await this.policy({ options, snapshot: this.getSnapshot() });
			if (!decision.allowed) throw new RlmSubagentAdmissionError(decision.reason);
			const admittedOptions = { ...options, ...decision.overrides };
			this.children.set(options.id, {
				id: options.id,
				sessionName: options.sessionName,
				status: "creating",
			});
			return admittedOptions;
		} finally {
			releaseAdmission?.();
		}
	}

	private update(childId: string, update: Partial<RlmSubagentPolicyEntry>): void {
		const current = this.children.get(childId);
		if (current) this.children.set(childId, { ...current, ...update });
	}
}

export function createPolicyControlledSubagentRuntimeHost(
	delegate: SubagentRuntimeHost,
	policy: RlmSubagentAdmissionPolicy,
): PolicyControlledSubagentRuntimeHost {
	return new PolicyControlledSubagentRuntimeHost(delegate, policy);
}
