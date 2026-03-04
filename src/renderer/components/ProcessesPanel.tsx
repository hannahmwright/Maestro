import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
	Activity,
	Bot,
	ChevronsRight,
	FolderOpen,
	Loader2,
	RefreshCw,
	Square,
	Terminal,
} from 'lucide-react';
import type { LogEntry, Session, Theme } from '../types';

type ProcessScope = 'session' | 'agent';
type ProcessKindFilter = 'all' | 'terminal' | 'agent';

interface ActiveProcessInfo {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string;
	isTerminal: boolean;
	isBatchMode: boolean;
	startTime?: number;
	command?: string;
	args?: string[];
}

type ProcessKind = 'terminal' | 'agent' | 'batch' | 'synopsis' | 'wizard' | 'wizard-gen';

interface ProcessRow {
	processSessionId: string;
	baseSessionId: string;
	session: Session;
	kind: ProcessKind;
	tabId?: string;
	tabName?: string;
	pid: number;
	toolType: string;
	cwd: string;
	startTime?: number;
	commandLine: string;
	recentOutput?: string;
}

interface ProcessGroup {
	baseSessionId: string;
	session: Session;
	rows: ProcessRow[];
	newestStartTime: number;
}

interface ProcessesPanelProps {
	theme: Theme;
	activeSession: Session;
	sessions: Session[];
	onNavigateToSession: (sessionId: string, tabId?: string) => void;
}

const parseBaseSessionId = (processSessionId: string): string => {
	const aiTabMatch = processSessionId.match(/^(.*)-ai-.+$/);
	if (aiTabMatch && aiTabMatch[1]) {
		return aiTabMatch[1];
	}

	const knownSuffixes = ['-ai', '-terminal'];
	for (const suffix of knownSuffixes) {
		if (processSessionId.endsWith(suffix)) {
			return processSessionId.slice(0, -suffix.length);
		}
	}

	const batchOrSynopsisMatch = processSessionId.match(/^(.*)-(batch|synopsis)-\d+$/);
	if (batchOrSynopsisMatch && batchOrSynopsisMatch[1]) {
		return batchOrSynopsisMatch[1];
	}

	return processSessionId;
};

const parseTabId = (processSessionId: string): string | undefined => {
	const match = processSessionId.match(/-ai-(.+)$/);
	return match?.[1];
};

const classifyProcessKind = (processSessionId: string): ProcessKind => {
	if (processSessionId.endsWith('-terminal')) return 'terminal';
	if (processSessionId.match(/-batch-\d+$/)) return 'batch';
	if (processSessionId.match(/-synopsis-\d+$/)) return 'synopsis';
	if (processSessionId.startsWith('inline-wizard-gen-')) return 'wizard-gen';
	if (processSessionId.startsWith('inline-wizard-')) return 'wizard';
	return 'agent';
};

const formatRuntime = (startTime: number, nowMs: number): string => {
	const elapsed = Math.max(0, nowMs - startTime);
	const totalSeconds = Math.floor(elapsed / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
};

const getMostRecentOutput = (logs: LogEntry[]): string | undefined => {
	for (let i = logs.length - 1; i >= 0; i--) {
		const entry = logs[i];
		if (!entry?.text?.trim()) continue;
		if (entry.source === 'stdout' || entry.source === 'stderr' || entry.source === 'ai') {
			return entry.text.trim();
		}
	}
	return undefined;
};

const summarizeForCard = (text: string, max = 220): string => {
	const compact = text.replace(/\s+/g, ' ').trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 1)}…`;
};

const getProcessTitle = (row: ProcessRow): string => {
	if (row.kind === 'terminal') return 'Terminal';
	if (row.kind === 'batch') return 'Auto Run';
	if (row.kind === 'synopsis') return 'Synopsis';
	if (row.kind === 'wizard') return 'Wizard';
	if (row.kind === 'wizard-gen') return 'Wizard Generation';
	if (row.tabName) return `AI Tab · ${row.tabName}`;
	return 'AI Tab';
};

export const ProcessesPanel = React.memo(function ProcessesPanel({
	theme,
	activeSession,
	sessions,
	onNavigateToSession,
}: ProcessesPanelProps) {
	const [scope, setScope] = useState<ProcessScope>('session');
	const [kindFilter, setKindFilter] = useState<ProcessKindFilter>('all');
	const [activeProcesses, setActiveProcesses] = useState<ActiveProcessInfo[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [killingProcessId, setKillingProcessId] = useState<string | null>(null);
	const [expandedProcesses, setExpandedProcesses] = useState<Set<string>>(new Set());
	const [nowMs, setNowMs] = useState(() => Date.now());

	const fetchActiveProcesses = useCallback(async (showSpinner = false) => {
		if (showSpinner) {
			setIsRefreshing(true);
		}

		try {
			const processes = await window.maestro.process.getActiveProcesses();
			setActiveProcesses(processes);
		} catch (error) {
			console.error('[ProcessesPanel] Failed to fetch active processes:', error);
		} finally {
			setIsLoading(false);
			if (showSpinner) {
				setTimeout(() => setIsRefreshing(false), 300);
			}
		}
	}, []);

	useEffect(() => {
		fetchActiveProcesses();
		const pollInterval = setInterval(() => fetchActiveProcesses(), 2000);
		return () => clearInterval(pollInterval);
	}, [fetchActiveProcesses]);

	useEffect(() => {
		const runtimeTimer = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(runtimeTimer);
	}, []);

	const sessionIdsInScope = useMemo(() => {
		if (scope === 'session') {
			return new Set([activeSession.id]);
		}
		return new Set(
			sessions
				.filter((session) => session.toolType === activeSession.toolType)
				.map((session) => session.id)
		);
	}, [scope, activeSession.id, activeSession.toolType, sessions]);

	const rows = useMemo<ProcessRow[]>(() => {
		const sessionById = new Map(sessions.map((session) => [session.id, session]));
		const mapped: ProcessRow[] = [];

		for (const proc of activeProcesses) {
			const baseSessionId = parseBaseSessionId(proc.sessionId);
			const session = sessionById.get(baseSessionId);
			if (!session) continue;

			const kind = classifyProcessKind(proc.sessionId);
			const tabId = parseTabId(proc.sessionId);
			const tab = tabId ? session.aiTabs.find((t) => t.id === tabId) : undefined;
			const activeTab = session.aiTabs.find((t) => t.id === session.activeTabId);

			const logsForPreview =
				kind === 'terminal'
					? session.shellLogs
					: tab?.logs || activeTab?.logs || session.aiLogs || [];

			const commandParts = [proc.command, ...(proc.args ?? [])].filter((part): part is string =>
				Boolean(part && part.trim())
			);

			mapped.push({
				processSessionId: proc.sessionId,
				baseSessionId,
				session,
				kind,
				tabId,
				tabName: tab?.name || tab?.agentSessionId || undefined,
				pid: proc.pid,
				toolType: proc.toolType,
				cwd: proc.cwd,
				startTime: proc.startTime,
				commandLine: commandParts.join(' ').trim(),
				recentOutput: getMostRecentOutput(logsForPreview),
			});
		}

		return mapped
			.filter((row) => sessionIdsInScope.has(row.baseSessionId))
			.filter((row) => {
				if (kindFilter === 'all') return true;
				if (kindFilter === 'terminal') return row.kind === 'terminal';
				return row.kind !== 'terminal';
			})
			.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
	}, [activeProcesses, sessions, sessionIdsInScope, kindFilter]);

	const groups = useMemo<ProcessGroup[]>(() => {
		const grouped = new Map<string, ProcessGroup>();

		for (const row of rows) {
			const existing = grouped.get(row.baseSessionId);
			if (existing) {
				existing.rows.push(row);
				existing.newestStartTime = Math.max(existing.newestStartTime, row.startTime ?? 0);
				continue;
			}
			grouped.set(row.baseSessionId, {
				baseSessionId: row.baseSessionId,
				session: row.session,
				rows: [row],
				newestStartTime: row.startTime ?? 0,
			});
		}

		return Array.from(grouped.values())
			.map((group) => ({
				...group,
				rows: [...group.rows].sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0)),
			}))
			.sort((a, b) => b.newestStartTime - a.newestStartTime);
	}, [rows]);

	const handleKillProcess = useCallback(
		async (processSessionId: string) => {
			setKillingProcessId(processSessionId);
			try {
				await window.maestro.process.kill(processSessionId);
				await fetchActiveProcesses(true);
			} catch (error) {
				console.error('[ProcessesPanel] Failed to kill process:', error);
			} finally {
				setKillingProcessId(null);
			}
		},
		[fetchActiveProcesses]
	);

	const toggleProcessExpanded = useCallback((processSessionId: string) => {
		setExpandedProcesses((prev) => {
			const next = new Set(prev);
			if (next.has(processSessionId)) {
				next.delete(processSessionId);
			} else {
				next.add(processSessionId);
			}
			return next;
		});
	}, []);

	const agentLabel = activeSession.toolType.toUpperCase();

	return (
		<div className="h-full flex flex-col gap-3 py-3">
			<div
				className="rounded-lg border p-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="flex items-center justify-between gap-2 mb-3">
					<div className="flex items-center gap-2 min-w-0">
						<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<div
							className="text-sm font-semibold truncate"
							style={{ color: theme.colors.textMain }}
						>
							Active Processes
						</div>
						<span
							className="text-[10px] px-2 py-0.5 rounded-full font-mono"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						>
							{rows.length} running
						</span>
					</div>
					<button
						onClick={() => fetchActiveProcesses(true)}
						className="p-1.5 rounded border transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
						title="Refresh process list"
					>
						<RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
					</button>
				</div>

				<div className="flex flex-wrap gap-2 mb-2">
					{(
						[
							{ id: 'session', label: 'This Session' },
							{ id: 'agent', label: `All ${agentLabel}` },
						] as const
					).map((option) => {
						const active = scope === option.id;
						return (
							<button
								key={option.id}
								onClick={() => setScope(option.id)}
								className="text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors"
								style={{
									borderColor: active ? theme.colors.accent : theme.colors.border,
									backgroundColor: active ? `${theme.colors.accent}22` : theme.colors.bgMain,
									color: active ? theme.colors.accent : theme.colors.textDim,
								}}
							>
								{option.label}
							</button>
						);
					})}
				</div>

				<div className="flex flex-wrap gap-2">
					{(
						[
							{ id: 'all', label: 'All' },
							{ id: 'terminal', label: 'Terminal' },
							{ id: 'agent', label: 'Agent' },
						] as const
					).map((option) => {
						const active = kindFilter === option.id;
						return (
							<button
								key={option.id}
								onClick={() => setKindFilter(option.id)}
								className="text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors"
								style={{
									borderColor: active ? theme.colors.accent : theme.colors.border,
									backgroundColor: active ? `${theme.colors.accent}22` : theme.colors.bgMain,
									color: active ? theme.colors.accent : theme.colors.textDim,
								}}
							>
								{option.label}
							</button>
						);
					})}
				</div>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-2">
				{isLoading ? (
					<div
						className="rounded-lg border p-4 text-sm flex items-center gap-2"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						<Loader2 className="w-4 h-4 animate-spin" />
						Loading active processes...
					</div>
				) : groups.length === 0 ? (
					<div
						className="rounded-lg border p-4 text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						No active processes for this filter.
					</div>
				) : (
					groups.map((group) => (
						<div
							key={group.baseSessionId}
							className="rounded-lg border p-3"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							<div className="flex items-center justify-between gap-2 mb-2">
								<div className="min-w-0">
									<div className="flex items-center gap-2 min-w-0">
										<Bot className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
										<span
											className="text-xs font-semibold truncate"
											style={{ color: theme.colors.textMain }}
										>
											{group.session.name}
										</span>
										<span
											className="text-[10px] px-1.5 py-0.5 rounded-full font-mono"
											style={{
												backgroundColor: theme.colors.bgActivity,
												color: theme.colors.textDim,
											}}
										>
											{group.rows.length} run{group.rows.length === 1 ? '' : 's'}
										</span>
									</div>
									<div className="text-[11px] mt-1" style={{ color: theme.colors.textDim }}>
										{group.session.toolType} • {group.session.cwd}
									</div>
								</div>
								<button
									onClick={() => onNavigateToSession(group.baseSessionId)}
									className="text-[11px] px-2.5 py-1 rounded border font-medium transition-colors shrink-0"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										backgroundColor: theme.colors.bgMain,
									}}
								>
									Open Session
								</button>
							</div>

							<div className="space-y-2">
								{group.rows.map((row) => {
									const isTerminal = row.kind === 'terminal';
									const isKilling = killingProcessId === row.processSessionId;
									const isExpanded = expandedProcesses.has(row.processSessionId);
									const runtimeLabel = row.startTime
										? formatRuntime(row.startTime, nowMs)
										: 'running';
									const collapsedSummary = summarizeForCard(
										row.commandLine || row.recentOutput || row.cwd,
										120
									);

									return (
										<div
											key={row.processSessionId}
											className="rounded-md border p-2.5"
											style={{
												borderColor: isTerminal ? `${theme.colors.accent}80` : theme.colors.border,
												backgroundColor: theme.colors.bgActivity,
											}}
										>
											<div className="flex items-start justify-between gap-2 mb-2">
												<button
													onClick={() => toggleProcessExpanded(row.processSessionId)}
													className="min-w-0 text-left flex-1"
													title={isExpanded ? 'Hide details' : 'Show details'}
												>
													<div className="flex items-center gap-2 min-w-0">
														{isTerminal ? (
															<Terminal
																className="w-3.5 h-3.5 shrink-0"
																style={{ color: theme.colors.accent }}
															/>
														) : (
															<ChevronsRight
																className="w-3.5 h-3.5 shrink-0"
																style={{ color: theme.colors.accent }}
															/>
														)}
														<span
															className="text-[11px] font-semibold truncate"
															style={{ color: theme.colors.textMain }}
														>
															{getProcessTitle(row)}
														</span>
														<span
															className="text-[10px] px-1.5 py-0.5 rounded font-mono uppercase shrink-0"
															style={{
																backgroundColor: theme.colors.bgMain,
																color: theme.colors.textDim,
															}}
														>
															{row.kind}
														</span>
													</div>
													<div
														className="text-[11px] mt-1 truncate"
														style={{ color: theme.colors.textDim }}
													>
														PID {row.pid} · {collapsedSummary}
													</div>
												</button>
												<div className="flex items-center gap-2 shrink-0">
													<button
														onClick={() => toggleProcessExpanded(row.processSessionId)}
														className="text-[10px] px-2 py-1 rounded border font-medium transition-colors"
														style={{
															borderColor: theme.colors.border,
															color: theme.colors.textDim,
															backgroundColor: theme.colors.bgMain,
														}}
													>
														{isExpanded ? 'Hide' : 'Details'}
													</button>
													<div
														className="text-[11px] font-mono px-2 py-0.5 rounded-full flex items-center gap-1.5"
														style={{
															backgroundColor: `${theme.colors.success}20`,
															color: theme.colors.success,
														}}
													>
														<span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse bg-current" />
														{runtimeLabel}
													</div>
												</div>
											</div>

											{isExpanded && row.commandLine ? (
												<div
													className="text-[11px] font-mono rounded p-2 mb-2 overflow-x-auto"
													style={{
														backgroundColor: theme.colors.bgMain,
														color: theme.colors.textMain,
														border: `1px solid ${theme.colors.border}`,
													}}
													title={row.commandLine}
												>
													{row.commandLine}
												</div>
											) : null}

											{isExpanded ? (
												<div
													className="text-[11px] flex items-center gap-1.5 mb-2"
													style={{ color: theme.colors.textDim }}
												>
													<FolderOpen className="w-3 h-3 shrink-0" />
													<span className="truncate" title={row.cwd}>
														{row.cwd}
													</span>
												</div>
											) : null}

											{isExpanded && row.recentOutput ? (
												<div
													className="text-[11px] rounded p-2 mb-2"
													style={{
														backgroundColor: theme.colors.bgMain,
														border: `1px solid ${theme.colors.border}`,
														color: theme.colors.textDim,
													}}
													title={row.recentOutput}
												>
													{summarizeForCard(row.recentOutput)}
												</div>
											) : null}

											<div className="flex items-center gap-2">
												<button
													onClick={() => onNavigateToSession(row.baseSessionId, row.tabId)}
													className="text-[11px] px-2.5 py-1 rounded border font-medium transition-colors"
													style={{
														borderColor: theme.colors.border,
														color: theme.colors.textMain,
														backgroundColor: theme.colors.bgMain,
													}}
												>
													Open Run
												</button>
												<button
													onClick={() => handleKillProcess(row.processSessionId)}
													disabled={isKilling}
													className="text-[11px] px-2.5 py-1 rounded border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
													style={{
														borderColor: theme.colors.error,
														color: theme.colors.error,
														backgroundColor: `${theme.colors.error}12`,
													}}
													title="Stop this process"
												>
													{isKilling ? (
														<Loader2 className="w-3 h-3 animate-spin" />
													) : (
														<Square className="w-3 h-3" />
													)}
													Stop
												</button>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
});
