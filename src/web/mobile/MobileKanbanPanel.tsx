import { useEffect, useMemo, useState } from 'react';
import {
	ArrowLeft,
	FolderKanban,
	LayoutGrid,
	Loader2,
	Plus,
	RefreshCw,
	Trash2,
	X,
} from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import type {
	Group,
	Conductor,
	ConductorTask,
	ConductorRun,
	ConductorTaskPriority,
	ConductorTaskStatus,
} from '../../shared/types';
import {
	buildConductorMetrics,
	buildWorkspaceSummaries,
	groupTasksByStatus,
	MOBILE_CONDUCTOR_COLUMNS,
	MOBILE_CONDUCTOR_PRIORITY_LABELS,
	MOBILE_CONDUCTOR_STATUS_LABELS,
} from './conductorUtils';

type MobileKanbanScope =
	| { type: 'home' }
	| {
			type: 'workspace';
			groupId: string;
	  };

interface MobileKanbanPanelProps {
	isOpen: boolean;
	scope: MobileKanbanScope | null;
	groups: Group[];
	conductors: Conductor[];
	tasks: ConductorTask[];
	runs: ConductorRun[];
	isLoading: boolean;
	error: string | null;
	onClose: () => void;
	onRefresh: () => Promise<void> | void;
	onOpenHome: () => void;
	onOpenWorkspace: (groupId: string) => void;
	onCreateTask: (input: {
		groupId: string;
		title: string;
		description?: string;
		priority?: ConductorTaskPriority;
		status?: ConductorTaskStatus;
	}) => Promise<void>;
	onUpdateTask: (
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			priority?: ConductorTaskPriority;
			status?: ConductorTaskStatus;
		}
	) => Promise<void>;
	onDeleteTask: (taskId: string) => Promise<void>;
}

interface TaskDraft {
	title: string;
	description: string;
	priority: ConductorTaskPriority;
	status: ConductorTaskStatus;
}

function buildDefaultTaskDraft(): TaskDraft {
	return {
		title: '',
		description: '',
		priority: 'medium',
		status: 'draft',
	};
}

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

export function MobileKanbanPanel({
	isOpen,
	scope,
	groups,
	conductors,
	tasks,
	isLoading,
	error,
	onClose,
	onRefresh,
	onOpenHome,
	onOpenWorkspace,
	onCreateTask,
	onUpdateTask,
	onDeleteTask,
}: MobileKanbanPanelProps): JSX.Element | null {
	const colors = useThemeColors();
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [editorDraft, setEditorDraft] = useState<TaskDraft>(() => buildDefaultTaskDraft());
	const [isCreatingTask, setIsCreatingTask] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const selectedTask = useMemo(
		() => tasks.find((task) => task.id === selectedTaskId) || null,
		[selectedTaskId, tasks]
	);
	const activeGroup =
		scope?.type === 'workspace' ? groups.find((group) => group.id === scope.groupId) || null : null;
	const visibleTasks = useMemo(() => {
		if (scope?.type === 'workspace') {
			return tasks.filter((task) => task.groupId === scope.groupId);
		}
		return tasks;
	}, [scope, tasks]);
	const groupedTasks = useMemo(() => groupTasksByStatus(visibleTasks), [visibleTasks]);
	const metrics = useMemo(() => buildConductorMetrics(visibleTasks), [visibleTasks]);
	const workspaceSummaries = useMemo(() => buildWorkspaceSummaries(groups, tasks), [groups, tasks]);
	const currentConductor = useMemo(
		() =>
			scope?.type === 'workspace'
				? conductors.find((conductor) => conductor.groupId === scope.groupId) || null
				: null,
		[conductors, scope]
	);

	useEffect(() => {
		if (!isOpen) {
			setSelectedTaskId(null);
			setIsCreatingTask(false);
			return;
		}

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = previousOverflow;
		};
	}, [isOpen]);

	useEffect(() => {
		if (!selectedTask) {
			if (!isCreatingTask) {
				setEditorDraft(buildDefaultTaskDraft());
			}
			return;
		}

		setEditorDraft({
			title: selectedTask.title,
			description: selectedTask.description,
			priority: selectedTask.priority,
			status: selectedTask.status,
		});
	}, [isCreatingTask, selectedTask]);

	if (!isOpen || !scope) {
		return null;
	}

	const glassSurface: React.CSSProperties = {
		background:
			'linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 52%, rgba(255,255,255,0.03) 100%)',
		border: '1px solid rgba(255,255,255,0.08)',
		backdropFilter: 'blur(22px)',
		WebkitBackdropFilter: 'blur(22px)',
		boxShadow:
			'0 20px 42px rgba(15, 23, 42, 0.18), 0 8px 18px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255,255,255,0.08)',
	};

	const mutedSurface: React.CSSProperties = {
		background: 'rgba(255,255,255,0.05)',
		border: '1px solid rgba(255,255,255,0.06)',
		boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
	};

	const buttonStyle: React.CSSProperties = {
		height: '40px',
		borderRadius: '14px',
		border: '1px solid rgba(255,255,255,0.08)',
		background: 'rgba(255,255,255,0.08)',
		color: colors.textMain,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '8px',
		padding: '0 14px',
		fontSize: '12px',
		fontWeight: 600,
		cursor: 'pointer',
	};

	const handleTaskOpen = (task: ConductorTask) => {
		setIsCreatingTask(false);
		setSelectedTaskId(task.id);
	};

	const handleStartCreate = () => {
		if (!activeGroup) {
			return;
		}
		setSelectedTaskId(null);
		setEditorDraft(buildDefaultTaskDraft());
		setIsCreatingTask(true);
	};

	const handleCloseEditor = () => {
		setSelectedTaskId(null);
		setIsCreatingTask(false);
		setEditorDraft(buildDefaultTaskDraft());
	};

	const handleSave = async () => {
		if (isSaving) {
			return;
		}

		if (!editorDraft.title.trim()) {
			return;
		}

		setIsSaving(true);
		try {
			if (isCreatingTask && activeGroup) {
				await onCreateTask({
					groupId: activeGroup.id,
					title: editorDraft.title.trim(),
					description: editorDraft.description.trim(),
					priority: editorDraft.priority,
					status: editorDraft.status,
				});
			} else if (selectedTask) {
				await onUpdateTask(selectedTask.id, {
					title: editorDraft.title.trim(),
					description: editorDraft.description.trim(),
					priority: editorDraft.priority,
					status: editorDraft.status,
				});
			}
			handleCloseEditor();
		} finally {
			setIsSaving(false);
		}
	};

	const handleDelete = async () => {
		if (!selectedTask || isSaving) {
			return;
		}

		const confirmed = window.confirm(`Delete task "${selectedTask.title}"?`);
		if (!confirmed) {
			return;
		}

		setIsSaving(true);
		try {
			await onDeleteTask(selectedTask.id);
			handleCloseEditor();
		} finally {
			setIsSaving(false);
		}
	};

	const renderMetricCard = (label: string, value: number, tone: string) => (
		<div
			style={{
				...mutedSurface,
				borderRadius: '18px',
				padding: '14px 14px 12px',
				display: 'flex',
				flexDirection: 'column',
				gap: '4px',
			}}
		>
			<div style={{ fontSize: '11px', color: colors.textDim, fontWeight: 600 }}>{label}</div>
			<div style={{ fontSize: '22px', fontWeight: 700, color: tone }}>{value}</div>
		</div>
	);

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 150,
				background: 'rgba(2, 8, 23, 0.52)',
				display: 'flex',
				justifyContent: 'center',
			}}
		>
			<div
				style={{
					width: 'min(100vw, 520px)',
					height: '100%',
					display: 'flex',
					flexDirection: 'column',
					background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
				}}
			>
				<header
					style={{
						padding: '16px 16px 14px',
						paddingTop: 'max(18px, env(safe-area-inset-top))',
						borderBottom: '1px solid rgba(255,255,255,0.08)',
						display: 'flex',
						flexDirection: 'column',
						gap: '12px',
						position: 'sticky',
						top: 0,
						zIndex: 2,
						background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
					}}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
						{scope.type === 'workspace' ? (
							<button type="button" onClick={onOpenHome} style={{ ...buttonStyle, width: '40px', padding: 0 }}>
								<ArrowLeft size={16} />
							</button>
						) : (
							<div
								style={{
									width: '40px',
									height: '40px',
									borderRadius: '14px',
									display: 'inline-flex',
									alignItems: 'center',
									justifyContent: 'center',
									background: `${colors.accent}18`,
									border: `1px solid ${colors.accent}30`,
									color: colors.accent,
									flexShrink: 0,
								}}
							>
								<LayoutGrid size={18} />
							</div>
						)}
						<div style={{ minWidth: 0, flex: 1 }}>
							<div style={{ fontSize: '11px', fontWeight: 600, color: colors.textDim, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
								{scope.type === 'home' ? 'Bird’s-Eye Review' : 'Workspace Board'}
							</div>
							<div style={{ fontSize: '20px', fontWeight: 700, color: colors.textMain, marginTop: '4px' }}>
								{scope.type === 'home'
									? 'Kanban'
									: `${activeGroup?.emoji || '📂'} ${activeGroup?.name || 'Workspace'}`}
							</div>
						</div>
						<button type="button" onClick={() => void onRefresh()} style={{ ...buttonStyle, width: '40px', padding: 0 }}>
							<RefreshCw size={16} />
						</button>
						<button type="button" onClick={onClose} style={{ ...buttonStyle, width: '40px', padding: 0 }}>
							<X size={16} />
						</button>
					</div>

					<div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
						{renderMetricCard('Open', metrics.open, colors.accent)}
						{renderMetricCard('Running', metrics.running, colors.warning)}
						{renderMetricCard('Needs attention', metrics.attention, colors.error)}
						{renderMetricCard('Done', metrics.done, colors.success)}
					</div>

					{scope.type === 'workspace' && (
						<div
							style={{
								...glassSurface,
								borderRadius: '18px',
								padding: '14px',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: '12px',
							}}
						>
							<div style={{ minWidth: 0 }}>
								<div style={{ fontSize: '12px', fontWeight: 650, color: colors.textMain }}>
									{currentConductor?.status ? currentConductor.status.replace(/_/g, ' ') : 'Board ready'}
								</div>
								<div style={{ fontSize: '11px', color: colors.textDim, marginTop: '4px' }}>
									Edit titles, reprioritize work, and move tasks between stages from your phone.
								</div>
							</div>
							<button
								type="button"
								onClick={handleStartCreate}
								style={{
									...buttonStyle,
									background: `${colors.accent}20`,
									border: `1px solid ${colors.accent}32`,
									color: colors.accent,
									flexShrink: 0,
								}}
							>
								<Plus size={16} />
								New Task
							</button>
						</div>
					)}
				</header>

				<div
					style={{
						flex: 1,
						minHeight: 0,
						overflowY: 'auto',
						padding: '14px 16px 32px',
						display: 'flex',
						flexDirection: 'column',
						gap: '14px',
					}}
				>
					{scope.type === 'home' && (
						<div
							style={{
								...glassSurface,
								borderRadius: '20px',
								padding: '14px',
								display: 'flex',
								flexDirection: 'column',
								gap: '12px',
							}}
						>
							<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
								<FolderKanban size={16} color={colors.accent} />
								<div style={{ fontSize: '13px', fontWeight: 700, color: colors.textMain }}>
									Workspace Boards
								</div>
							</div>
							<div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
								{workspaceSummaries.length === 0 ? (
									<div style={{ fontSize: '12px', color: colors.textDim }}>
										No kanban tasks yet. Open a workspace board to add one.
									</div>
								) : (
									workspaceSummaries.map((summary) => (
										<button
											key={summary.group.id}
											type="button"
											onClick={() => onOpenWorkspace(summary.group.id)}
											style={{
												...mutedSurface,
												borderRadius: '18px',
												padding: '14px',
												display: 'flex',
												flexDirection: 'column',
												gap: '8px',
												textAlign: 'left',
												cursor: 'pointer',
											}}
										>
											<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
												<span style={{ fontSize: '16px' }}>{summary.group.emoji || '📂'}</span>
												<span style={{ fontSize: '13px', fontWeight: 700, color: colors.textMain }}>
													{summary.group.name}
												</span>
											</div>
											<div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
												{[
													`${summary.openCount} open`,
													`${summary.runningCount} running`,
													`${summary.attentionCount} attention`,
													`${summary.doneCount} done`,
												].map((item) => (
													<span
														key={`${summary.group.id}-${item}`}
														style={{
															padding: '5px 8px',
															borderRadius: '999px',
															fontSize: '10px',
															fontWeight: 600,
															color: colors.textDim,
															background: 'rgba(255,255,255,0.08)',
														}}
													>
														{item}
													</span>
												))}
											</div>
										</button>
									))
								)}
							</div>
						</div>
					)}

					{isLoading && (
						<div
							style={{
								...glassSurface,
								borderRadius: '20px',
								padding: '18px',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								gap: '10px',
								color: colors.textDim,
							}}
						>
							<Loader2 size={18} className="animate-spin" />
							Loading kanban…
						</div>
					)}

					{error && !isLoading && (
						<div
							style={{
								...glassSurface,
								borderRadius: '20px',
								padding: '16px',
								color: colors.error,
								fontSize: '13px',
							}}
						>
							{error}
						</div>
					)}

					{!isLoading &&
						MOBILE_CONDUCTOR_COLUMNS.map((status) => {
							const columnTasks = groupedTasks[status];
							if (!columnTasks.length) {
								return null;
							}

							return (
								<section
									key={status}
									style={{
										...glassSurface,
										borderRadius: '22px',
										padding: '14px',
										display: 'flex',
										flexDirection: 'column',
										gap: '10px',
									}}
								>
									<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
										<div style={{ fontSize: '14px', fontWeight: 700, color: colors.textMain }}>
											{MOBILE_CONDUCTOR_STATUS_LABELS[status]}
										</div>
										<div
											style={{
												minWidth: '24px',
												height: '22px',
												padding: '0 8px',
												borderRadius: '999px',
												background: 'rgba(255,255,255,0.08)',
												display: 'inline-flex',
												alignItems: 'center',
												justifyContent: 'center',
												fontSize: '11px',
												fontWeight: 700,
												color: colors.textDim,
											}}
										>
											{columnTasks.length}
										</div>
									</div>
									<div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
										{columnTasks.map((task) => {
											const workspace = groups.find((group) => group.id === task.groupId);
											return (
												<button
													key={task.id}
													type="button"
													onClick={() => handleTaskOpen(task)}
													style={{
														...mutedSurface,
														borderRadius: '18px',
														padding: '14px',
														display: 'flex',
														flexDirection: 'column',
														gap: '10px',
														textAlign: 'left',
														cursor: 'pointer',
													}}
												>
													<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
														<div style={{ fontSize: '13px', fontWeight: 700, color: colors.textMain }}>
															{task.title}
														</div>
														<div
															style={{
																padding: '5px 8px',
																borderRadius: '999px',
																background: 'rgba(255,255,255,0.08)',
																fontSize: '10px',
																fontWeight: 700,
																color: colors.textDim,
																flexShrink: 0,
															}}
														>
															{MOBILE_CONDUCTOR_PRIORITY_LABELS[task.priority]}
														</div>
													</div>
													{task.description ? (
														<div style={{ fontSize: '12px', color: colors.textDim, lineHeight: 1.45 }}>
															{task.description}
														</div>
													) : null}
													<div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
														{scope.type === 'home' && workspace ? (
															<span
																style={{
																	padding: '5px 8px',
																	borderRadius: '999px',
																	background: `${colors.accent}16`,
																	fontSize: '10px',
																	fontWeight: 700,
																	color: colors.accent,
																}}
															>
																{workspace.emoji || '📂'} {workspace.name}
															</span>
														) : null}
														<span
															style={{
																padding: '5px 8px',
																borderRadius: '999px',
																background: 'rgba(255,255,255,0.08)',
																fontSize: '10px',
																fontWeight: 600,
																color: colors.textDim,
															}}
														>
															Updated {formatRelativeTime(task.updatedAt)}
														</span>
													</div>
												</button>
											);
										})}
									</div>
								</section>
							);
						})}

					{!isLoading && !visibleTasks.length && !error && (
						<div
							style={{
								...glassSurface,
								borderRadius: '22px',
								padding: '20px',
								textAlign: 'center',
								fontSize: '13px',
								color: colors.textDim,
								lineHeight: 1.5,
							}}
						>
							{scope.type === 'home'
								? 'No conductor tasks yet. Open a workspace board to add your first card.'
								: 'This workspace board is empty. Add a task to get it moving.'}
						</div>
					)}
				</div>

				{(isCreatingTask || selectedTask) && (
					<div
						style={{
							position: 'fixed',
							inset: 0,
							zIndex: 160,
							background: 'rgba(2, 8, 23, 0.45)',
							display: 'flex',
							alignItems: 'flex-end',
							justifyContent: 'center',
						}}
					>
						<div
							style={{
								width: 'min(100vw, 520px)',
								padding: '18px 16px calc(18px + env(safe-area-inset-bottom))',
								borderTopLeftRadius: '26px',
								borderTopRightRadius: '26px',
								background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
								borderTop: '1px solid rgba(255,255,255,0.08)',
								display: 'flex',
								flexDirection: 'column',
								gap: '12px',
							}}
						>
							<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
								<div>
									<div style={{ fontSize: '12px', fontWeight: 600, color: colors.textDim, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
										{isCreatingTask ? 'New Task' : 'Task Details'}
									</div>
									<div style={{ fontSize: '18px', fontWeight: 700, color: colors.textMain, marginTop: '4px' }}>
										{isCreatingTask ? activeGroup?.name || 'Workspace' : selectedTask?.title || 'Task'}
									</div>
								</div>
								<button type="button" onClick={handleCloseEditor} style={{ ...buttonStyle, width: '40px', padding: 0 }}>
									<X size={16} />
								</button>
							</div>

							<input
								type="text"
								value={editorDraft.title}
								onChange={(event) =>
									setEditorDraft((previous) => ({ ...previous, title: event.target.value }))
								}
								placeholder="Task title"
								style={{
									...mutedSurface,
									borderRadius: '16px',
									padding: '13px 14px',
									fontSize: '14px',
									color: colors.textMain,
									outline: 'none',
								}}
							/>
							<textarea
								value={editorDraft.description}
								onChange={(event) =>
									setEditorDraft((previous) => ({
										...previous,
										description: event.target.value,
									}))
								}
								placeholder="What needs doing?"
								rows={4}
								style={{
									...mutedSurface,
									borderRadius: '16px',
									padding: '13px 14px',
									fontSize: '13px',
									color: colors.textMain,
									outline: 'none',
									resize: 'vertical',
									fontFamily: 'inherit',
									lineHeight: 1.5,
								}}
							/>
							<div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
								<select
									value={editorDraft.status}
									onChange={(event) =>
										setEditorDraft((previous) => ({
											...previous,
											status: event.target.value as ConductorTaskStatus,
										}))
									}
									style={{
										...mutedSurface,
										borderRadius: '16px',
										padding: '13px 14px',
										fontSize: '13px',
										color: colors.textMain,
										outline: 'none',
									}}
								>
									{MOBILE_CONDUCTOR_COLUMNS.map((status) => (
										<option key={status} value={status}>
											{MOBILE_CONDUCTOR_STATUS_LABELS[status]}
										</option>
									))}
								</select>
								<select
									value={editorDraft.priority}
									onChange={(event) =>
										setEditorDraft((previous) => ({
											...previous,
											priority: event.target.value as ConductorTaskPriority,
										}))
									}
									style={{
										...mutedSurface,
										borderRadius: '16px',
										padding: '13px 14px',
										fontSize: '13px',
										color: colors.textMain,
										outline: 'none',
									}}
								>
									{(['low', 'medium', 'high', 'critical'] as ConductorTaskPriority[]).map(
										(priority) => (
											<option key={priority} value={priority}>
												{MOBILE_CONDUCTOR_PRIORITY_LABELS[priority]}
											</option>
										)
									)}
								</select>
							</div>

							<div style={{ display: 'flex', gap: '10px', justifyContent: 'space-between' }}>
								{selectedTask ? (
									<button
										type="button"
										onClick={() => void handleDelete()}
										disabled={isSaving}
										style={{
											...buttonStyle,
											background: `${colors.error}18`,
											border: `1px solid ${colors.error}28`,
											color: colors.error,
										}}
									>
										<Trash2 size={16} />
										Delete
									</button>
								) : (
									<div />
								)}
								<button
									type="button"
									onClick={() => void handleSave()}
									disabled={!editorDraft.title.trim() || isSaving}
									style={{
										...buttonStyle,
										background: `${colors.accent}22`,
										border: `1px solid ${colors.accent}34`,
										color: colors.accent,
										opacity: !editorDraft.title.trim() || isSaving ? 0.65 : 1,
									}}
								>
									{isSaving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
									{isCreatingTask ? 'Create Task' : 'Save Changes'}
								</button>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export default MobileKanbanPanel;
