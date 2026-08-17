import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_TASK_GRAPH_SCHEMA_VERSION = 1;
export const AGENT_TASK_TEXT_MAX_LENGTH = 4_000;
export const AGENT_TASK_LIST_MAX_ITEMS = 256;
export const AGENT_TASK_CLAIM_MAX_ITEMS = 5_000;
export const AGENT_TASK_RESULT_MAX_BYTES = 64 * 1024;
export const AGENT_TASK_SNAPSHOT_PAGE_MAX_ITEMS = 100;
export const AGENT_TASK_SNAPSHOT_COMPACT_EVENT_THRESHOLD = 128;
export const AGENT_TASK_SNAPSHOT_COMPACT_BYTE_THRESHOLD = 512 * 1024;

export type AgentTaskStatus =
	| "pending"
	| "starting"
	| "running"
	| "blocked"
	| "completed"
	| "cancelled"
	| "interrupted";

export type AgentTaskDelegationState = "retained" | "partially_delegated" | "fully_delegated";

export interface AgentTaskResourceClaim {
	namespace: string;
	key: string;
	metadata?: Record<string, unknown>;
}

export interface AgentTaskContextEnvelope {
	rootObjective: string;
	rootContext?: Record<string, unknown>;
	rootContextDescriptor?: AgentTaskRootContextDescriptor;
	taskId: string;
	parentTaskId?: string;
	lineage: string[];
	scope: string;
	exclusiveClaims: AgentTaskResourceClaim[];
	sharedClaims: AgentTaskResourceClaim[];
	exclusions: AgentTaskResourceClaim[];
	questions: string[];
	invariants: string[];
	knownDecisions: string[];
	dependencies: string[];
	evidenceRefs: string[];
	unresolvedQuestions: string[];
	verificationExpectations: string[];
	resultSchema?: Record<string, unknown>;
	version: number;
}

export interface AgentTaskRootContextDescriptor {
	sha256: string;
	byteLength: number;
}

export interface AgentTaskGraphHealth {
	status: "healthy" | "degraded" | "failed";
	error?: string;
}

export interface AgentTaskProgress {
	summary: string;
	evidenceRefs: string[];
	completedQuestions: string[];
	updatedAt: string;
}

export interface AgentTaskResult {
	summary: string;
	verification: unknown[];
	candidateFindings: unknown[];
	unresolvedQuestions: string[];
	coverageGaps: unknown[];
	evidenceRefs: string[];
	data?: Record<string, unknown>;
}

export interface AgentTaskGap {
	id: string;
	kind: "coverage" | "context" | "dependency" | "other";
	description: string;
	neededInformation?: string;
	status: "open" | "resolved" | "declined";
	reportedByAgentId: string;
	resolution?: string;
	evidenceRefs: string[];
	createdAt: string;
	updatedAt: string;
}

export interface AgentTaskResumeRequest {
	id: string;
	taskId: string;
	ownerAgentId: string;
	gapIds: string[];
	gapCount: number;
	status: "pending" | "admitted";
	requestedAt: string;
	admittedAt?: string;
}

export interface AgentTaskResumeDispatch extends AgentTaskResumeRequest {
	gaps: AgentTaskGap[];
	context: AgentTaskContextEnvelope;
}

export interface AgentTaskUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface AgentTask {
	id: string;
	parentTaskId?: string;
	createdByAgentId: string;
	ownerAgentId: string;
	objective: string;
	scope: string;
	exclusiveClaims: AgentTaskResourceClaim[];
	sharedClaims: AgentTaskResourceClaim[];
	exclusions: AgentTaskResourceClaim[];
	questions: string[];
	invariants: string[];
	knownDecisions: string[];
	dependencies: string[];
	verificationExpectations: string[];
	resultSchema?: Record<string, unknown>;
	delegationReason?: string;
	status: AgentTaskStatus;
	delegationState: AgentTaskDelegationState;
	progress?: AgentTaskProgress;
	result?: AgentTaskResult;
	gaps: AgentTaskGap[];
	resumeRequest?: AgentTaskResumeRequest;
	usage: AgentTaskUsage;
	childAgentId?: string;
	reclaimedAt?: string;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface AgentTaskGraphSnapshot {
	schemaVersion: typeof AGENT_TASK_GRAPH_SCHEMA_VERSION;
	graphId: string;
	rootTaskId: string;
	rootAgentId: string;
	rootContext?: Record<string, unknown>;
	inheritedContext?: Record<string, unknown>;
	version: number;
	tasks: AgentTask[];
}

export interface AgentTaskGraphPage {
	graphId: string;
	rootTaskId: string;
	rootAgentId: string;
	version: number;
	totalTasks: number;
	offset: number;
	tasks: AgentTask[];
}

export interface AgentTaskSupervisionAlert {
	taskId: string;
	ownerAgentId: string;
	kind: "blocked_gap" | "resume_pending" | "stalled" | "ready_for_synthesis" | "reported_uncertainty";
	message: string;
	directParentTaskId?: string;
	ageMs?: number;
}

export interface AgentTaskRootInput {
	id?: string;
	ownerAgentId: string;
	objective: string;
	scope?: string;
	exclusiveClaims?: AgentTaskResourceClaim[];
	sharedClaims?: AgentTaskResourceClaim[];
	exclusions?: AgentTaskResourceClaim[];
	questions?: string[];
	invariants?: string[];
	knownDecisions?: string[];
	dependencies?: string[];
	verificationExpectations?: string[];
	resultSchema?: Record<string, unknown>;
	rootContext?: Record<string, unknown>;
	/** Bounded root-context projection inherited by every descendant prompt. */
	inheritedContext?: Record<string, unknown>;
}

export interface AgentTaskDelegationInput {
	id?: string;
	objective: string;
	scope: string;
	exclusiveClaims?: AgentTaskResourceClaim[];
	sharedClaims?: AgentTaskResourceClaim[];
	exclusions?: AgentTaskResourceClaim[];
	questions?: string[];
	invariants?: string[];
	knownDecisions?: string[];
	dependencies?: string[];
	verificationExpectations?: string[];
	resultSchema?: Record<string, unknown>;
	delegationReason: string;
}

export interface AgentTaskDelegationValidationRequest {
	parent: Readonly<AgentTask>;
	child: Readonly<AgentTaskDelegationInput>;
	snapshot: Readonly<AgentTaskGraphSnapshot>;
}

export interface AgentTaskCompletionValidationRequest {
	task: Readonly<AgentTask>;
	result: Readonly<AgentTaskResult>;
	snapshot: Readonly<AgentTaskGraphSnapshot>;
}

export interface AgentTaskGraphPolicy {
	requireExclusiveClaims?: boolean;
	validateDelegation?: (request: AgentTaskDelegationValidationRequest) => void;
	validateCompletion?: (request: AgentTaskCompletionValidationRequest) => void;
}

export interface OpenAgentTaskGraphOptions {
	directory: string;
	root: AgentTaskRootInput;
	policy?: AgentTaskGraphPolicy;
}

interface AgentTaskGraphEvent {
	schemaVersion: typeof AGENT_TASK_GRAPH_SCHEMA_VERSION;
	graphId: string;
	graphVersion: number;
	type: string;
	actorAgentId: string;
	taskIds: string[];
	tasks: AgentTask[];
	rootAgentId?: string;
	usageDelta?: { taskId: string; usage: AgentTaskUsage; taskVersion: number; updatedAt: string };
	at: string;
}

const ACTIVE_TASK_STATUSES = new Set<AgentTaskStatus>(["pending", "starting", "running", "blocked"]);

export class AgentTaskGraphError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentTaskGraphError";
	}
}

export class AgentTaskGraph {
	private readonly snapshotPath: string;
	private readonly eventsPath: string;
	private readonly policy: AgentTaskGraphPolicy;
	private state: AgentTaskGraphSnapshot;
	private eventsSinceSnapshot = 0;
	private bytesSinceSnapshot = 0;
	private degradedError?: Error;
	private fatalError?: Error;
	private readonly changeWaiters = new Set<() => void>();

	private constructor(options: OpenAgentTaskGraphOptions) {
		this.policy = options.policy ?? {};
		mkdirSync(options.directory, { recursive: true, mode: 0o700 });
		this.snapshotPath = join(options.directory, "task-graph.snapshot.json");
		this.eventsPath = join(options.directory, "task-graph.events.jsonl");
		this.state = this.loadOrCreate(options.root);
		this.recover(options.root.ownerAgentId);
	}

	static open(options: OpenAgentTaskGraphOptions): AgentTaskGraph {
		return new AgentTaskGraph(options);
	}

	get rootTaskId(): string {
		return this.state.rootTaskId;
	}

	get rootAgentId(): string {
		return this.state.rootAgentId;
	}

	get version(): number {
		return this.state.version;
	}

	getHealth(): AgentTaskGraphHealth {
		if (this.fatalError) return { status: "failed", error: this.fatalError.message };
		if (this.degradedError) return { status: "degraded", error: this.degradedError.message };
		return { status: "healthy" };
	}

	/** Persist a compact recovery point and rotate journal entries already represented by it. */
	checkpoint(): void {
		this.assertWritable();
		this.compactSnapshot(true);
	}

	rebindRootAgent(ownerAgentId: string): AgentTask {
		const normalizedOwner = normalizeIdentifier(ownerAgentId, "ownerAgentId");
		const root = this.findTask(this.state.rootTaskId);
		if (
			this.state.rootAgentId === normalizedOwner &&
			root.ownerAgentId === normalizedOwner &&
			(!root.resumeRequest || root.resumeRequest.ownerAgentId === normalizedOwner)
		)
			return clone(root);
		const next = touchTask({
			...root,
			ownerAgentId: normalizedOwner,
			...(root.resumeRequest ? { resumeRequest: { ...root.resumeRequest, ownerAgentId: normalizedOwner } } : {}),
		});
		this.commit("graph.root_rebound", normalizedOwner, [next], { rootAgentId: normalizedOwner });
		return clone(next);
	}

	getTask(taskId: string): AgentTask {
		const task = this.findTask(taskId);
		return clone(task);
	}

	getCurrentTask(taskId: string, callerAgentId: string): AgentTask {
		const task = this.findTask(taskId);
		if (task.ownerAgentId !== callerAgentId && callerAgentId !== this.state.rootAgentId) {
			throw new AgentTaskGraphError(`agent ${callerAgentId} does not own task ${taskId}`);
		}
		return clone(task);
	}

	getSnapshot(options: { offset?: number; limit?: number } = {}): AgentTaskGraphPage {
		const offset = normalizeNonNegativeInteger(options.offset ?? 0, "offset");
		const limit = normalizeIntegerInRange(
			options.limit ?? AGENT_TASK_SNAPSHOT_PAGE_MAX_ITEMS,
			"limit",
			1,
			AGENT_TASK_SNAPSHOT_PAGE_MAX_ITEMS,
		);
		const tasks = [...this.state.tasks].sort(compareTasks);
		return {
			graphId: this.state.graphId,
			rootTaskId: this.state.rootTaskId,
			rootAgentId: this.state.rootAgentId,
			version: this.state.version,
			totalTasks: tasks.length,
			offset,
			tasks: clone(tasks.slice(offset, offset + limit)),
		};
	}

	getSupervisionAlerts(options: { now?: number; stallAfterMs?: number } = {}): AgentTaskSupervisionAlert[] {
		const now = options.now ?? Date.now();
		const stallAfterMs = normalizeIntegerInRange(
			options.stallAfterMs ?? 5 * 60_000,
			"stallAfterMs",
			1_000,
			24 * 60 * 60_000,
		);
		const alerts: AgentTaskSupervisionAlert[] = [];
		for (const task of this.state.tasks) {
			const parent = task.parentTaskId ? this.findTask(task.parentTaskId) : undefined;
			if (task.status === "pending" && task.resumeRequest?.status === "pending") {
				alerts.push({
					taskId: task.id,
					ownerAgentId: task.ownerAgentId,
					kind: "resume_pending",
					message: "Resolved task gap is waiting for its owner runtime to admit a follow-up turn",
					...(parent ? { directParentTaskId: parent.id } : {}),
				});
			}
			for (const gap of task.gaps.filter((candidate) => candidate.status === "open")) {
				alerts.push({
					taskId: task.id,
					ownerAgentId: task.ownerAgentId,
					kind: "blocked_gap",
					message: gap.description,
					...(parent ? { directParentTaskId: parent.id } : {}),
				});
			}
			if (task.status === "running") {
				const lastActivity = Date.parse(task.progress?.updatedAt ?? task.updatedAt);
				const ageMs = Number.isFinite(lastActivity) ? Math.max(0, now - lastActivity) : stallAfterMs;
				if (ageMs >= stallAfterMs) {
					alerts.push({
						taskId: task.id,
						ownerAgentId: task.ownerAgentId,
						kind: "stalled",
						message: `No durable task progress for ${ageMs}ms`,
						...(parent ? { directParentTaskId: parent.id } : {}),
						ageMs,
					});
				}
				const children = this.childrenOf(task.id);
				if (
					task.delegationState !== "retained" &&
					children.length > 0 &&
					children.every((child) => !ACTIVE_TASK_STATUSES.has(child.status))
				) {
					alerts.push({
						taskId: task.id,
						ownerAgentId: task.ownerAgentId,
						kind: "ready_for_synthesis",
						message: "All delegated child tasks are terminal; synthesize their results and finish this task",
						...(parent ? { directParentTaskId: parent.id } : {}),
					});
				}
			}
			if (
				task.status === "completed" &&
				((task.result?.unresolvedQuestions.length ?? 0) > 0 || (task.result?.coverageGaps.length ?? 0) > 0)
			) {
				alerts.push({
					taskId: task.id,
					ownerAgentId: task.ownerAgentId,
					kind: "reported_uncertainty",
					message: "Completed task reported unresolved questions or coverage gaps",
					...(parent ? { directParentTaskId: parent.id } : {}),
				});
			}
		}
		return alerts;
	}

	contextEnvelope(taskId: string): AgentTaskContextEnvelope {
		const task = this.findTask(taskId);
		const root = this.findTask(this.state.rootTaskId);
		return {
			rootObjective: root.objective,
			...(this.state.inheritedContext
				? { rootContext: clone(this.state.inheritedContext) }
				: this.state.rootContext
					? { rootContext: clone(this.state.rootContext) }
					: {}),
			...(this.state.rootContext ? { rootContextDescriptor: rootContextDescriptor(this.state.rootContext) } : {}),
			taskId: task.id,
			...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
			lineage: this.lineage(task.id),
			scope: task.scope,
			exclusiveClaims: clone(task.exclusiveClaims),
			sharedClaims: clone(task.sharedClaims),
			exclusions: clone(task.exclusions),
			questions: [...task.questions],
			invariants: [...task.invariants],
			knownDecisions: [...task.knownDecisions],
			dependencies: [...task.dependencies],
			evidenceRefs: [...(task.progress?.evidenceRefs ?? [])],
			unresolvedQuestions: [...(task.result?.unresolvedQuestions ?? [])],
			verificationExpectations: [...task.verificationExpectations],
			...(task.resultSchema ? { resultSchema: clone(task.resultSchema) } : {}),
			version: task.version,
		};
	}

	getRootContext(): Record<string, unknown> | undefined {
		return this.state.rootContext ? clone(this.state.rootContext) : undefined;
	}

	getPendingResumeRequests(): AgentTaskResumeDispatch[] {
		return this.state.tasks.flatMap((task) => {
			const request = task.resumeRequest;
			if (task.status !== "pending" || request?.status !== "pending") return [];
			return [
				{
					...clone(request),
					ownerAgentId: task.ownerAgentId,
					gaps: clone(task.gaps.filter((gap) => request.gapIds.includes(gap.id))),
					context: this.contextEnvelope(task.id),
				},
			];
		});
	}

	reserveDelegation(input: {
		parentTaskId: string;
		callerAgentId: string;
		childAgentId: string;
		task: AgentTaskDelegationInput;
	}): AgentTask {
		const parent = this.findTask(input.parentTaskId);
		this.assertOwner(parent, input.callerAgentId);
		this.assertActive(parent, "delegate from");
		const normalized = normalizeDelegationInput(input.task);
		if (!isMeaningfullyNarrower(parent, normalized)) {
			throw new AgentTaskGraphError("delegated task must be meaningfully narrower than its parent task");
		}
		const exclusiveClaims = normalized.exclusiveClaims ?? [];
		if (this.policy.requireExclusiveClaims && exclusiveClaims.length === 0) {
			throw new AgentTaskGraphError("delegated task must transfer at least one exclusive claim");
		}
		for (const claim of exclusiveClaims) {
			if (!parent.exclusiveClaims.some((candidate) => sameClaim(candidate, claim))) {
				throw new AgentTaskGraphError(`parent task does not own exclusive claim ${claimKey(claim)}`);
			}
		}
		for (const claim of normalized.sharedClaims ?? []) {
			if (
				!parent.exclusiveClaims.some((candidate) => sameClaim(candidate, claim)) &&
				!parent.sharedClaims.some((candidate) => sameClaim(candidate, claim))
			) {
				throw new AgentTaskGraphError(`parent task cannot grant shared claim ${claimKey(claim)}`);
			}
		}
		for (const claim of exclusiveClaims) {
			const conflicting = this.state.tasks.find(
				(candidate) =>
					candidate.id !== parent.id &&
					ACTIVE_TASK_STATUSES.has(candidate.status) &&
					candidate.exclusiveClaims.some((owned) => sameClaim(owned, claim)),
			);
			if (conflicting) {
				throw new AgentTaskGraphError(
					`exclusive claim ${claimKey(claim)} is already owned by task ${conflicting.id}`,
				);
			}
		}
		const childId = normalizeIdentifier(normalized.id ?? `task-${randomUUID()}`, "task.id");
		if (this.state.tasks.some((task) => task.id === childId)) {
			throw new AgentTaskGraphError(`task id already exists: ${childId}`);
		}
		const signature = delegationSignature(parent.id, normalized);
		const duplicate = this.state.tasks.find(
			(task) =>
				task.parentTaskId === parent.id &&
				ACTIVE_TASK_STATUSES.has(task.status) &&
				taskSignature(task) === signature,
		);
		if (duplicate)
			throw new AgentTaskGraphError(`substantially identical delegated task already exists: ${duplicate.id}`);
		this.policy.validateDelegation?.({
			parent: clone(parent),
			child: clone(normalized),
			snapshot: clone(this.state),
		});

		const now = new Date().toISOString();
		const child: AgentTask = {
			id: childId,
			parentTaskId: parent.id,
			createdByAgentId: input.callerAgentId,
			ownerAgentId: normalizeIdentifier(input.childAgentId, "childAgentId"),
			objective: normalized.objective,
			scope: normalized.scope,
			exclusiveClaims: clone(exclusiveClaims),
			sharedClaims: clone(normalized.sharedClaims ?? []),
			exclusions: clone(normalized.exclusions ?? []),
			questions: [...normalized.questions],
			invariants: [...normalized.invariants],
			knownDecisions: [...normalized.knownDecisions],
			dependencies: [...normalized.dependencies],
			verificationExpectations: [...normalized.verificationExpectations],
			...(normalized.resultSchema ? { resultSchema: clone(normalized.resultSchema) } : {}),
			delegationReason: normalized.delegationReason,
			status: "pending",
			delegationState: "retained",
			gaps: [],
			usage: emptyUsage(),
			childAgentId: input.childAgentId,
			version: 1,
			createdAt: now,
			updatedAt: now,
		};
		const nextParent = touchTask({
			...parent,
			exclusiveClaims: parent.exclusiveClaims.filter(
				(claim) => !exclusiveClaims.some((transferred) => sameClaim(claim, transferred)),
			),
		});
		nextParent.delegationState = nextParent.exclusiveClaims.length === 0 ? "fully_delegated" : "partially_delegated";
		this.commit("task.delegated", input.callerAgentId, [nextParent, child]);
		return clone(child);
	}

	startTask(taskId: string, callerAgentId: string): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		if (task.status !== "pending" && task.status !== "starting") {
			throw new AgentTaskGraphError(`task ${taskId} cannot start from status ${task.status}`);
		}
		const next = touchTask({
			...task,
			status: "running",
			...(task.resumeRequest?.status === "pending"
				? {
						resumeRequest: {
							...task.resumeRequest,
							status: "admitted" as const,
							admittedAt: new Date().toISOString(),
						},
					}
				: {}),
		});
		this.commit("task.started", callerAgentId, [next]);
		return clone(next);
	}

	markResumeAdmitted(taskId: string, requestId: string, callerAgentId: string): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		const request = task.resumeRequest;
		if (!request || request.id !== requestId) {
			throw new AgentTaskGraphError(`unknown resume request ${requestId} for task ${taskId}`);
		}
		if (request.status === "admitted") return clone(task);
		if (task.status !== "pending") {
			throw new AgentTaskGraphError(`task ${taskId} cannot admit a resume from status ${task.status}`);
		}
		const next = touchTask({
			...task,
			status: "running",
			resumeRequest: {
				...request,
				status: "admitted",
				admittedAt: new Date().toISOString(),
			},
		});
		this.commit("task.resume_admitted", callerAgentId, [next]);
		return clone(next);
	}

	updateProgress(
		taskId: string,
		callerAgentId: string,
		progress: { summary: string; evidenceRefs?: string[]; completedQuestions?: string[] },
	): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "update");
		const now = new Date().toISOString();
		const next = touchTask({
			...task,
			status: task.status === "pending" || task.status === "starting" ? "running" : task.status,
			progress: {
				summary: normalizeText(progress.summary, "progress.summary"),
				evidenceRefs: normalizeStringList(progress.evidenceRefs ?? [], "progress.evidenceRefs"),
				completedQuestions: normalizeStringList(progress.completedQuestions ?? [], "progress.completedQuestions"),
				updatedAt: now,
			},
		});
		this.commit("task.progress", callerAgentId, [next]);
		return clone(next);
	}

	reportGap(
		taskId: string,
		callerAgentId: string,
		input: {
			kind: AgentTaskGap["kind"];
			description: string;
			neededInformation?: string;
			evidenceRefs?: string[];
		},
	): AgentTaskGap {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "report a gap for");
		if (!["coverage", "context", "dependency", "other"].includes(input.kind)) {
			throw new AgentTaskGraphError(`unsupported gap kind: ${input.kind}`);
		}
		const now = new Date().toISOString();
		const gap: AgentTaskGap = {
			id: `gap-${randomUUID()}`,
			kind: input.kind,
			description: normalizeText(input.description, "gap.description"),
			...(input.neededInformation
				? { neededInformation: normalizeText(input.neededInformation, "gap.neededInformation") }
				: {}),
			status: "open",
			reportedByAgentId: callerAgentId,
			evidenceRefs: normalizeStringList(input.evidenceRefs ?? [], "gap.evidenceRefs"),
			createdAt: now,
			updatedAt: now,
		};
		const next = touchTask({ ...task, status: "blocked", gaps: [...task.gaps, gap] });
		this.commit("task.gap_reported", callerAgentId, [next]);
		return clone(gap);
	}

	resolveGap(
		taskId: string,
		gapId: string,
		callerAgentId: string,
		input: { status: "resolved" | "declined"; resolution: string; evidenceRefs?: string[] },
	): AgentTaskGap {
		const task = this.findTask(taskId);
		this.assertCanSupervise(task, callerAgentId);
		const index = task.gaps.findIndex((gap) => gap.id === gapId);
		if (index < 0) throw new AgentTaskGraphError(`unknown gap ${gapId} for task ${taskId}`);
		const gap = task.gaps[index]!;
		if (gap.status !== "open") throw new AgentTaskGraphError(`gap ${gapId} is already ${gap.status}`);
		const nextGap: AgentTaskGap = {
			...gap,
			status: input.status,
			resolution: normalizeText(input.resolution, "gap.resolution"),
			evidenceRefs: normalizeStringList(input.evidenceRefs ?? gap.evidenceRefs, "gap.evidenceRefs"),
			updatedAt: new Date().toISOString(),
		};
		const gaps = [...task.gaps];
		gaps[index] = nextGap;
		const becomesRunnable = task.status === "blocked" && gaps.every((candidate) => candidate.status !== "open");
		const requestedAt = new Date().toISOString();
		const cycleStart = task.resumeRequest?.gapCount ?? 0;
		const next = touchTask({
			...task,
			status: becomesRunnable ? "pending" : task.status,
			gaps,
			...(becomesRunnable
				? {
						resumeRequest: {
							id: `resume-${nextGap.id}`,
							taskId: task.id,
							ownerAgentId: task.ownerAgentId,
							gapIds: gaps.slice(cycleStart).map((candidate) => candidate.id),
							gapCount: gaps.length,
							status: "pending" as const,
							requestedAt,
						},
					}
				: {}),
		});
		this.commit("task.gap_resolved", callerAgentId, [next]);
		return clone(nextGap);
	}

	completeTask(taskId: string, callerAgentId: string, rawResult: AgentTaskResult): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "complete");
		const activeChildren = this.childrenOf(task.id).filter((child) => ACTIVE_TASK_STATUSES.has(child.status));
		if (activeChildren.length > 0) {
			throw new AgentTaskGraphError(
				`task ${taskId} still has active child tasks: ${activeChildren.map((child) => child.id).join(", ")}`,
			);
		}
		const result = normalizeTaskResult(rawResult);
		if (task.gaps.some((gap) => gap.status === "open")) {
			throw new AgentTaskGraphError(`task ${taskId} still has open gaps`);
		}
		this.policy.validateCompletion?.({ task: clone(task), result: clone(result), snapshot: clone(this.state) });
		const next = touchTask({ ...task, status: "completed", result });
		this.commit("task.completed", callerAgentId, [next]);
		return clone(next);
	}

	completeTaskFromRuntime(taskId: string, callerAgentId: string, summary: string): AgentTask {
		const task = this.findTask(taskId);
		if (task.status === "completed") return clone(task);
		return this.completeTask(taskId, callerAgentId, {
			summary: boundedRuntimeText(summary, "Task completed without a textual result."),
			verification: [],
			candidateFindings: [],
			unresolvedQuestions: [],
			coverageGaps: [],
			evidenceRefs: task.progress?.evidenceRefs ?? [],
		});
	}

	canAutoCompleteTask(taskId: string): boolean {
		const task = this.findTask(taskId);
		return (
			ACTIVE_TASK_STATUSES.has(task.status) &&
			task.delegationState === "retained" &&
			!task.gaps.some((gap) => gap.status === "open") &&
			!this.childrenOf(task.id).some((child) => ACTIVE_TASK_STATUSES.has(child.status))
		);
	}

	interruptTask(taskId: string, callerAgentId: string, reason: string): AgentTask {
		const task = this.findTask(taskId);
		if (task.status === "completed" || task.status === "cancelled" || task.status === "interrupted")
			return clone(task);
		if (callerAgentId !== task.ownerAgentId) this.assertCanSupervise(task, callerAgentId);
		const changed = this.cancelSubtree(task, "interrupted", reason);
		this.commit("task.interrupted", callerAgentId, changed);
		return this.getTask(taskId);
	}

	cancelTask(taskId: string, callerAgentId: string, reason: string): AgentTask {
		const task = this.findTask(taskId);
		this.assertCanSupervise(task, callerAgentId);
		const changed = this.cancelSubtree(task, "cancelled", reason);
		this.commit("task.cancelled", callerAgentId, changed);
		return this.getTask(taskId);
	}

	reassignTask(taskId: string, callerAgentId: string, newOwnerAgentId: string): AgentTask {
		const task = this.findTask(taskId);
		this.assertCanSupervise(task, callerAgentId);
		this.assertActive(task, "reassign");
		const ownerAgentId = normalizeIdentifier(newOwnerAgentId, "newOwnerAgentId");
		const next = touchTask({
			...task,
			ownerAgentId,
			childAgentId: ownerAgentId,
			...(task.resumeRequest ? { resumeRequest: { ...task.resumeRequest, ownerAgentId } } : {}),
		});
		this.commit("task.reassigned", callerAgentId, [next]);
		return clone(next);
	}

	recordUsage(taskId: string, usage: Partial<AgentTaskUsage>, actorAgentId: string): AgentTask {
		const task = this.findTask(taskId);
		const delta: AgentTaskUsage = {
			input: normalizeUsageNumber(usage.input),
			output: normalizeUsageNumber(usage.output),
			cacheRead: normalizeUsageNumber(usage.cacheRead),
			cacheWrite: normalizeUsageNumber(usage.cacheWrite),
			cost: normalizeUsageNumber(usage.cost),
		};
		const next = touchTask({
			...task,
			usage: {
				input: task.usage.input + delta.input,
				output: task.usage.output + delta.output,
				cacheRead: task.usage.cacheRead + delta.cacheRead,
				cacheWrite: task.usage.cacheWrite + delta.cacheWrite,
				cost: task.usage.cost + delta.cost,
			},
		});
		this.commitUsage(actorAgentId, next, delta);
		return clone(next);
	}

	assertTreeComplete(): void {
		const unfinished = this.state.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
		if (unfinished.length > 0) {
			throw new AgentTaskGraphError(
				`task graph still has unfinished tasks: ${unfinished.map((task) => task.id).join(", ")}`,
			);
		}
	}

	assertDelegatedTasksComplete(): void {
		const unfinished = this.state.tasks.filter(
			(task) => task.id !== this.state.rootTaskId && ACTIVE_TASK_STATUSES.has(task.status),
		);
		if (unfinished.length > 0) {
			throw new AgentTaskGraphError(
				`task graph still has unfinished delegated tasks: ${unfinished.map((task) => task.id).join(", ")}`,
			);
		}
	}

	hasActiveDescendants(taskId: string): boolean {
		this.findTask(taskId);
		const pending = [...this.childrenOf(taskId)];
		while (pending.length > 0) {
			const task = pending.pop()!;
			if (ACTIVE_TASK_STATUSES.has(task.status)) return true;
			pending.push(...this.childrenOf(task.id));
		}
		return false;
	}

	async waitForDescendantsComplete(taskId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
		this.findTask(taskId);
		while (true) {
			if (this.fatalError) {
				throw new AgentTaskGraphError(`task graph durability failed: ${this.fatalError.message}`);
			}
			if (options.signal?.aborted) throw new AgentTaskGraphError("task descendant wait cancelled");
			if (!this.hasActiveDescendants(taskId)) return;
			await new Promise<void>((resolve, reject) => {
				const onChange = () => {
					cleanup();
					resolve();
				};
				const onAbort = () => {
					cleanup();
					reject(new AgentTaskGraphError("task descendant wait cancelled"));
				};
				const cleanup = () => {
					this.changeWaiters.delete(onChange);
					options.signal?.removeEventListener("abort", onAbort);
				};
				this.changeWaiters.add(onChange);
				options.signal?.addEventListener("abort", onAbort, { once: true });
				// Close the predicate/subscription race without polling.
				if (!this.hasActiveDescendants(taskId)) onChange();
				else if (options.signal?.aborted) onAbort();
			});
		}
	}

	private loadOrCreate(rootInput: AgentTaskRootInput): AgentTaskGraphSnapshot {
		if (existsSync(this.snapshotPath)) {
			const loaded = parseSnapshot(readFileSync(this.snapshotPath, "utf8"));
			return this.replayEvents(loaded);
		}
		const root = normalizeRootInput(rootInput);
		const now = new Date().toISOString();
		const task: AgentTask = {
			id: root.id ?? "task-root",
			createdByAgentId: root.ownerAgentId,
			ownerAgentId: root.ownerAgentId,
			objective: root.objective,
			scope: root.scope ?? root.objective,
			exclusiveClaims: clone(root.exclusiveClaims ?? []),
			sharedClaims: clone(root.sharedClaims ?? []),
			exclusions: clone(root.exclusions ?? []),
			questions: [...(root.questions ?? [])],
			invariants: [...(root.invariants ?? [])],
			knownDecisions: [...(root.knownDecisions ?? [])],
			dependencies: [...(root.dependencies ?? [])],
			verificationExpectations: [...(root.verificationExpectations ?? [])],
			...(root.resultSchema ? { resultSchema: clone(root.resultSchema) } : {}),
			status: "running",
			delegationState: "retained",
			gaps: [],
			usage: emptyUsage(),
			version: 1,
			createdAt: now,
			updatedAt: now,
		};
		const state: AgentTaskGraphSnapshot = {
			schemaVersion: AGENT_TASK_GRAPH_SCHEMA_VERSION,
			graphId: `graph-${randomUUID()}`,
			rootTaskId: task.id,
			rootAgentId: root.ownerAgentId,
			...(root.rootContext ? { rootContext: clone(root.rootContext) } : {}),
			...(root.inheritedContext ? { inheritedContext: clone(root.inheritedContext) } : {}),
			version: 1,
			tasks: [task],
		};
		this.persistInitial(state, root.ownerAgentId);
		return state;
	}

	private recover(rootAgentId: string): void {
		const root = this.findTask(this.state.rootTaskId);
		const rootAgentChanged = this.state.rootAgentId !== rootAgentId;
		const rootHasPendingResume = root.status === "pending" && root.resumeRequest?.status === "pending";
		const recoveredRootStatus = rootHasPendingResume ? "pending" : "running";
		const rootNeedsRecovery =
			root.ownerAgentId !== rootAgentId ||
			root.status !== recoveredRootStatus ||
			(root.resumeRequest !== undefined && root.resumeRequest.ownerAgentId !== rootAgentId);
		if (rootNeedsRecovery || rootAgentChanged) {
			this.commit(
				"graph.recovered",
				rootAgentId,
				rootNeedsRecovery
					? [
							touchTask({
								...root,
								ownerAgentId: rootAgentId,
								status: recoveredRootStatus,
								...(root.resumeRequest
									? { resumeRequest: { ...root.resumeRequest, ownerAgentId: rootAgentId } }
									: {}),
							}),
						]
					: [],
				rootAgentChanged ? { rootAgentId } : undefined,
			);
		}
		const preservedTaskIds = new Set<string>();
		for (const task of this.state.tasks) {
			if (task.status !== "pending" || task.resumeRequest?.status !== "pending") continue;
			let current: AgentTask | undefined = task;
			while (current) {
				preservedTaskIds.add(current.id);
				current = current.parentTaskId
					? this.state.tasks.find((candidate) => candidate.id === current?.parentTaskId)
					: undefined;
			}
		}
		const activeTaskIds = new Set(
			this.state.tasks
				.filter(
					(task) =>
						task.id !== this.state.rootTaskId &&
						ACTIVE_TASK_STATUSES.has(task.status) &&
						!preservedTaskIds.has(task.id),
				)
				.map((task) => task.id),
		);
		const recoveryRoots = this.state.tasks.filter(
			(task) => activeTaskIds.has(task.id) && (!task.parentTaskId || !activeTaskIds.has(task.parentTaskId)),
		);
		// Commit each recovery root independently so sibling claim reclamation composes
		// against the state produced by the previous interruption.
		for (const task of recoveryRoots) {
			const current = this.findTask(task.id);
			if (!ACTIVE_TASK_STATUSES.has(current.status)) continue;
			this.commit(
				"task.recovered_as_interrupted",
				rootAgentId,
				this.cancelSubtree(current, "interrupted", "Runtime restarted before task completion"),
			);
		}
	}

	private replayEvents(snapshot: AgentTaskGraphSnapshot): AgentTaskGraphSnapshot {
		if (!existsSync(this.eventsPath)) return snapshot;
		let state = snapshot;
		const lines = readFileSync(this.eventsPath, "utf8").split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index]!.trim();
			if (!line) continue;
			let event: AgentTaskGraphEvent;
			try {
				event = JSON.parse(line) as AgentTaskGraphEvent;
			} catch (error) {
				if (index === lines.length - 1) break;
				throw new AgentTaskGraphError(`invalid task graph event at line ${index + 1}: ${String(error)}`);
			}
			if (event.graphId !== state.graphId || event.graphVersion <= state.version) continue;
			const tasks = new Map(state.tasks.map((task) => [task.id, task]));
			for (const task of event.tasks) tasks.set(task.id, task);
			if (event.usageDelta) {
				const task = tasks.get(event.usageDelta.taskId);
				if (!task) throw new AgentTaskGraphError(`usage event references unknown task: ${event.usageDelta.taskId}`);
				tasks.set(
					task.id,
					addUsageDelta(task, event.usageDelta.usage, event.usageDelta.updatedAt, event.usageDelta.taskVersion),
				);
			}
			state = {
				...state,
				version: event.graphVersion,
				...(event.rootAgentId ? { rootAgentId: event.rootAgentId } : {}),
				tasks: [...tasks.values()],
			};
			this.eventsSinceSnapshot += 1;
			this.bytesSinceSnapshot += Buffer.byteLength(line, "utf8") + 1;
		}
		return state;
	}

	private persistInitial(state: AgentTaskGraphSnapshot, actorAgentId: string): void {
		const event: AgentTaskGraphEvent = {
			schemaVersion: AGENT_TASK_GRAPH_SCHEMA_VERSION,
			graphId: state.graphId,
			graphVersion: state.version,
			type: "graph.created",
			actorAgentId,
			taskIds: [state.rootTaskId],
			tasks: clone(state.tasks),
			at: new Date().toISOString(),
		};
		appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
		this.writeSnapshot(state);
	}

	private commit(
		type: string,
		actorAgentId: string,
		changedTasks: AgentTask[],
		graphPatch?: { rootAgentId?: string },
	): void {
		if (changedTasks.length === 0 && !graphPatch?.rootAgentId) return;
		this.assertWritable();
		const version = this.state.version + 1;
		const tasks = new Map(this.state.tasks.map((task) => [task.id, task]));
		for (const task of changedTasks) tasks.set(task.id, task);
		const next: AgentTaskGraphSnapshot = {
			...this.state,
			version,
			...(graphPatch?.rootAgentId ? { rootAgentId: graphPatch.rootAgentId } : {}),
			tasks: [...tasks.values()],
		};
		const event: AgentTaskGraphEvent = {
			schemaVersion: AGENT_TASK_GRAPH_SCHEMA_VERSION,
			graphId: next.graphId,
			graphVersion: version,
			type,
			actorAgentId,
			taskIds: changedTasks.map((task) => task.id),
			tasks: clone(changedTasks),
			...(graphPatch?.rootAgentId ? { rootAgentId: graphPatch.rootAgentId } : {}),
			at: new Date().toISOString(),
		};
		this.appendEvent(event);
		this.state = next;
		this.compactSnapshot(false);
		this.notifyChangeWaiters();
	}

	private commitUsage(actorAgentId: string, nextTask: AgentTask, usage: AgentTaskUsage): void {
		this.assertWritable();
		const version = this.state.version + 1;
		const tasks = new Map(this.state.tasks.map((task) => [task.id, task]));
		tasks.set(nextTask.id, nextTask);
		const next = { ...this.state, version, tasks: [...tasks.values()] };
		this.appendEvent({
			schemaVersion: AGENT_TASK_GRAPH_SCHEMA_VERSION,
			graphId: next.graphId,
			graphVersion: version,
			type: "task.usage",
			actorAgentId,
			taskIds: [nextTask.id],
			tasks: [],
			usageDelta: {
				taskId: nextTask.id,
				usage,
				taskVersion: nextTask.version,
				updatedAt: nextTask.updatedAt,
			},
			at: new Date().toISOString(),
		});
		this.state = next;
		this.compactSnapshot(false);
		this.notifyChangeWaiters();
	}

	private notifyChangeWaiters(): void {
		const waiters = [...this.changeWaiters];
		this.changeWaiters.clear();
		for (const waiter of waiters) waiter();
	}

	private appendEvent(event: AgentTaskGraphEvent): void {
		const encoded = `${JSON.stringify(event)}\n`;
		try {
			appendFileSync(this.eventsPath, encoded, { encoding: "utf8", mode: 0o600 });
			this.eventsSinceSnapshot += 1;
			this.bytesSinceSnapshot += Buffer.byteLength(encoded, "utf8");
		} catch (error) {
			this.fatalError = asError(error);
			this.notifyChangeWaiters();
			throw new AgentTaskGraphError(`task graph journal write failed: ${this.fatalError.message}`);
		}
	}

	private compactSnapshot(required: boolean): void {
		if (
			!required &&
			this.eventsSinceSnapshot < AGENT_TASK_SNAPSHOT_COMPACT_EVENT_THRESHOLD &&
			this.bytesSinceSnapshot < AGENT_TASK_SNAPSHOT_COMPACT_BYTE_THRESHOLD
		) {
			return;
		}
		try {
			this.writeSnapshot(this.state);
			writeFileSync(this.eventsPath, "", { encoding: "utf8", mode: 0o600 });
			chmodSync(this.eventsPath, 0o600);
			this.eventsSinceSnapshot = 0;
			this.bytesSinceSnapshot = 0;
			this.degradedError = undefined;
		} catch (error) {
			this.degradedError = asError(error);
			if (required) throw new AgentTaskGraphError(`task graph checkpoint failed: ${this.degradedError.message}`);
		}
	}

	private writeSnapshot(snapshot: AgentTaskGraphSnapshot): void {
		const temporaryPath = `${this.snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
		writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, this.snapshotPath);
		chmodSync(this.snapshotPath, 0o600);
	}

	private cancelSubtree(task: AgentTask, status: "cancelled" | "interrupted", reason: string): AgentTask[] {
		const subtree = this.collectActiveSubtree(task);
		const changed = subtree.map((candidate) =>
			touchTask({
				...candidate,
				status,
				result: {
					summary: boundedRuntimeText(reason, "Task cancelled without a reason."),
					verification: [],
					candidateFindings: [],
					unresolvedQuestions: [],
					coverageGaps: [],
					evidenceRefs: candidate.progress?.evidenceRefs ?? [],
				},
				reclaimedAt: new Date().toISOString(),
			}),
		);
		if (task.parentTaskId) {
			const parent = this.findTask(task.parentTaskId);
			const reclaimed = subtree.reduce(
				(claims, candidate) => mergeClaims(claims, candidate.exclusiveClaims),
				parent.exclusiveClaims,
			);
			const nextParent = touchTask({
				...parent,
				exclusiveClaims: reclaimed,
				delegationState: "retained",
			});
			changed.push(nextParent);
		}
		return deduplicateTasks(changed);
	}

	private collectActiveSubtree(task: AgentTask): AgentTask[] {
		const tasks = [task];
		for (const child of this.childrenOf(task.id)) {
			if (ACTIVE_TASK_STATUSES.has(child.status)) tasks.push(...this.collectActiveSubtree(child));
		}
		return tasks;
	}

	private findTask(taskId: string): AgentTask {
		const normalized = normalizeIdentifier(taskId, "taskId");
		const task = this.state.tasks.find((candidate) => candidate.id === normalized);
		if (!task) throw new AgentTaskGraphError(`unknown task: ${normalized}`);
		return task;
	}

	private childrenOf(taskId: string): AgentTask[] {
		return this.state.tasks.filter((task) => task.parentTaskId === taskId);
	}

	private lineage(taskId: string): string[] {
		const lineage: string[] = [];
		let current: AgentTask | undefined = this.findTask(taskId);
		while (current) {
			lineage.unshift(current.id);
			current = current.parentTaskId
				? this.state.tasks.find((task) => task.id === current?.parentTaskId)
				: undefined;
		}
		return lineage;
	}

	private assertOwner(task: AgentTask, callerAgentId: string): void {
		if (task.ownerAgentId !== callerAgentId) {
			throw new AgentTaskGraphError(`agent ${callerAgentId} does not own task ${task.id}`);
		}
	}

	private assertCanSupervise(task: AgentTask, callerAgentId: string): void {
		if (callerAgentId === this.state.rootAgentId) return;
		if (!task.parentTaskId) throw new AgentTaskGraphError(`only root agent may supervise root task ${task.id}`);
		const parent = this.findTask(task.parentTaskId);
		if (parent.ownerAgentId !== callerAgentId) {
			throw new AgentTaskGraphError(`agent ${callerAgentId} is not the direct supervisor of task ${task.id}`);
		}
	}

	private assertActive(task: AgentTask, operation: string): void {
		if (!ACTIVE_TASK_STATUSES.has(task.status)) {
			throw new AgentTaskGraphError(`cannot ${operation} task ${task.id} with status ${task.status}`);
		}
	}

	private assertWritable(): void {
		if (this.fatalError) throw new AgentTaskGraphError(`task graph durability failed: ${this.fatalError.message}`);
	}
}

export function formatAgentTaskContextEnvelope(envelope: AgentTaskContextEnvelope): string {
	return [
		"[task contract]",
		"You own this bounded task. Delegate only by transferring a genuinely narrower subset of its responsibility.",
		"Return compact conclusions and evidence references. Report missing context through the task API instead of broadly rediscovering it.",
		JSON.stringify(envelope, null, 2),
	].join("\n\n");
}

function normalizeRootInput(input: AgentTaskRootInput): AgentTaskRootInput {
	return {
		...(input.id ? { id: normalizeIdentifier(input.id, "root.id") } : {}),
		ownerAgentId: normalizeIdentifier(input.ownerAgentId, "root.ownerAgentId"),
		objective: normalizeText(input.objective, "root.objective"),
		...(input.scope ? { scope: normalizeText(input.scope, "root.scope") } : {}),
		exclusiveClaims: normalizeClaims(input.exclusiveClaims ?? [], "root.exclusiveClaims"),
		sharedClaims: normalizeClaims(input.sharedClaims ?? [], "root.sharedClaims"),
		exclusions: normalizeClaims(input.exclusions ?? [], "root.exclusions"),
		questions: normalizeStringList(input.questions ?? [], "root.questions"),
		invariants: normalizeStringList(input.invariants ?? [], "root.invariants"),
		knownDecisions: normalizeStringList(input.knownDecisions ?? [], "root.knownDecisions"),
		dependencies: normalizeStringList(input.dependencies ?? [], "root.dependencies"),
		verificationExpectations: normalizeStringList(
			input.verificationExpectations ?? [],
			"root.verificationExpectations",
		),
		...(input.resultSchema ? { resultSchema: normalizeRecord(input.resultSchema, "root.resultSchema") } : {}),
		...(input.rootContext ? { rootContext: normalizeRecord(input.rootContext, "root.rootContext") } : {}),
		...(input.inheritedContext
			? { inheritedContext: normalizeRecord(input.inheritedContext, "root.inheritedContext") }
			: {}),
	};
}

function isMeaningfullyNarrower(parent: AgentTask, child: AgentTaskDelegationInput): boolean {
	const exclusiveClaims = child.exclusiveClaims ?? [];
	const transfersProperSubset = exclusiveClaims.length > 0 && exclusiveClaims.length < parent.exclusiveClaims.length;
	const ownsFocusedQuestion =
		(child.questions?.length ?? 0) > 0 &&
		(child.scope.trim() !== parent.scope.trim() || child.objective.trim() !== parent.objective.trim());
	return transfersProperSubset || ownsFocusedQuestion;
}

function normalizeDelegationInput(input: AgentTaskDelegationInput): AgentTaskDelegationInput & {
	questions: string[];
	invariants: string[];
	knownDecisions: string[];
	dependencies: string[];
	verificationExpectations: string[];
} {
	return {
		...(input.id ? { id: normalizeIdentifier(input.id, "task.id") } : {}),
		objective: normalizeText(input.objective, "task.objective"),
		scope: normalizeText(input.scope, "task.scope"),
		exclusiveClaims: normalizeClaims(input.exclusiveClaims ?? [], "task.exclusiveClaims"),
		sharedClaims: normalizeClaims(input.sharedClaims ?? [], "task.sharedClaims"),
		exclusions: normalizeClaims(input.exclusions ?? [], "task.exclusions"),
		questions: normalizeStringList(input.questions ?? [], "task.questions"),
		invariants: normalizeStringList(input.invariants ?? [], "task.invariants"),
		knownDecisions: normalizeStringList(input.knownDecisions ?? [], "task.knownDecisions"),
		dependencies: normalizeStringList(input.dependencies ?? [], "task.dependencies"),
		verificationExpectations: normalizeStringList(
			input.verificationExpectations ?? [],
			"task.verificationExpectations",
		),
		...(input.resultSchema ? { resultSchema: normalizeRecord(input.resultSchema, "task.resultSchema") } : {}),
		delegationReason: normalizeText(input.delegationReason, "task.delegationReason"),
	};
}

function normalizeTaskResult(result: AgentTaskResult): AgentTaskResult {
	const normalized: AgentTaskResult = {
		summary: normalizeText(result.summary, "result.summary"),
		verification: normalizeUnknownList(result.verification, "result.verification"),
		candidateFindings: normalizeUnknownList(result.candidateFindings, "result.candidateFindings"),
		unresolvedQuestions: normalizeStringList(result.unresolvedQuestions, "result.unresolvedQuestions"),
		coverageGaps: normalizeUnknownList(result.coverageGaps, "result.coverageGaps"),
		evidenceRefs: normalizeStringList(result.evidenceRefs, "result.evidenceRefs"),
		...(result.data ? { data: normalizeRecord(result.data, "result.data") } : {}),
	};
	assertJsonSize(normalized, "task result", AGENT_TASK_RESULT_MAX_BYTES);
	return normalized;
}

function normalizeClaims(claims: AgentTaskResourceClaim[], field: string): AgentTaskResourceClaim[] {
	if (!Array.isArray(claims)) throw new AgentTaskGraphError(`${field} must be an array`);
	if (claims.length > AGENT_TASK_CLAIM_MAX_ITEMS) {
		throw new AgentTaskGraphError(`${field} must contain at most ${AGENT_TASK_CLAIM_MAX_ITEMS} items`);
	}
	const normalized = claims.map((claim, index) => {
		if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
			throw new AgentTaskGraphError(`${field}[${index}] must be an object`);
		}
		return {
			namespace: normalizeIdentifier(claim.namespace, `${field}[${index}].namespace`),
			key: normalizeText(claim.key, `${field}[${index}].key`, AGENT_TASK_TEXT_MAX_LENGTH),
			...(claim.metadata ? { metadata: normalizeRecord(claim.metadata, `${field}[${index}].metadata`) } : {}),
		};
	});
	const keys = new Set<string>();
	for (const claim of normalized) {
		const key = claimKey(claim);
		if (keys.has(key)) throw new AgentTaskGraphError(`${field} contains duplicate claim ${key}`);
		keys.add(key);
	}
	return normalized;
}

function normalizeStringList(values: string[], field: string): string[] {
	if (!Array.isArray(values)) throw new AgentTaskGraphError(`${field} must be an array`);
	if (values.length > AGENT_TASK_LIST_MAX_ITEMS) {
		throw new AgentTaskGraphError(`${field} must contain at most ${AGENT_TASK_LIST_MAX_ITEMS} items`);
	}
	return values.map((value, index) => normalizeText(value, `${field}[${index}]`));
}

function normalizeUnknownList(values: unknown[], field: string): unknown[] {
	if (!Array.isArray(values)) throw new AgentTaskGraphError(`${field} must be an array`);
	if (values.length > AGENT_TASK_LIST_MAX_ITEMS) {
		throw new AgentTaskGraphError(`${field} must contain at most ${AGENT_TASK_LIST_MAX_ITEMS} items`);
	}
	assertJsonSize(values, field, AGENT_TASK_RESULT_MAX_BYTES);
	return clone(values);
}

function normalizeRecord(value: Record<string, unknown>, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AgentTaskGraphError(`${field} must be an object`);
	}
	assertJsonSize(value, field, AGENT_TASK_RESULT_MAX_BYTES);
	return clone(value);
}

function normalizeText(value: string, field: string, maxLength = AGENT_TASK_TEXT_MAX_LENGTH): string {
	if (typeof value !== "string") throw new AgentTaskGraphError(`${field} must be a string`);
	const normalized = value.trim();
	if (!normalized) throw new AgentTaskGraphError(`${field} must not be empty`);
	if (normalized.length > maxLength) throw new AgentTaskGraphError(`${field} must be at most ${maxLength} characters`);
	return normalized;
}

function normalizeIdentifier(value: string, field: string): string {
	const normalized = normalizeText(value, field, 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
		throw new AgentTaskGraphError(`${field} contains unsupported characters`);
	}
	return normalized;
}

function normalizeNonNegativeInteger(value: number, field: string): number {
	if (!Number.isInteger(value) || value < 0) throw new AgentTaskGraphError(`${field} must be a non-negative integer`);
	return value;
}

function normalizeIntegerInRange(value: number, field: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new AgentTaskGraphError(`${field} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

function normalizeUsageNumber(value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isFinite(value) || value < 0)
		throw new AgentTaskGraphError("task usage values must be finite non-negative numbers");
	return value;
}

function emptyUsage(): AgentTaskUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsageDelta(
	task: AgentTask,
	delta: AgentTaskUsage,
	updatedAt = new Date().toISOString(),
	taskVersion = task.version + 1,
): AgentTask {
	return {
		...task,
		usage: {
			input: task.usage.input + delta.input,
			output: task.usage.output + delta.output,
			cacheRead: task.usage.cacheRead + delta.cacheRead,
			cacheWrite: task.usage.cacheWrite + delta.cacheWrite,
			cost: task.usage.cost + delta.cost,
		},
		version: taskVersion,
		updatedAt,
	};
}

function boundedRuntimeText(value: string, fallback: string): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	const source = normalized || fallback;
	if (source.length <= AGENT_TASK_TEXT_MAX_LENGTH) return source;
	const marker = "\n\n[truncated by task runtime]";
	return `${source.slice(0, AGENT_TASK_TEXT_MAX_LENGTH - marker.length).trimEnd()}${marker}`;
}

function rootContextDescriptor(context: Record<string, unknown>): AgentTaskRootContextDescriptor {
	const encoded = JSON.stringify(context);
	return {
		sha256: createHash("sha256").update(encoded).digest("hex"),
		byteLength: Buffer.byteLength(encoded, "utf8"),
	};
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function touchTask(task: AgentTask): AgentTask {
	return { ...task, version: task.version + 1, updatedAt: new Date().toISOString() };
}

function sameClaim(left: AgentTaskResourceClaim, right: AgentTaskResourceClaim): boolean {
	return left.namespace === right.namespace && left.key === right.key;
}

function claimKey(claim: AgentTaskResourceClaim): string {
	return `${claim.namespace}:${claim.key}`;
}

function mergeClaims(left: AgentTaskResourceClaim[], right: AgentTaskResourceClaim[]): AgentTaskResourceClaim[] {
	const merged = [...left];
	for (const claim of right) {
		if (!merged.some((candidate) => sameClaim(candidate, claim))) merged.push(clone(claim));
	}
	return merged;
}

function delegationSignature(parentTaskId: string, task: AgentTaskDelegationInput): string {
	return JSON.stringify({
		parentTaskId,
		scope: task.scope.toLowerCase(),
		exclusiveClaims: (task.exclusiveClaims ?? []).map(claimKey).sort(),
		questions: (task.questions ?? []).map((question) => question.toLowerCase()).sort(),
	});
}

function taskSignature(task: AgentTask): string {
	return JSON.stringify({
		parentTaskId: task.parentTaskId,
		scope: task.scope.toLowerCase(),
		exclusiveClaims: task.exclusiveClaims.map(claimKey).sort(),
		questions: task.questions.map((question) => question.toLowerCase()).sort(),
	});
}

function compareTasks(left: AgentTask, right: AgentTask): number {
	return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function deduplicateTasks(tasks: AgentTask[]): AgentTask[] {
	const deduplicated = new Map<string, AgentTask>();
	for (const task of tasks) deduplicated.set(task.id, task);
	return [...deduplicated.values()];
}

function parseSnapshot(raw: string): AgentTaskGraphSnapshot {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new AgentTaskGraphError(`invalid task graph snapshot: ${String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AgentTaskGraphError("task graph snapshot must be an object");
	}
	const snapshot = value as Partial<AgentTaskGraphSnapshot>;
	if (snapshot.schemaVersion !== AGENT_TASK_GRAPH_SCHEMA_VERSION) {
		throw new AgentTaskGraphError(`unsupported task graph schema version: ${String(snapshot.schemaVersion)}`);
	}
	if (
		typeof snapshot.graphId !== "string" ||
		typeof snapshot.rootTaskId !== "string" ||
		typeof snapshot.rootAgentId !== "string"
	) {
		throw new AgentTaskGraphError("task graph snapshot is missing identity fields");
	}
	if (!Number.isInteger(snapshot.version) || !Array.isArray(snapshot.tasks)) {
		throw new AgentTaskGraphError("task graph snapshot is missing version or tasks");
	}
	return clone(snapshot as AgentTaskGraphSnapshot);
}

function assertJsonSize(value: unknown, field: string, maximum: number): void {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		throw new AgentTaskGraphError(`${field} must be JSON serializable: ${String(error)}`);
	}
	if (Buffer.byteLength(encoded, "utf8") > maximum) {
		throw new AgentTaskGraphError(`${field} must be at most ${maximum} UTF-8 bytes`);
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
