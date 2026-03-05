export type DoneGateProfile = 'quick' | 'standard' | 'high_risk';

export type LanguageProfile = 'ts_js' | 'generic';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface TaskContract {
	task_id: string;
	goal: string;
	repo_root: string;
	language_profile: LanguageProfile;
	risk_level: RiskLevel;
	allowed_commands: string[];
	done_gate_profile: DoneGateProfile;
	max_changed_files: number;
	created_at: number;
	metadata?: Record<string, unknown>;
}

export interface TaskContractInput {
	task_id?: string;
	goal: string;
	repo_root: string;
	language_profile?: LanguageProfile;
	risk_level?: RiskLevel;
	allowed_commands?: string[];
	done_gate_profile?: DoneGateProfile;
	max_changed_files?: number;
	metadata?: Record<string, unknown>;
}

export type FailureClassification =
	| 'test_failure'
	| 'type_error'
	| 'syntax_error'
	| 'module_not_found'
	| 'lint_error'
	| 'permission_error'
	| 'command_not_found'
	| 'runtime_error'
	| 'unknown';

export type FixHypothesisFamily =
	| 'dependency'
	| 'typing'
	| 'test_logic'
	| 'runtime'
	| 'lint'
	| 'environment';

export interface FailureSignal {
	session_id: string;
	command: string;
	cwd: string;
	exit_code: number;
	stdout?: string;
	stderr?: string;
	context_fallback_files?: string[];
}

export interface DiagnosticProbe {
	id: string;
	purpose: string;
	kind?: 'confirm' | 'disconfirm';
	command: string;
	target_files: string[];
	timeout_ms: number;
}

export interface DiagnosticProbeResult {
	probe_id: string;
	exit_code: number;
	pass: boolean;
	signal_excerpt: string;
	duration_ms: number;
	information_gain: number;
	skipped?: boolean;
	skip_reason?: string;
}

export interface HypothesisEvidence {
	confirming_signals: string[];
	disconfirming_signals: string[];
	uncertainty_note: string;
	evidence_score: number;
}

export interface FixHypothesis {
	id: string;
	classification: FailureClassification;
	family: FixHypothesisFamily;
	title: string;
	rationale: string;
	confidence: number;
	likely_files: string[];
	likely_symbols: string[];
	evidence: HypothesisEvidence;
	suggested_commands: string[];
	probe_candidates: DiagnosticProbe[];
	metadata_hash: string;
}

export interface TriageResult {
	classification: FailureClassification;
	confidence: number;
	probable_files: string[];
	probable_symbols: string[];
	hypotheses: FixHypothesis[];
	beam_width: number;
	selected_hypothesis_id?: string;
	ranking: Array<{ hypothesis_id: string; score: number }>;
	raw_signal_excerpt: string;
}

export interface ProposedFileEdit {
	file_path: string;
	reason: string;
	hunk_count?: number;
	changed_lines?: number;
}

export interface EditPlanInput {
	task: TaskContract;
	proposed_edits: ProposedFileEdit[];
	related_files?: string[];
}

export interface EditPlanFile {
	file_path: string;
	reason: string;
	related: boolean;
	blocked: boolean;
	block_reason?: string;
}

export interface EditPlan {
	valid: boolean;
	blocked: boolean;
	blocked_reasons: string[];
	file_plans: EditPlanFile[];
	changed_file_budget: number;
	requested_file_count: number;
}

export interface PlannedFilePatch {
	file_path: string;
	content: string;
	reason: string;
}

export interface ApplyPlanInput {
	task: TaskContract;
	edit_plan: EditPlan;
	patches: PlannedFilePatch[];
	allow_unrelated_files?: boolean;
}

export interface SyntaxValidationError {
	file_path: string;
	message: string;
}

export interface PlausibilityValidationError {
	file_path: string;
	code: 'merge_conflict_markers' | 'new_placeholder_markers' | 'empty_file_rewrite';
	message: string;
}

export interface ApplyResult {
	applied: boolean;
	applied_files: string[];
	skipped_files: string[];
	blocked_reasons: string[];
	syntax_errors: SyntaxValidationError[];
	plausibility_errors: PlausibilityValidationError[];
}

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ReviewFinding {
	id: string;
	severity: ReviewSeverity;
	confidence: number;
	regression_risk: 'high' | 'medium' | 'low';
	message: string;
	missing_tests: boolean;
	affected_surfaces: string[];
	blocking: boolean;
}

export interface ReviewInput {
	task: TaskContract;
	changed_files: string[];
	diff_text?: string;
}

export interface CommandCheckResult {
	command: string;
	exit_code: number;
	stdout?: string;
	stderr?: string;
	pass: boolean;
	duration_ms: number;
}

export interface GateEvaluationInput {
	task: TaskContract;
	targeted_checks: CommandCheckResult[];
	full_suite_checks?: CommandCheckResult[];
	review_findings?: ReviewFinding[];
	cross_package_change?: boolean;
	high_risk_edit?: boolean;
}

export interface CompletionDecision {
	decision: 'complete' | 'continue' | 'blocked';
	requires_full_suite: boolean;
	blocking_reasons: string[];
	blocking_findings: ReviewFinding[];
	next_actions: string[];
}

export type TaskLifecycleEvent =
	| {
			type: 'triage-started';
			attempt: number;
			signal_excerpt: string;
	  }
	| {
			type: 'hypothesis-generated';
			attempt: number;
			triage: TriageResult;
	  }
	| {
			type: 'edit-plan-applied';
			attempt: number;
			edit_plan: EditPlan;
	  }
	| {
			type: 'review-findings';
			attempt: number;
			findings: ReviewFinding[];
	  }
	| {
			type: 'gate-result';
			attempt: number;
			decision: CompletionDecision;
	  }
	| {
			type: 'probe-started';
			attempt: number;
			hypothesis_id: string;
			probe: DiagnosticProbe;
	  }
	| {
			type: 'probe-finished';
			attempt: number;
			hypothesis_id: string;
			probe_result: DiagnosticProbeResult;
	  }
	| {
			type: 'context-expanded';
			attempt: number;
			reason: 'initial' | 'low_confidence' | 'strategy_switch';
			depth: 1 | 2;
			selected_files: string[];
			impacted_symbols: string[];
	  }
	| {
			type: 'strategy-switched';
			attempt: number;
			from_family?: FixHypothesisFamily;
			to_family?: FixHypothesisFamily;
			reason: string;
	  };

export interface LoopContextRequest {
	mode: 'failure_focused' | 'edit_focused' | 'review_focused';
	seedFiles: string[];
	seedSymbols?: string[];
	depth?: 1 | 2;
	reason?: 'initial' | 'low_confidence' | 'strategy_switch';
	maxFiles?: number;
}

export interface LoopContextPack {
	selectedFiles: string[];
	impactedSymbols: string[];
	bridgeFiles?: string[];
	bridgeSymbols?: string[];
	selection_narratives?: Array<{
		file_path: string;
		reason: string;
		path?: string[];
	}>;
}

export interface LoopGraphQueryRequest {
	seedFiles: string[];
	candidateFiles: string[];
	seedSymbols?: string[];
	maxDepth?: number;
}

export interface LoopGraphScore {
	file_path: string;
	score: number;
	distance?: number;
	symbol_path_distance?: number;
	path_strength?: number;
	package_crossings?: number;
	package_blast_radius?: number;
	bridge_file_count?: number;
	bridge_symbol_count?: number;
	bridge_symbol_overlap?: number;
	transitive_importer_fanout?: number;
	explanation_path?: string[];
	explanation?: string;
	impact_score: number;
	fanout: number;
}

export interface LoopGraphQueryResult {
	scores: LoopGraphScore[];
	coverage: number;
	explored_nodes: number;
}

export interface LoopExecutionMemory {
	family_attempts: Partial<Record<FixHypothesisFamily, number>>;
	command_attempts: Record<string, number>;
	selected_hypothesis_history: string[];
	stagnation_count: number;
	strategy_switch_count: number;
	graph_query_count: number;
	long_horizon_plan_count: number;
	failure_fingerprints: Record<string, FailureFingerprintMemory>;
	module_area_memory: Record<string, ModuleAreaMemory>;
}

export interface ModuleAreaMemory {
	area_key: string;
	attempts: number;
	successes: number;
	failures: number;
	average_probe_gain: number;
	last_family?: FixHypothesisFamily;
	updated_at: number;
}

export interface ProbePurposeMemory {
	runs: number;
	passes: number;
	average_gain: number;
}

export interface FailureFingerprintMemory {
	key: string;
	seen_count: number;
	solved_count: number;
	dead_end_count: number;
	family_penalties: Partial<Record<FixHypothesisFamily, number>>;
	command_penalties: Record<string, number>;
	solved_family?: FixHypothesisFamily;
	solved_command?: string;
	probe_purpose_memory: Record<string, ProbePurposeMemory>;
	updated_at: number;
}

export interface HypothesisValidationResult {
	hypothesis_id: string;
	command: string;
	exit_code: number;
	pass: boolean;
	duration_ms: number;
	signal_excerpt?: string;
}

export interface HypothesisEvidenceLedgerEntry {
	hypothesis_id: string;
	family: FixHypothesisFamily;
	base_score: number;
	probe_gain: number;
	probe_evidence_delta: number;
	context_coverage: number;
	graph_coverage: number;
	graph_penalty: number;
	command_feasible: boolean;
	memory_adjustment: number;
	planner_boost: number;
	validation_delta: number;
	final_score: number;
	supporting_reasons: string[];
	contradicting_reasons: string[];
}

export interface DebugFixLoopInput {
	session_id: string;
	task: TaskContract;
	cwd: string;
	initial_command: string;
	full_suite_command?: string;
	proposed_edits?: ProposedFileEdit[];
	planned_patches?: PlannedFilePatch[];
	related_files?: string[];
	changed_files?: string[];
	diff_text?: string;
	max_attempts?: number;
	prior_memory?: Partial<LoopExecutionMemory>;
}

export interface DebugFixLoopAttempt {
	attempt: number;
	command: string;
	result: CommandCheckResult;
	triage?: TriageResult;
	selected_hypothesis_id?: string;
	selected_command?: string;
	selected_command_result?: CommandCheckResult;
	fix_path_candidates?: Array<{
		hypothesis_id: string;
		command: string;
		score: number;
		feasible: boolean;
	}>;
	probe_results?: DiagnosticProbeResult[];
	context_expanded?: boolean;
	context_selected_files?: string[];
	context_selection_narratives?: Array<{
		file_path: string;
		reason: string;
		path?: string[];
	}>;
	graph_query_coverage?: number;
	graph_query_explored_nodes?: number;
	long_horizon_focus_files?: string[];
	long_horizon_checkpoints?: Array<{
		id: string;
		title: string;
		target_files: string[];
		exit_criteria: string;
	}>;
	dual_track_results?: HypothesisValidationResult[];
	evidence_ledger?: HypothesisEvidenceLedgerEntry[];
	hypothesis_branch_count?: number;
	graph_explanations?: Array<{
		file_path: string;
		explanation_path?: string[];
		explanation?: string;
	}>;
	stagnation_count?: number;
}

export type DebugFixFailureCode =
	| 'edit_plan_blocked'
	| 'edit_apply_blocked'
	| 'command_not_allowed'
	| 'no_hypothesis_generated'
	| 'non_progressing_hypothesis_loop'
	| 'gate_blocked'
	| 'max_attempts_reached';

export interface DebugFixLoopFailure {
	code: DebugFixFailureCode;
	message: string;
	attempt?: number;
	blocking_reasons?: string[];
	hypothesis?: {
		previous_signature?: string;
		current_signature?: string;
		previous_top_metadata_hash?: string;
		current_top_metadata_hash?: string;
	};
	probe_deltas?: {
		previous_average_gain?: number;
		current_average_gain?: number;
		ranking_stable?: boolean;
	};
	syntax_errors?: SyntaxValidationError[];
	plausibility_errors?: PlausibilityValidationError[];
}

export interface DebugFixLoopResult {
	status: 'complete' | 'failed';
	reason?: string;
	attempts: DebugFixLoopAttempt[];
	decision?: CompletionDecision;
	review_findings?: ReviewFinding[];
	failure?: DebugFixLoopFailure;
	memory_state?: LoopExecutionMemory;
}

export interface TaskDiagnosticsLifecycleCounts {
	triage_started: number;
	hypothesis_generated: number;
	edit_plan_applied: number;
	review_findings: number;
	gate_result: number;
	probe_started: number;
	probe_finished: number;
	context_expanded: number;
	strategy_switched: number;
}

export interface TaskDiagnosticsSummary {
	task_id: string;
	status: 'complete' | 'failed';
	attempt_count: number;
	final_decision?: CompletionDecision['decision'];
	failure_code?: DebugFixFailureCode;
	blocking_reasons: string[];
	full_suite_required: boolean;
	lifecycle_counts: TaskDiagnosticsLifecycleCounts;
	last_command?: string;
	last_exit_code?: number;
	retrieval_mode?: 'failure_focused' | 'edit_focused' | 'review_focused';
	context_selected_files?: number;
	probe_count: number;
	strategy_switch_count: number;
	context_expansion_count: number;
	average_probe_gain?: number;
	graph_query_count: number;
	average_graph_coverage?: number;
	long_horizon_plan_count: number;
	memory_stagnation_final?: number;
	failure_fingerprint_count?: number;
	strict_runtime_path: boolean;
	evidence_ledger_count: number;
	average_hypothesis_branches: number;
	explanation_path_count: number;
	generated_at: number;
}
