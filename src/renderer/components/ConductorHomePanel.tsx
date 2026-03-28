import { useCallback, useMemo, useRef, useState } from 'react';
import { FolderKanban, Search } from 'lucide-react';
import type {
	Theme,
	Group,
	ConductorTask,
	ConductorTaskPriority,
	ConductorTaskStatus,
} from '../types';
import { useConductorStore } from '../stores/conductorStore';
import { useSessionStore } from '../stores/sessionStore';
import {
	buildConductorChildTaskMap,
	getConductorTaskRollupStatus,
} from '../../shared/conductorTasks';
import { KANBAN_LANES } from './conductor/conductorConstants';
import {
	getTaskStatusTone,
	getTaskPriorityTone,
	getHomePanelStyle,
	getHomeInputStyle,
} from './conductor/conductorStyles';

interface ConductorHomePanelProps {
	theme: Theme;
}

type BacklogStatusFilter = 'all' | ConductorTaskStatus;
type BacklogSourceFilter = 'all' | ConductorTask['source'];
type BacklogSort = 'priority' | 'updated_desc' | 'updated_asc' | 'workspace' | 'title';
const LIVE_CONDUCTOR_STATE_OPTIONS = { allowLegacyFallback: false } as const;

const BOARD_COLUMNS: ConductorTaskStatus[] = [
	'draft',
	'planning',
	'ready',
	'running',
	'needs_review',
	'needs_proof',
	'needs_revision',
	'needs_input',
	'blocked',
	'cancelled',
	'done',
];

const STATUS_LABELS: Record<ConductorTaskStatus, string> = {
	draft: 'Brainstorm',
	planning: 'Planning',
	ready: 'Ready',
	running: 'In progress',
	needs_revision: 'Agents revising',
	needs_input: 'Waiting on you',
	needs_proof: 'Needs proof',
	blocked: 'Blocked',
	needs_review: 'In QA',
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

	const scrollToColumn = useCallback((status: string) => {
		const container = boardScrollRef.current;
		if (!container) return;
		const column = container.querySelector(`[data-column-status="${status}"]`);
		if (column) {
			column.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
		}
	}, []);

	const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
	const childTasksByParentId = useMemo(() => buildConductorChildTaskMap(tasks), [tasks]);
	const presentationStatusByTaskId = useMemo(() => {
		const entries = tasks.map(
			(task) =>
				[
					task.id,
					getConductorTaskRollupStatus(
						task,
						childTasksByParentId,
						runs,
						LIVE_CONDUCTOR_STATE_OPTIONS
					),
				] as const
		);
		return new Map(entries);
	}, [childTasksByParentId, runs, tasks]);
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
			.filter((task) =>
				statusFilter === 'all'
					? true
					: (presentationStatusByTaskId.get(task.id) || task.status) === statusFilter
			)
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
	}, [
		groupsById,
		presentationStatusByTaskId,
		sortMode,
		sourceFilter,
		statusFilter,
		taskSearch,
		tasks,
		workspaceFilter,
	]);

	const taskCounts = useMemo(
		() => ({
			total: tasks.length,
			open: tasks.filter((task) => {
				const status = presentationStatusByTaskId.get(task.id) || task.status;
				return status !== 'done' && status !== 'cancelled';
			}).length,
			running: tasks.filter((task) => {
				const status = presentationStatusByTaskId.get(task.id) || task.status;
				return status === 'running' || status === 'planning';
			}).length,
			attention: tasks.filter((task) => {
				const status = presentationStatusByTaskId.get(task.id) || task.status;
				return (
					status === 'needs_input' ||
					status === 'needs_proof' ||
					status === 'needs_revision' ||
					status === 'blocked' ||
					status === 'needs_review'
				);
			}).length,
			done: tasks.filter(
				(task) => (presentationStatusByTaskId.get(task.id) || task.status) === 'done'
			).length,
		}),
		[presentationStatusByTaskId, tasks]
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
			counts[status] = tasks.filter(
				(task) => (presentationStatusByTaskId.get(task.id) || task.status) === status
			).length;
		}
		return counts;
	}, [presentationStatusByTaskId, tasks]);

	return (
		<div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-4">
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
							{ label: 'Open', value: taskCounts.open, tone: '#60a5fa' }, // sky blue
							{ label: 'Active', value: taskCounts.running, tone: '#818cf8' }, // periwinkle
							{ label: 'Attention', value: taskCounts.attention, tone: '#fb923c' }, // peach
							{ label: 'Done', value: taskCounts.done, tone: '#86efac' }, // mint
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
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									{stat.label}
								</span>
								<span
									className="text-xs font-semibold"
									style={{ color: stat.value > 0 ? stat.tone : theme.colors.textDim }}
								>
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
										style={getHomeInputStyle(theme)}
									/>
								</div>
								<select
									value={workspaceFilter}
									onChange={(e) => setWorkspaceFilter(e.target.value)}
									className="rounded-lg border px-2 py-1.5 text-sm"
									style={getHomeInputStyle(theme)}
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
									style={getHomeInputStyle(theme)}
								>
									<option value="priority">Priority</option>
									<option value="updated_desc">Newest</option>
									<option value="updated_asc">Oldest</option>
									<option value="workspace">Workspace</option>
									<option value="title">Title</option>
								</select>
							</div>
							{/* Clickable lane nav - scrolls to column */}
							<div className="flex items-center gap-1 overflow-x-auto scrollbar-thin">
								{KANBAN_LANES.map((lane) => {
									const laneCount = lane.statuses.reduce(
										(sum, s) => sum + (taskCountsByStatus[s] ?? 0),
										0
									);
									return (
										<button
											key={lane.key}
											type="button"
											onClick={() => scrollToColumn(lane.key)}
											className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors hover:bg-white/5 shrink-0"
										>
											<span
												className="w-2.5 h-2.5 rounded-full shrink-0"
												style={{ backgroundColor: lane.color }}
											/>
											<span style={{ color: theme.colors.textMain }}>{lane.label}</span>
											<span
												className="font-semibold"
												style={{ color: laneCount > 0 ? lane.color : theme.colors.textDim }}
											>
												{laneCount}
											</span>
										</button>
									);
								})}
							</div>
						</div>

						{filteredTasks.length === 0 ? (
							<div className="rounded-2xl border p-12 text-center" style={getHomePanelStyle(theme)}>
								<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
									No tasks match these filters
								</h2>
								<p className="text-sm mt-2" style={{ color: theme.colors.textDim }}>
									Try widening the filters or open a workspace board to add work.
								</p>
							</div>
						) : (
							<div ref={boardScrollRef} className="overflow-x-auto pb-2 scrollbar-thin">
								<div className="flex gap-3">
									{KANBAN_LANES.map((lane) => {
										const laneTasks = filteredTasks.filter((task) =>
											lane.statuses.includes(presentationStatusByTaskId.get(task.id) || task.status)
										);
										const subCounts = lane.statuses
											.map((s) => {
												const count = laneTasks.filter(
													(t) => (presentationStatusByTaskId.get(t.id) || t.status) === s
												).length;
												return count > 0 ? `${count} ${STATUS_LABELS[s].toLowerCase()}` : null;
											})
											.filter(Boolean);
										return (
											<div
												key={lane.key}
												data-column-status={lane.key}
												className="rounded-xl flex-1 min-w-[180px] min-h-[200px] flex flex-col overflow-hidden"
												style={{
													backgroundColor: `${theme.colors.bgSidebar}`,
													border: `1px solid ${lane.color}3d`,
													boxShadow: `0 2px 8px rgba(0,0,0,0.08)`,
												}}
											>
												{/* Colored top bar */}
												<div
													className="h-1 w-full shrink-0"
													style={{ backgroundColor: lane.color }}
												/>
												{/* Lane header */}
												<div
													className="flex flex-col gap-1 px-3 py-2.5"
													style={{
														backgroundColor: `${lane.color}0d`,
														borderBottom: `1px solid ${lane.color}3d`,
													}}
												>
													<div className="flex items-center gap-2">
														<span className="text-sm font-semibold" style={{ color: lane.color }}>
															{lane.label}
														</span>
														<span
															className="ml-auto text-[11px] font-medium px-1.5 py-0.5 rounded-full"
															style={{
																backgroundColor: `${lane.color}1a`,
																color: lane.color,
															}}
														>
															{laneTasks.length}
														</span>
													</div>
													{subCounts.length > 1 && (
														<div className="text-[11px]" style={{ color: theme.colors.textDim }}>
															{subCounts.join(' · ')}
														</div>
													)}
												</div>
												{/* Cards */}
												<div className="flex-1 p-2 space-y-2 overflow-y-auto scrollbar-thin">
													{laneTasks.map((task) => {
														const taskStatus =
															presentationStatusByTaskId.get(task.id) || task.status;
														const priorityTone = getTaskPriorityTone(theme, task.priority);
														const statusTone = getTaskStatusTone(theme, taskStatus);
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
																	boxShadow:
																		'0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)',
																	borderLeft:
																		lane.statuses.length > 1
																			? `3px solid ${statusTone.fg}`
																			: undefined,
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
																	{lane.statuses.length > 1 && (
																		<span
																			className="inline-block text-[11px] mt-1 px-1.5 py-0.5 rounded"
																			style={{
																				backgroundColor: statusTone.bg,
																				color: statusTone.fg,
																			}}
																		>
																			{STATUS_LABELS[taskStatus]}
																		</span>
																	)}
																	{task.description && (
																		<p
																			className="text-xs mt-1.5 line-clamp-2 leading-relaxed"
																			style={{ color: theme.colors.textDim }}
																		>
																			{task.description}
																		</p>
																	)}
																	<div
																		className="flex items-center gap-2 mt-2 text-[11px]"
																		style={{ color: theme.colors.textDim }}
																	>
																		<span
																			className="px-1.5 py-0.5 rounded truncate"
																			style={{
																				backgroundColor: `${theme.colors.accent}12`,
																				color: theme.colors.accent,
																			}}
																		>
																			{getWorkspaceName(groupsById, task.groupId)}
																		</span>
																		<span className="shrink-0">
																			{formatRelativeTime(task.updatedAt)}
																		</span>
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
										const runningCount = workspaceTasks.filter((task) => {
											const status = presentationStatusByTaskId.get(task.id) || task.status;
											return status === 'running' || status === 'planning';
										}).length;
										const openCount = workspaceTasks.filter((task) => {
											const status = presentationStatusByTaskId.get(task.id) || task.status;
											return status !== 'done' && status !== 'cancelled';
										}).length;
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
												<div
													className="flex items-center gap-2 shrink-0 text-xs"
													style={{ color: theme.colors.textDim }}
												>
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
										<div key={event.id} className="px-3 py-2 rounded-lg">
											<div className="text-sm leading-5" style={{ color: theme.colors.textMain }}>
												{event.message}
											</div>
											<div className="text-[11px] mt-1" style={{ color: theme.colors.textDim }}>
												{getWorkspaceName(groupsById, event.groupId)} ·{' '}
												{formatRelativeTime(event.createdAt)}
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
