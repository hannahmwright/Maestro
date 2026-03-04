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

export interface FailureSignal {
	session_id: string;
	command: string;
	cwd: string;
	exit_code: number;
	stdout?: string;
	stderr?: string;
}

export interface FixHypothesis {
	id: string;
	classification: FailureClassification;
	title: string;
	rationale: string;
	confidence: number;
	likely_files: string[];
	likely_symbols: string[];
	suggested_commands: string[];
	metadata_hash: string;
}

export interface TriageResult {
	classification: FailureClassification;
	confidence: number;
	probable_files: string[];
	probable_symbols: string[];
	hypotheses: FixHypothesis[];
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

export interface ApplyResult {
	applied: boolean;
	applied_files: string[];
	skipped_files: string[];
	blocked_reasons: string[];
	syntax_errors: SyntaxValidationError[];
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
	  };

export interface DebugFixLoopInput {
	session_id: string;
	task: TaskContract;
	cwd: string;
	initial_command: string;
	full_suite_command?: string;
	proposed_edits?: ProposedFileEdit[];
	related_files?: string[];
	changed_files?: string[];
	diff_text?: string;
	max_attempts?: number;
}

export interface DebugFixLoopAttempt {
	attempt: number;
	command: string;
	result: CommandCheckResult;
	triage?: TriageResult;
}

export type DebugFixFailureCode =
	| 'edit_plan_blocked'
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
}

export interface DebugFixLoopResult {
	status: 'complete' | 'failed';
	reason?: string;
	attempts: DebugFixLoopAttempt[];
	decision?: CompletionDecision;
	review_findings?: ReviewFinding[];
	failure?: DebugFixLoopFailure;
}
