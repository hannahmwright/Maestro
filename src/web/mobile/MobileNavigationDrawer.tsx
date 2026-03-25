import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, LayoutGrid, Plus } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import { useSwipeGestures } from '../hooks/useSwipeGestures';
import type { Session } from '../hooks/useSessions';
import { ProviderModelIcon } from './CommandInputButtons';

interface MobileNavigationDrawerProps {
	isOpen: boolean;
	sessions: Session[];
	activeSessionId: string | null;
	onClose: () => void;
	onOpenControls?: () => void;
	onSelectSession: (sessionId: string) => void;
	onNewThreadInWorkspace?: (sessionId: string) => void;
	onDeleteSession?: (sessionId: string) => void;
	onOpenTabSearch?: () => void;
	canOpenTabSearch: boolean;
	onOpenKanbanHome?: () => void;
	onOpenWorkspaceKanban?: (workspaceId: string) => void;
}

interface WorkspaceSection {
	id: string;
	name: string;
	emoji: string;
	sessions: Session[];
	lastActivityAt: number;
}

interface RecentThreadEntry {
	session: Session;
	workspaceId: string;
	workspaceName: string;
	workspaceEmoji: string;
	lastActivityAt: number;
}

interface SwipeableThreadRowProps {
	session: Session;
	isActive: boolean;
	activeBadgeShadow: string;
	subtitle?: string | null;
	trailingWorkspaceEmoji?: string | null;
	onSelect: (sessionId: string) => void;
	onDelete?: (session: Session) => void;
	isDeleteActionVisible: boolean;
	onToggleDeleteAction: (sessionId: string | null) => void;
}

const DELETE_ACTION_WIDTH = 84;
const DELETE_SWIPE_THRESHOLD = 60;

function normalizeSearchText(value: string): string {
	return value.trim().toLowerCase();
}

function getSessionActivityTimestamp(session: Session): number {
	const lastTurnAt = session.lastTurnAt ?? 0;
	const lastResponseAt = session.lastResponse?.timestamp ?? 0;
	const aiTabActivityAt =
		session.aiTabs?.reduce((latest, tab) => {
			return Math.max(
				latest,
				tab.lastCheckpointAt ?? 0,
				tab.thinkingStartTime ?? 0,
				tab.createdAt ?? 0
			);
		}, 0) ?? 0;

	return Math.max(lastTurnAt, lastResponseAt, aiTabActivityAt);
}

function getThreadDisplayName(session: Session): string {
	return session.threadTitle?.trim() || session.name;
}

function getWorkspaceGitFileCount(sessions: Session[]): number {
	return sessions.find((session) => session.isGitRepo)?.gitFileCount || 0;
}

function isHiddenConductorWorkspaceSession(session: Session): boolean {
	return /-conductor(?:-integrate)?-[^\\/]+$/i.test(session.cwd || '');
}

function SwipeableThreadRow({
	session,
	isActive,
	activeBadgeShadow,
	subtitle,
	trailingWorkspaceEmoji,
	onSelect,
	onDelete,
	isDeleteActionVisible,
	onToggleDeleteAction,
}: SwipeableThreadRowProps) {
	const colors = useThemeColors();
	const tabCount = session.aiTabs?.length || 0;
	const showTabCount = tabCount > 1;
	const {
		handlers: swipeHandlers,
		offsetX,
		isSwiping,
		resetOffset,
	} = useSwipeGestures({
		onSwipeLeft: onDelete
			? () => {
					onToggleDeleteAction(session.id);
				}
			: undefined,
		onSwipeRight: onDelete
			? () => {
					onToggleDeleteAction(null);
				}
			: undefined,
		trackOffset: true,
		threshold: DELETE_SWIPE_THRESHOLD,
		maxOffset: DELETE_ACTION_WIDTH + 20,
		enabled: !!onDelete,
	});

	useEffect(() => {
		if (isDeleteActionVisible) {
			return;
		}

		resetOffset();
	}, [isDeleteActionVisible, resetOffset]);

	const isDeleteActionRevealed = isDeleteActionVisible || offsetX < -20;
	const translateX = isDeleteActionVisible ? -DELETE_ACTION_WIDTH : Math.min(0, offsetX);

	const handleSelect = useCallback(() => {
		if (isDeleteActionVisible) {
			onToggleDeleteAction(null);
			resetOffset();
			return;
		}

		onSelect(session.id);
	}, [isDeleteActionVisible, onSelect, onToggleDeleteAction, resetOffset, session.id]);

	const handleDelete = useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			event.stopPropagation();
			onToggleDeleteAction(null);
			resetOffset();
			onDelete?.(session);
		},
		[onDelete, onToggleDeleteAction, resetOffset, session]
	);

	return (
		<div
			style={{
				padding: '4px',
				borderRadius: '14px',
				marginBottom: '2px',
			}}
		>
			<div
				style={{
					position: 'relative',
					overflow: 'hidden',
					borderRadius: '14px',
				}}
			>
				{onDelete && (
					<button
						type="button"
						onClick={handleDelete}
						aria-label={`Delete thread ${getThreadDisplayName(session)}`}
						aria-hidden={!isDeleteActionRevealed}
						title={`Delete thread ${getThreadDisplayName(session)}`}
						tabIndex={isDeleteActionRevealed ? 0 : -1}
						style={{
							position: 'absolute',
							top: 0,
							right: 0,
							bottom: 0,
							width: `${DELETE_ACTION_WIDTH}px`,
							border: 'none',
							background: 'linear-gradient(180deg, #ef4444 0%, #dc2626 100%)',
							color: '#ffffff',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							gap: '6px',
							fontSize: '11px',
							fontWeight: 700,
							letterSpacing: '0.02em',
							cursor: 'pointer',
							opacity: isDeleteActionRevealed ? 1 : 0,
							pointerEvents: isDeleteActionRevealed ? 'auto' : 'none',
							transition: 'opacity 140ms ease',
						}}
					>
						<svg
							width="15"
							height="15"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M3 6h18" />
							<path d="M8 6V4h8v2" />
							<path d="M19 6l-1 14H6L5 6" />
							<path d="M10 11v6" />
							<path d="M14 11v6" />
						</svg>
						Delete
					</button>
				)}
				<button
					type="button"
					{...swipeHandlers}
					onClick={handleSelect}
					style={{
						padding: '12px 14px',
						borderRadius: '14px',
						border: 'none',
						width: '100%',
						boxShadow: isActive
							? `0 14px 28px ${colors.accent}18, 0 6px 16px rgba(15, 23, 42, 0.10), inset 2px 0 0 ${colors.accent}, inset 0 1px 0 rgba(255, 255, 255, 0.10)`
							: '0 4px 12px rgba(15, 23, 42, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.03)',
						background: isActive
							? `linear-gradient(180deg, ${colors.accent}18 0%, rgba(255,255,255,0.08) 100%)`
							: 'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)',
						display: 'flex',
						alignItems: 'center',
						gap: '10px',
						textAlign: 'left',
						cursor: 'pointer',
						transition: isSwiping
							? 'none'
							: 'background-color 160ms ease, box-shadow 160ms ease, transform 180ms ease',
						transform: `translateX(${translateX}px)`,
						touchAction: 'pan-y',
					}}
				>
					<span
						style={{
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: '24px',
							height: '24px',
							borderRadius: '999px',
							background: isActive ? `${colors.accent}12` : 'rgba(255, 255, 255, 0.06)',
							border: '1px solid rgba(255, 255, 255, 0.06)',
							boxShadow: isActive ? activeBadgeShadow : 'none',
							flexShrink: 0,
						}}
					>
						<ProviderModelIcon toolType={session.toolType} color={colors.textMain} size={14} />
					</span>
					<span
						style={{
							display: 'flex',
							flexDirection: 'column',
							gap: subtitle ? '3px' : 0,
							minWidth: 0,
							flex: 1,
						}}
					>
						<span
							style={{
								fontSize: '13px',
								fontWeight: isActive ? 600 : 500,
								color: colors.textMain,
								letterSpacing: isActive ? '-0.01em' : undefined,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{getThreadDisplayName(session)}
						</span>
						{subtitle && (
							<span
								style={{
									fontSize: '10px',
									fontWeight: 600,
									color: colors.textDim,
									opacity: 0.84,
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								}}
							>
								{subtitle}
							</span>
						)}
					</span>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '7px',
							flexShrink: 0,
							color: colors.textDim,
							justifyContent: 'flex-end',
						}}
					>
						{trailingWorkspaceEmoji && (
							<span
								title="Workspace"
								style={{
									display: 'inline-flex',
									alignItems: 'center',
									justifyContent: 'center',
									width: '26px',
									height: '26px',
									borderRadius: '999px',
									backgroundColor: isActive
										? `${colors.accent}10`
										: 'rgba(255, 255, 255, 0.06)',
									border: '1px solid rgba(255, 255, 255, 0.06)',
									fontSize: '15px',
									lineHeight: 1,
									boxShadow: isActive ? activeBadgeShadow : 'none',
								}}
							>
								{trailingWorkspaceEmoji}
							</span>
						)}
						{showTabCount && (
							<span
								title={`${tabCount} tabs`}
								style={{
									minWidth: '22px',
									height: '22px',
									padding: '0 7px',
									borderRadius: '999px',
									border: '1px solid rgba(255, 255, 255, 0.06)',
									backgroundColor: isActive ? `${colors.accent}10` : 'rgba(255, 255, 255, 0.06)',
									display: 'inline-flex',
									alignItems: 'center',
									justifyContent: 'center',
									fontSize: '10px',
									fontWeight: 600,
									color: isActive ? colors.accent : colors.textDim,
									boxShadow: isActive ? activeBadgeShadow : 'none',
								}}
							>
								{tabCount}
							</span>
						)}
					</div>
				</button>
			</div>
		</div>
	);
}

export function MobileNavigationDrawer({
	isOpen,
	sessions,
	activeSessionId,
	onClose,
	onOpenControls,
	onSelectSession,
	onNewThreadInWorkspace,
	onDeleteSession,
	onOpenTabSearch,
	canOpenTabSearch,
	onOpenKanbanHome,
	onOpenWorkspaceKanban,
}: MobileNavigationDrawerProps) {
	const colors = useThemeColors();
	const [searchQuery, setSearchQuery] = useState('');
	const [deleteActionSessionId, setDeleteActionSessionId] = useState<string | null>(null);
	const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(new Set());
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const glassSurface = {
		border: '1px solid rgba(255, 255, 255, 0.08)',
		background:
			'linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.05) 100%)',
		backdropFilter: 'blur(16px)',
		WebkitBackdropFilter: 'blur(16px)',
		boxShadow:
			'0 18px 34px rgba(15, 23, 42, 0.14), 0 6px 14px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
	} satisfies React.CSSProperties;
	const softSurface = {
		border: '1px solid rgba(255, 255, 255, 0.08)',
		background: 'rgba(255, 255, 255, 0.06)',
		backdropFilter: 'blur(14px)',
		WebkitBackdropFilter: 'blur(14px)',
		boxShadow:
			'0 12px 24px rgba(15, 23, 42, 0.10), 0 2px 8px rgba(15, 23, 42, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
	} satisfies React.CSSProperties;
	const activeBadgeShadow =
		'0 6px 14px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.10)';
	const closeDrawer = () => {
		searchInputRef.current?.blur();
		setSearchQuery('');
		setDeleteActionSessionId(null);
		onClose();
	};
	const confirmDeleteSession = useCallback(
		(session: Session) => {
			if (!onDeleteSession) return;
			setDeleteActionSessionId(null);
			const shouldDelete = window.confirm(`Delete thread "${getThreadDisplayName(session)}"?`);
			if (!shouldDelete) return;
			searchInputRef.current?.blur();
			setSearchQuery('');
			onDeleteSession(session.id);
		},
		[onDeleteSession]
	);
	const handleCreateThreadInWorkspace = useCallback(
		(sessionId: string) => {
			if (!onNewThreadInWorkspace) return;
			searchInputRef.current?.blur();
			setSearchQuery('');
			setDeleteActionSessionId(null);
			onNewThreadInWorkspace(sessionId);
		},
		[onNewThreadInWorkspace]
	);
	const toggleWorkspaceExpanded = useCallback((workspaceId: string) => {
		setExpandedWorkspaceIds((prev) => {
			const next = new Set(prev);
			if (next.has(workspaceId)) {
				next.delete(workspaceId);
			} else {
				next.add(workspaceId);
			}
			return next;
		});
	}, []);
	const workspaceSections = useMemo((): WorkspaceSection[] => {
		const grouped = new Map<string, WorkspaceSection>();

		for (const session of sessions.filter((candidate) => !isHiddenConductorWorkspaceSession(candidate))) {
			const workspaceId = session.groupId || 'ungrouped';
			const sessionActivityAt = getSessionActivityTimestamp(session);
			const existingGroup = grouped.get(workspaceId);

			if (existingGroup) {
				existingGroup.sessions.push(session);
				existingGroup.lastActivityAt = Math.max(existingGroup.lastActivityAt, sessionActivityAt);
				continue;
			}

			grouped.set(workspaceId, {
				id: workspaceId,
				name: session.groupName || 'Workspace',
				emoji: session.groupEmoji || '📂',
				sessions: [session],
				lastActivityAt: sessionActivityAt,
			});
		}

		return [...grouped.values()]
			.sort((a, b) => {
				return b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name);
			})
			.map((workspace) => ({
				...workspace,
				sessions: [...workspace.sessions].sort((a, b) => {
					const activityDiff = getSessionActivityTimestamp(b) - getSessionActivityTimestamp(a);
					if (activityDiff !== 0) return activityDiff;
					return getThreadDisplayName(a).localeCompare(getThreadDisplayName(b));
				}),
			}));
	}, [sessions]);
	const normalizedSearchQuery = normalizeSearchText(searchQuery);
	const filteredWorkspaces = useMemo(() => {
		if (!normalizedSearchQuery) {
			return workspaceSections;
		}

		return workspaceSections
			.map((workspace) => ({
				...workspace,
				sessions: workspace.sessions.filter((session) => {
					const haystack =
						`${workspace.name} ${getThreadDisplayName(session)} ${session.toolType} ${session.groupName || ''}`.toLowerCase();
					return haystack.includes(normalizedSearchQuery);
				}),
			}))
			.filter((workspace) => workspace.sessions.length > 0);
	}, [normalizedSearchQuery, workspaceSections]);
	const recentThreads = useMemo((): RecentThreadEntry[] => {
		const threadEntries = filteredWorkspaces.flatMap((workspace) =>
			workspace.sessions.map((session) => ({
				session,
				workspaceId: workspace.id,
				workspaceName: workspace.name,
				workspaceEmoji: workspace.emoji,
				lastActivityAt: getSessionActivityTimestamp(session),
			}))
		);

		return threadEntries
			.sort(
				(a, b) =>
					b.lastActivityAt - a.lastActivityAt ||
					getThreadDisplayName(a.session).localeCompare(getThreadDisplayName(b.session))
			)
			.slice(0, 5);
	}, [filteredWorkspaces]);
	const visibleThreadCount = filteredWorkspaces.reduce(
		(total, workspace) => total + workspace.sessions.length,
		0
	);

	useEffect(() => {
		if (!isOpen) return;

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		setSearchQuery('');
		setExpandedWorkspaceIds(new Set());

		return () => {
			searchInputRef.current?.blur();
			document.body.style.overflow = previousOverflow;
		};
	}, [isOpen]);

	useEffect(() => {
		setDeleteActionSessionId(null);
	}, [activeSessionId, normalizedSearchQuery]);

	if (!isOpen) {
		return null;
	}

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 140,
				display: 'flex',
			}}
		>
			<aside
				style={{
					width: '100%',
					maxWidth: '100vw',
					height: '100%',
					display: 'flex',
					flexDirection: 'column',
					background:
						'linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.04) 52%, rgba(255, 255, 255, 0.03) 100%)',
					backdropFilter: 'blur(24px)',
					WebkitBackdropFilter: 'blur(24px)',
					borderRight: '1px solid rgba(255, 255, 255, 0.08)',
					boxShadow:
						'22px 0 54px rgba(2, 8, 23, 0.26), 10px 0 26px rgba(2, 8, 23, 0.14), inset -1px 0 0 rgba(255, 255, 255, 0.04)',
				}}
			>
				<div
					style={{
						padding: '18px 16px 14px',
						paddingTop: 'max(16px, env(safe-area-inset-top))',
						borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
						display: 'flex',
						flexDirection: 'column',
						gap: '12px',
					}}
				>
					<div
						style={{
							display: 'flex',
							alignItems: 'flex-start',
							justifyContent: 'space-between',
							gap: '12px',
						}}
					>
						<div style={{ minWidth: 0 }}>
							<div
								style={{
									fontSize: '10px',
									fontWeight: 600,
									letterSpacing: '0.08em',
									textTransform: 'uppercase',
									color: colors.textDim,
									opacity: 0.72,
								}}
							>
								Maestro Remote
							</div>
							<div
								style={{
									fontSize: '19px',
									fontWeight: 650,
									color: colors.textMain,
									marginTop: '6px',
									letterSpacing: '-0.02em',
								}}
							>
								Workspaces
							</div>
						</div>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '8px',
								flexShrink: 0,
							}}
						>
							{onOpenControls && (
								<button
									type="button"
									onClick={() => {
										searchInputRef.current?.blur();
										setSearchQuery('');
										onOpenControls();
									}}
									aria-label="Open app controls"
									style={{
										width: '34px',
										height: '34px',
										borderRadius: '12px',
										border: '1px solid rgba(255, 255, 255, 0.06)',
										background: 'rgba(255, 255, 255, 0.06)',
										color: colors.textMain,
										cursor: 'pointer',
										display: 'inline-flex',
										alignItems: 'center',
										justifyContent: 'center',
									}}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<circle cx="12" cy="12" r="3" />
										<path d="M19.4 15a1.7 1.7 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.7 1.7 0 0 0-1.82-.33 1.7 1.7 0 0 0-1 1.54V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.7 1.7 0 0 0 .33-1.82 1.7 1.7 0 0 0-1.54-1H3a2 2 0 0 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.7 1.7 0 0 0 1.82.33h.09A1.7 1.7 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.7 1.7 0 0 0-.33 1.82v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
									</svg>
								</button>
							)}
							<button
								type="button"
								onClick={closeDrawer}
								aria-label="Close drawer"
								style={{
									width: '34px',
									height: '34px',
									borderRadius: '12px',
									border: '1px solid rgba(255, 255, 255, 0.06)',
									background: 'rgba(255, 255, 255, 0.06)',
									color: colors.textMain,
									cursor: 'pointer',
									flexShrink: 0,
								}}
							>
								×
							</button>
						</div>
					</div>

					<div
						style={{
							display: 'grid',
							gridTemplateColumns: '1fr',
							gap: '10px',
						}}
					>
						{canOpenTabSearch && onOpenTabSearch && (
							<button
								type="button"
								onClick={() => {
									searchInputRef.current?.blur();
									onOpenTabSearch();
								}}
								style={{
									...glassSurface,
									height: '40px',
									padding: '0 14px',
									borderRadius: '12px',
									color: colors.textMain,
									fontSize: '12px',
									fontWeight: 600,
									cursor: 'pointer',
									display: 'flex',
									alignItems: 'center',
									gap: '10px',
									textAlign: 'left',
								}}
							>
								<span
									style={{
										display: 'inline-flex',
										alignItems: 'center',
										justifyContent: 'center',
										width: '24px',
										height: '24px',
										borderRadius: '999px',
										background: 'rgba(255, 255, 255, 0.08)',
										color: colors.accent,
										flexShrink: 0,
									}}
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
									</svg>
								</span>
								<span>Threads</span>
							</button>
						)}
						{onOpenKanbanHome && (
							<button
								type="button"
								onClick={() => {
									searchInputRef.current?.blur();
									setSearchQuery('');
									onOpenKanbanHome();
								}}
								style={{
									...glassSurface,
									height: '40px',
									padding: '0 14px',
									borderRadius: '12px',
									color: colors.textMain,
									fontSize: '12px',
									fontWeight: 600,
									cursor: 'pointer',
									display: 'flex',
									alignItems: 'center',
									gap: '10px',
									textAlign: 'left',
								}}
							>
								<span
									style={{
										display: 'inline-flex',
										alignItems: 'center',
										justifyContent: 'center',
										width: '24px',
										height: '24px',
										borderRadius: '999px',
										background: 'rgba(255, 255, 255, 0.08)',
										color: colors.accent,
										flexShrink: 0,
									}}
								>
									<LayoutGrid size={14} />
								</span>
								<span>Boards</span>
							</button>
						)}
					</div>
				</div>

				<div
					style={{
						flex: 1,
						minHeight: 0,
						overflowY: 'auto',
						padding: '14px 16px 18px',
						display: 'flex',
						flexDirection: 'column',
						gap: '16px',
					}}
				>
					<div>
						<div
							style={{
								...glassSurface,
								display: 'flex',
								alignItems: 'center',
								gap: '10px',
								height: '42px',
								borderRadius: '14px',
								padding: '0 14px',
								marginBottom: '12px',
							}}
						>
							<span
								style={{
									display: 'inline-flex',
									alignItems: 'center',
									color: colors.textDim,
									opacity: 0.82,
									flexShrink: 0,
								}}
							>
								<svg
									width="15"
									height="15"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<circle cx="11" cy="11" r="8" />
									<path d="m21 21-4.3-4.3" />
								</svg>
							</span>
							<input
								ref={searchInputRef}
								type="text"
								inputMode="search"
								enterKeyHint="search"
								value={searchQuery}
								onChange={(event) => setSearchQuery(event.target.value)}
								placeholder="Search workspaces and threads"
								style={{
									width: '100%',
									height: '100%',
									color: colors.textMain,
									fontSize: '13px',
									outline: 'none',
									background: 'transparent',
									border: 'none',
									padding: 0,
								}}
							/>
						</div>
						<div
							style={{
								fontSize: '11px',
								fontWeight: 600,
								letterSpacing: '0.06em',
								textTransform: 'uppercase',
								color: colors.textDim,
								opacity: 0.82,
								marginBottom: '10px',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: '12px',
							}}
						>
							<span>Threads</span>
							<span
								style={{
									display: 'inline-flex',
									alignItems: 'center',
									justifyContent: 'center',
									minWidth: '24px',
									height: '20px',
									padding: '0 8px',
									borderRadius: '999px',
									background: 'rgba(255, 255, 255, 0.06)',
									fontSize: '10px',
									fontWeight: 600,
									letterSpacing: '0.01em',
									color: colors.textDim,
									textTransform: 'none',
								}}
							>
								{visibleThreadCount}
							</span>
						</div>
						<div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
							{recentThreads.length > 0 && (
								<div
									style={{
										display: 'flex',
										flexDirection: 'column',
										gap: '10px',
									}}
								>
									<div
										style={{
											display: 'flex',
											alignItems: 'center',
											justifyContent: 'space-between',
											gap: '8px',
											padding: '0 4px',
										}}
									>
										<div
											style={{
												fontSize: '12px',
												fontWeight: 650,
												color: colors.textMain,
											}}
										>
											Recent Threads
										</div>
										<div
											style={{
												fontSize: '10px',
												fontWeight: 600,
												color: colors.textDim,
												opacity: 0.82,
												textTransform: 'uppercase',
												letterSpacing: '0.04em',
											}}
										>
											Latest activity
										</div>
									</div>
									<div
										style={{
											...softSurface,
											display: 'flex',
											flexDirection: 'column',
											borderRadius: '18px',
											overflow: 'hidden',
											padding: '4px',
											background:
												'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)',
										}}
									>
										{recentThreads.map((thread) => {
											const isActive = thread.session.id === activeSessionId;
											return (
												<SwipeableThreadRow
													key={`recent-${thread.session.id}`}
													session={thread.session}
													isActive={isActive}
													activeBadgeShadow={activeBadgeShadow}
													trailingWorkspaceEmoji={thread.workspaceEmoji}
													onSelect={(sessionId) => {
														searchInputRef.current?.blur();
														setSearchQuery('');
														setDeleteActionSessionId(null);
														onSelectSession(sessionId);
													}}
													onDelete={onDeleteSession ? confirmDeleteSession : undefined}
													isDeleteActionVisible={deleteActionSessionId === thread.session.id}
													onToggleDeleteAction={setDeleteActionSessionId}
												/>
											);
										})}
									</div>
								</div>
							)}

							{filteredWorkspaces.length > 0 && (
								<div
									style={{
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'space-between',
										gap: '12px',
										padding: '0 4px',
									}}
								>
									<div
										style={{
											fontSize: '12px',
											fontWeight: 650,
											color: colors.textMain,
										}}
									>
										Workspaces
									</div>
									<div
										style={{
											fontSize: '10px',
											fontWeight: 600,
											color: colors.textDim,
											opacity: 0.82,
											textTransform: 'uppercase',
											letterSpacing: '0.04em',
										}}
									>
										By repo
									</div>
								</div>
							)}
							{filteredWorkspaces.map((group) => {
								const workspaceGitFileCount = getWorkspaceGitFileCount(group.sessions);
								const isWorkspaceExpanded =
									normalizedSearchQuery.length > 0 || expandedWorkspaceIds.has(group.id);

								return (
									<div
										key={group.id}
										style={{
											display: 'flex',
											flexDirection: 'column',
											gap: '10px',
										}}
									>
										<div
											style={{
												display: 'flex',
												alignItems: 'center',
												gap: '8px',
												padding: '0 4px',
											}}
										>
											<button
												type="button"
												onClick={() => toggleWorkspaceExpanded(group.id)}
												aria-expanded={isWorkspaceExpanded}
												aria-label={`${isWorkspaceExpanded ? 'Collapse' : 'Expand'} ${group.name}`}
												style={{
													display: 'flex',
													alignItems: 'center',
													gap: '8px',
													flex: 1,
													minWidth: 0,
													padding: 0,
													border: 'none',
													background: 'transparent',
													cursor: 'pointer',
													textAlign: 'left',
												}}
											>
												<span
													style={{
														display: 'inline-flex',
														alignItems: 'center',
														justifyContent: 'center',
														width: '18px',
														height: '18px',
														borderRadius: '999px',
														color: colors.textDim,
														flexShrink: 0,
													}}
												>
													{isWorkspaceExpanded ? (
														<ChevronDown size={14} />
													) : (
														<ChevronRight size={14} />
													)}
												</span>
												<span
													style={{
														display: 'inline-flex',
														alignItems: 'center',
														justifyContent: 'center',
														width: '24px',
														height: '24px',
														borderRadius: '999px',
														background: 'rgba(255, 255, 255, 0.06)',
														fontSize: '14px',
														lineHeight: 1,
														flexShrink: 0,
													}}
												>
													{group.emoji}
												</span>
												<div
													style={{
														fontSize: '12px',
														fontWeight: 600,
														color: colors.textMain,
														minWidth: 0,
														overflow: 'hidden',
														textOverflow: 'ellipsis',
														whiteSpace: 'nowrap',
													}}
												>
													{group.name}
												</div>
											</button>
											<div
												style={{
													display: 'flex',
													alignItems: 'center',
													gap: '8px',
													flexShrink: 0,
												}}
											>
												{workspaceGitFileCount > 0 && (
													<span
														title={`${workspaceGitFileCount} changed file${workspaceGitFileCount === 1 ? '' : 's'}`}
														style={{
															display: 'inline-flex',
															alignItems: 'center',
															justifyContent: 'center',
															gap: '4px',
															minWidth: '38px',
															fontSize: '10px',
															fontWeight: 600,
															color: colors.warning,
															padding: '4px 7px',
															borderRadius: '999px',
															background: `${colors.warning}12`,
															flexShrink: 0,
														}}
													>
														<GitBranch size={12} />
														<span>{workspaceGitFileCount}</span>
													</span>
												)}
												{onOpenWorkspaceKanban && (
													<button
														type="button"
														onClick={() => onOpenWorkspaceKanban?.(group.id)}
														aria-label={`Open ${group.name} kanban`}
														title={`Open ${group.name} kanban`}
														style={{
															width: '24px',
															height: '24px',
															borderRadius: '999px',
															border: '1px solid rgba(255, 255, 255, 0.08)',
															background: 'rgba(255, 255, 255, 0.06)',
															color: colors.textMain,
															display: 'inline-flex',
															alignItems: 'center',
															justifyContent: 'center',
															cursor: 'pointer',
															flexShrink: 0,
														}}
													>
														<LayoutGrid size={14} />
													</button>
												)}
												{onNewThreadInWorkspace && (
													<button
														type="button"
														onClick={() => handleCreateThreadInWorkspace(group.sessions[0].id)}
														aria-label={`New thread in ${group.name}`}
														title={`New thread in ${group.name}`}
														style={{
															width: '24px',
															height: '24px',
															borderRadius: '999px',
															border: '1px solid rgba(255, 255, 255, 0.08)',
															background: 'rgba(255, 255, 255, 0.06)',
															color: colors.accent,
															display: 'inline-flex',
															alignItems: 'center',
															justifyContent: 'center',
															cursor: 'pointer',
															flexShrink: 0,
														}}
													>
														<Plus size={14} />
													</button>
												)}
												<div
													style={{
														display: 'inline-flex',
														alignItems: 'center',
														justifyContent: 'center',
														minWidth: '20px',
														height: '20px',
														padding: '0 7px',
														borderRadius: '999px',
														fontSize: '10px',
														fontWeight: 600,
														color: colors.textDim,
														opacity: 0.82,
														background: 'rgba(255, 255, 255, 0.06)',
													}}
												>
													{group.sessions.length}
												</div>
											</div>
										</div>

										{isWorkspaceExpanded && (
											<div
												style={{
													...softSurface,
													display: 'flex',
													flexDirection: 'column',
													borderRadius: '18px',
													overflow: 'hidden',
													padding: '4px',
													background:
														'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)',
												}}
											>
												{group.sessions.map((session) => {
													const isActive = session.id === activeSessionId;
													return (
														<SwipeableThreadRow
															key={session.id}
															session={session}
															isActive={isActive}
															activeBadgeShadow={activeBadgeShadow}
															onSelect={(sessionId) => {
																searchInputRef.current?.blur();
																setSearchQuery('');
																setDeleteActionSessionId(null);
																onSelectSession(sessionId);
															}}
															onDelete={onDeleteSession ? confirmDeleteSession : undefined}
															isDeleteActionVisible={deleteActionSessionId === session.id}
															onToggleDeleteAction={setDeleteActionSessionId}
														/>
													);
												})}
											</div>
										)}
									</div>
								);
							})}
							{filteredWorkspaces.length === 0 && (
								<div
									style={{
										...softSurface,
										padding: '16px 12px',
										borderRadius: '18px',
										fontSize: '13px',
										color: colors.textDim,
										textAlign: 'center',
									}}
								>
									No workspaces or threads match “{searchQuery.trim()}”
								</div>
							)}
						</div>
					</div>
				</div>
			</aside>
			<button
				type="button"
				onClick={closeDrawer}
				aria-label="Close navigation drawer"
				style={{
					flex: 1,
					border: 'none',
					backgroundColor: 'rgba(0, 0, 0, 0.52)',
					padding: 0,
					cursor: 'pointer',
				}}
			/>
		</div>
	);
}

export default MobileNavigationDrawer;
