import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
	FolderKanban,
	Search,
} from 'lucide-react';
import type {
	Theme,
	Group,
	ConductorTask,
	ConductorTaskPriority,
	ConductorTaskStatus,
} from '../types';
import { useConductorStore } from '../stores/conductorStore';
import { useSessionStore } from '../stores/sessionStore';

interface ConductorHomePanelProps {
	theme: Theme;
}

type BacklogStatusFilter = 'all' | ConductorTaskStatus;
type BacklogSourceFilter = 'all' | ConductorTask['source'];
type BacklogSort = 'priority' | 'updated_desc' | 'updated_asc' | 'workspace' | 'title';

const BOARD_COLUMNS: ConductorTaskStatus[] = [
	'draft',
	'planning',
	'ready',
	'running',
	'needs_input',
	'blocked',
	'needs_review',
	'cancelled',
	'done',
];

const STATUS_LABELS: Record<ConductorTaskStatus, string> = {
	draft: 'Brainstorm',
	planning: 'Planning',
	ready: 'Ready',
	running: 'In progress',
	needs_input: 'Needs input',
	blocked: 'Blocked',
	needs_review: 'Check me',
	cancelled: 'Stopped',
	done: 'Done',
};


function formatRelativeTime(timestamp: number): string {
	const elapsedMs = Date.now() - timestamp;
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;

	if (elapsedMs < minute) {
		return 'Just now';
	}
	if (elapsedMs < hour) {
		return `${Math.round(elapsedMs / minute)}m ago`;
	}
	if (elapsedMs < day) {
		return `${Math.round(elapsedMs / hour)}h ago`;
	}
	return `${Math.round(elapsedMs / day)}d ago`;
}

function getPanelStyle(theme: Theme, tint = 'rgba(255,255,255,0.06)', border = 'rgba(255,255,255,0.08)') {
	return {
		background: `linear-gradient(180deg, ${tint} 0%, rgba(255,255,255,0.02) 100%)`,
		backgroundColor: theme.colors.bgSidebar,
		border: `1px solid ${border}`,
		boxShadow:
			'0 20px 44px rgba(15, 23, 42, 0.10), 0 8px 18px rgba(15, 23, 42, 0.06), 0 1px 0 rgba(255,255,255,0.10) inset',
		backdropFilter: 'blur(18px) saturate(125%)',
		WebkitBackdropFilter: 'blur(18px) saturate(125%)',
	} as CSSProperties;
}

function getInputStyle(theme: Theme) {
	return {
		backgroundColor: `${theme.colors.bgSidebar}cc`,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	} as CSSProperties;
}

// Spring pastel palette - each status gets a distinct soft color
const PASTEL_TONES: Record<ConductorTaskStatus, { fg: string; bg: string; border: string }> = {
	draft:        { fg: '#b0b8c4', bg: '#b0b8c412', border: '#b0b8c428' },     // soft gray
	planning:     { fg: '#a78bfa', bg: '#a78bfa12', border: '#a78bfa28' },     // lavender
	ready:        { fg: '#60a5fa', bg: '#60a5fa12', border: '#60a5fa28' },     // sky blue
	running:      { fg: '#818cf8', bg: '#818cf812', border: '#818cf828' },     // periwinkle
	needs_input:  { fg: '#fbbf24', bg: '#fbbf2412', border: '#fbbf2428' },     // buttercup
	blocked:      { fg: '#fb923c', bg: '#fb923c12', border: '#fb923c28' },     // peach
	needs_review: { fg: '#f9a8d4', bg: '#f9a8d412', border: '#f9a8d428' },    // rose pink
	cancelled:    { fg: '#94a3b8', bg: '#94a3b812', border: '#94a3b828' },     // slate
	done:         { fg: '#86efac', bg: '#86efac12', border: '#86efac28' },     // mint green
};

function getStatusTone(_theme: Theme, status: ConductorTaskStatus) {
	return PASTEL_TONES[status] ?? PASTEL_TONES.draft;
}

function getPriorityTone(theme: Theme, priority: ConductorTaskPriority) {
	switch (priority) {
		case 'critical':
			return { bg: `${theme.colors.error}14`, border: `${theme.colors.error}38`, fg: theme.colors.error };
		case 'high':
			return {
				bg: `${theme.colors.warning}14`,
				border: `${theme.colors.warning}38`,
				fg: theme.colors.warning,
			};
		case 'medium':
			return { bg: `${theme.colors.accent}14`, border: `${theme.colors.accent}38`, fg: theme.colors.accent };
		case 'low':
		default:
			return {
				bg: `${theme.colors.textDim}16`,
				border: `${theme.colors.textDim}30`,
				fg: theme.colors.textDim,
			};
	}
}

function getWorkspaceName(groupsById: Map<string, Group>, groupId: string): string {
	return groupsById.get(groupId)?.name || 'Unknown workspace';
}

export function ConductorHomePanel({ theme }: ConductorHomePanelProps): JSX.Element {
	const tasks = useConductorStore((s) => s.tasks);
	const runs = useConductorStore((s) => s.runs);
	const setActiveConductorView = useConductorStore((s) => s.setActiveConductorView);
	const groups = useSessionStore((s) => s.groups);
	const [taskSearch, setTaskSearch] = useState('');
	const [statusFilter] = useState<BacklogStatusFilter>('all');
	const [sourceFilter] = useState<BacklogSourceFilter>('all');
	const [workspaceFilter, setWorkspaceFilter] = useState<'all' | string>('all');
	const [sortMode, setSortMode] = useState<BacklogSort>('priority');
	const boardScrollRef = useRef<HTMLDivElement>(null);

	const scrollToColumn = useCallback((status: ConductorTaskStatus) => {
		const container = boardScrollRef.current;
		if (!container) return;
		const column = container.querySelector(`[data-column-status="${status}"]`);
		if (column) {
			column.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
		}
	}, []);

	const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
	const workspaceOptions = useMemo(
		() =>
			groups
				.filter((group) => tasks.some((task) => task.groupId === group.id))
				.sort((left, right) => left.name.localeCompare(right.name)),
		[groups, tasks]
	);

	const filteredTasks = useMemo(() => {
		const search = taskSearch.trim().toLowerCase();
		const priorityRank = new Map<ConductorTaskPriority, number>([
			['critical', 0],
			['high', 1],
			['medium', 2],
			['low', 3],
		]);

		const matchesSearch = (task: ConductorTask) => {
			if (!search) {
				return true;
			}

			return [
				task.title,
				task.description,
				task.source,
				getWorkspaceName(groupsById, task.groupId),
				...task.scopePaths,
				...task.acceptanceCriteria,
			]
				.join(' ')
				.toLowerCase()
				.includes(search);
		};

		return tasks
			.filter((task) => (statusFilter === 'all' ? true : task.status === statusFilter))
			.filter((task) => (sourceFilter === 'all' ? true : task.source === sourceFilter))
			.filter((task) => (workspaceFilter === 'all' ? true : task.groupId === workspaceFilter))
			.filter(matchesSearch)
			.sort((left, right) => {
				switch (sortMode) {
					case 'title':
						return left.title.localeCompare(right.title);
					case 'workspace':
						return getWorkspaceName(groupsById, left.groupId).localeCompare(
							getWorkspaceName(groupsById, right.groupId)
						);
					case 'updated_asc':
						return left.updatedAt - right.updatedAt;
					case 'updated_desc':
						return right.updatedAt - left.updatedAt;
					case 'priority':
					default: {
						const priorityDiff =
							(priorityRank.get(left.priority) ?? 99) - (priorityRank.get(right.priority) ?? 99);
						if (priorityDiff !== 0) {
							return priorityDiff;
						}
						return right.updatedAt - left.updatedAt;
					}
				}
			});
	}, [groupsById, sortMode, sourceFilter, statusFilter, taskSearch, tasks, workspaceFilter]);

	const taskCounts = useMemo(
		() => ({
			total: tasks.length,
			open: tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled').length,
			running: tasks.filter((task) => task.status === 'running' || task.status === 'planning').length,
			attention: tasks.filter(
				(task) =>
					task.status === 'needs_input' ||
					task.status === 'blocked' ||
					task.status === 'needs_review'
			).length,
			done: tasks.filter((task) => task.status === 'done').length,
		}),
		[tasks]
	);

	const latestEvents = useMemo(
		() =>
			runs
				.flatMap((run) =>
					run.events.map((event) => ({
						...event,
						runSummary: run.summary,
					}))
				)
				.sort((left, right) => right.createdAt - left.createdAt)
				.slice(0, 8),
		[runs]
	);

	const taskCountsByStatus = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const status of BOARD_COLUMNS) {
			counts[status] = tasks.filter((t) => t.status === status).length;
		}
		return counts;
	}, [tasks]);

	return (
		<div
			className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-4"
		>
			<div className="max-w-[1600px] mx-auto space-y-4">
				<div
					className="flex items-center justify-between gap-4 pb-4"
					style={{ borderBottom: `1px solid rgba(255,255,255,0.08)` }}
				>
					<div className="flex items-center gap-3">
						<div
							className="w-8 h-8 rounded-lg flex items-center justify-center"
							style={{
								backgroundColor: `${theme.colors.accent}18`,
								border: `1px solid ${theme.colors.accent}30`,
							}}
						>
							<FolderKanban className="w-4 h-4" style={{ color: theme.colors.accent }} />
						</div>
						<h1 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							Kanban
						</h1>
					</div>
					<div className="flex items-center gap-1">
						{[
							{ label: 'Open', value: taskCounts.open, tone: '#60a5fa' },      // sky blue
							{ label: 'Active', value: taskCounts.running, tone: '#818cf8' },   // periwinkle
							{ label: 'Attention', value: taskCounts.attention, tone: '#fb923c' }, // peach
							{ label: 'Done', value: taskCounts.done, tone: '#86efac' },        // mint
						].map((stat) => (
							<div
								key={stat.label}
								className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg"
								style={{
									backgroundColor: stat.value > 0 ? `${stat.tone}10` : 'transparent',
								}}
							>
								<span
									className="w-2 h-2 rounded-full"
									style={{
										backgroundColor: stat.tone,
										opacity: stat.value > 0 ? 1 : 0.3,
									}}
								/>
								<span className="text-xs" style={{ color: theme.colors.textDim }}>{stat.label}</span>
								<span className="text-xs font-semibold" style={{ color: stat.value > 0 ? stat.tone : theme.colors.textDim }}>
									{stat.value}
								</span>
							</div>
						))}
					</div>
				</div>

				<div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_280px] gap-4">
					<div className="space-y-4 min-w-0">
						<div className="space-y-3">
							<div className="flex flex-wrap items-center gap-2">
								<div className="relative flex-1 min-w-[200px] max-w-[280px]">
									<Search
										className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
										style={{ color: theme.colors.textDim }}
									/>
									<input
										value={taskSearch}
										onChange={(e) => setTaskSearch(e.target.value)}
										placeholder="Search tasks..."
										className="w-full rounded-lg border pl-8 pr-3 py-1.5 text-sm"
										style={getInputStyle(theme)}
									/>
								</div>
								<select
									value={workspaceFilter}
									onChange={(e) => setWorkspaceFilter(e.target.value)}
									className="rounded-lg border px-2 py-1.5 text-sm"
									style={getInputStyle(theme)}
								>
									<option value="all">All workspaces</option>
									{workspaceOptions.map((workspace) => (
										<option key={workspace.id} value={workspace.id}>
											{workspace.name}
										</option>
									))}
								</select>
								<select
									value={sortMode}
									onChange={(e) => setSortMode(e.target.value as BacklogSort)}
									className="rounded-lg border px-2 py-1.5 text-sm"
									style={getInputStyle(theme)}
								>
									<option value="priority">Priority</option>
									<option value="updated_desc">Newest</option>
									<option value="updated_asc">Oldest</option>
									<option value="workspace">Workspace</option>
									<option value="title">Title</option>
								</select>
							</div>
							{/* Clickable status nav - scrolls to column */}
							<div className="flex items-center gap-1 overflow-x-auto scrollbar-thin">
								{BOARD_COLUMNS.map((status) => {
									const tone = getStatusTone(theme, status);
									const count = taskCountsByStatus[status] ?? 0;
									return (
										<button
											key={status}
											type="button"
											onClick={() => scrollToColumn(status)}
											className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors hover:bg-white/5 shrink-0"
										>
											<span
												className="w-2.5 h-2.5 rounded-full shrink-0"
												style={{ backgroundColor: tone.fg }}
											/>
											<span style={{ color: theme.colors.textMain }}>
												{STATUS_LABELS[status]}
											</span>
											<span className="font-semibold" style={{ color: count > 0 ? tone.fg : theme.colors.textDim }}>
												{count}
											</span>
										</button>
									);
								})}
							</div>
						</div>

						{filteredTasks.length === 0 ? (
							<div className="rounded-2xl border p-12 text-center" style={getPanelStyle(theme)}>
								<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
									No tasks match these filters
								</h2>
								<p className="text-sm mt-2" style={{ color: theme.colors.textDim }}>
									Try widening the filters or open a workspace board to add work.
								</p>
							</div>
						) : (
							<div ref={boardScrollRef} className="overflow-x-auto pb-2 scrollbar-thin">
								<div className="flex gap-3 min-w-[1180px]">
									{BOARD_COLUMNS.map((status) => {
										const columnTasks = filteredTasks.filter((task) => task.status === status);
										if (columnTasks.length === 0 && ['cancelled', 'planning', 'draft'].includes(status)) {
											return null;
										}
										const tone = getStatusTone(theme, status);
										return (
											<div
												key={status}
												data-column-status={status}
												className="rounded-xl flex-1 min-w-[200px] min-h-[200px] flex flex-col overflow-hidden"
												style={{
													backgroundColor: `${theme.colors.bgSidebar}`,
													border: `1px solid ${tone.border}`,
													boxShadow: `0 2px 8px rgba(0,0,0,0.08)`,
												}}
											>
												{/* Colored top bar */}
												<div
													className="h-1 w-full shrink-0"
													style={{ backgroundColor: tone.fg }}
												/>
												{/* Column header */}
												<div className="flex items-center gap-2 px-3 py-2.5" style={{
													backgroundColor: `${tone.fg}08`,
													borderBottom: `1px solid ${tone.border}`,
												}}>
													<span className="text-sm font-semibold" style={{ color: tone.fg }}>
														{STATUS_LABELS[status]}
													</span>
													<span
														className="ml-auto text-[11px] font-medium px-1.5 py-0.5 rounded-full"
														style={{
															backgroundColor: `${tone.fg}18`,
															color: tone.fg,
														}}
													>
														{columnTasks.length}
													</span>
												</div>
												{/* Cards */}
												<div className="flex-1 p-2 space-y-2 overflow-y-auto scrollbar-thin">
													{columnTasks.map((task) => {
														const priorityTone = getPriorityTone(theme, task.priority);
														return (
															<button
																type="button"
																key={task.id}
																onClick={() =>
																	setActiveConductorView({
																		scope: 'workspace',
																		groupId: task.groupId,
																	})
																}
																className="w-full text-left rounded-lg overflow-hidden transition-all hover:translate-y-[-1px] hover:shadow-lg"
																style={{
																	backgroundColor: theme.colors.bgMain,
																	border: `1px solid rgba(255,255,255,0.08)`,
																	boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)',
																}}
															>
																{/* Priority accent - top bar */}
																<div
																	className="h-[3px] w-full"
																	style={{ backgroundColor: priorityTone.fg }}
																/>
																<div className="p-2.5">
																	<div
																		className="text-sm font-medium leading-tight"
																		style={{ color: theme.colors.textMain }}
																	>
																		{task.title}
																	</div>
																	{task.description && (
																		<p
																			className="text-xs mt-1.5 line-clamp-2 leading-relaxed"
																			style={{ color: theme.colors.textDim }}
																		>
																			{task.description}
																		</p>
																	)}
																	<div className="flex items-center gap-2 mt-2 text-[11px]" style={{ color: theme.colors.textDim }}>
																		<span
																			className="px-1.5 py-0.5 rounded truncate"
																			style={{
																				backgroundColor: `${theme.colors.accent}12`,
																				color: theme.colors.accent,
																			}}
																		>
																			{getWorkspaceName(groupsById, task.groupId)}
																		</span>
																		<span className="shrink-0">{formatRelativeTime(task.updatedAt)}</span>
																	</div>
																</div>
															</button>
														);
													})}
												</div>
											</div>
										);
									})}
								</div>
							</div>
						)}
					</div>

					<div className="space-y-3">
						<div
							className="rounded-xl overflow-hidden"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								border: `1px solid rgba(255,255,255,0.08)`,
								boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
							}}
						>
							<div
								className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider"
								style={{
									color: theme.colors.textDim,
									borderBottom: '1px solid rgba(255,255,255,0.06)',
									backgroundColor: 'rgba(255,255,255,0.03)',
								}}
							>
								Workspaces
							</div>
							<div className="p-1.5">
								{workspaceOptions.length === 0 ? (
									<div className="text-xs px-3 py-2" style={{ color: theme.colors.textDim }}>
										No workspace boards yet.
									</div>
								) : (
									workspaceOptions.map((workspace) => {
										const workspaceTasks = tasks.filter((task) => task.groupId === workspace.id);
										const runningCount = workspaceTasks.filter(
											(task) => task.status === 'running' || task.status === 'planning'
										).length;
										const openCount = workspaceTasks.filter(
											(task) => task.status !== 'done' && task.status !== 'cancelled'
										).length;
										return (
											<button
												key={workspace.id}
												type="button"
												onClick={() =>
													setActiveConductorView({
														scope: 'workspace',
														groupId: workspace.id,
													})
												}
												className="w-full text-left rounded-lg px-3 py-2 transition-colors hover:bg-white/5 flex items-center justify-between gap-2"
											>
												<div className="min-w-0 flex items-center gap-2">
													<span className="text-sm">{workspace.emoji}</span>
													<span
														className="text-sm truncate"
														style={{ color: theme.colors.textMain }}
													>
														{workspace.name}
													</span>
												</div>
												<div className="flex items-center gap-2 shrink-0 text-xs" style={{ color: theme.colors.textDim }}>
													<span>{openCount} open</span>
													{runningCount > 0 && (
														<span
															className="w-2 h-2 rounded-full animate-pulse"
															style={{ backgroundColor: theme.colors.accent }}
														/>
													)}
												</div>
											</button>
										);
									})
								)}
							</div>
						</div>

						<div
							className="rounded-xl overflow-hidden"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								border: `1px solid rgba(255,255,255,0.08)`,
								boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
							}}
						>
							<div
								className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider"
								style={{
									color: theme.colors.textDim,
									borderBottom: '1px solid rgba(255,255,255,0.06)',
									backgroundColor: 'rgba(255,255,255,0.03)',
								}}
							>
								Recent activity
							</div>
							<div className="p-1.5">
								{latestEvents.length === 0 ? (
									<div className="text-xs px-3 py-2" style={{ color: theme.colors.textDim }}>
										No activity yet.
									</div>
								) : (
									latestEvents.map((event) => (
										<div
											key={event.id}
											className="px-3 py-2 rounded-lg"
										>
											<div className="text-sm leading-5" style={{ color: theme.colors.textMain }}>
												{event.message}
											</div>
											<div className="text-[11px] mt-1" style={{ color: theme.colors.textDim }}>
												{getWorkspaceName(groupsById, event.groupId)} · {formatRelativeTime(event.createdAt)}
											</div>
										</div>
									))
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
