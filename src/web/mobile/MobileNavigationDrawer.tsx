import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import type { Session } from '../hooks/useSessions';

interface MobileNavigationDrawerProps {
	isOpen: boolean;
	sessions: Session[];
	activeSessionId: string | null;
	onClose: () => void;
	onOpenControls?: () => void;
	onSelectSession: (sessionId: string) => void;
	onDeleteSession?: (sessionId: string) => void;
	onOpenTabSearch?: () => void;
	canOpenTabSearch: boolean;
}

interface SessionGroupSection {
	id: string;
	name: string;
	emoji: string;
	sessions: Session[];
}

function normalizeSearchText(value: string): string {
	return value.trim().toLowerCase();
}

export function MobileNavigationDrawer({
	isOpen,
	sessions,
	activeSessionId,
	onClose,
	onOpenControls,
	onSelectSession,
	onDeleteSession,
	onOpenTabSearch,
	canOpenTabSearch,
}: MobileNavigationDrawerProps) {
	const colors = useThemeColors();
	const [searchQuery, setSearchQuery] = useState('');
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
		onClose();
	};
	const confirmDeleteSession = useCallback(
		(session: Session) => {
			if (!onDeleteSession) return;
			const shouldDelete = window.confirm(`Remove agent "${session.name}"?`);
			if (!shouldDelete) return;
			searchInputRef.current?.blur();
			setSearchQuery('');
			onDeleteSession(session.id);
		},
		[onDeleteSession]
	);
	const groupedSessions = useMemo((): SessionGroupSection[] => {
		const grouped = new Map<string, SessionGroupSection>();

		for (const session of sessions) {
			const groupId = session.groupId || 'ungrouped';
			const existingGroup = grouped.get(groupId);

			if (existingGroup) {
				existingGroup.sessions.push(session);
				continue;
			}

			grouped.set(groupId, {
				id: groupId,
				name: session.groupName || 'Ungrouped',
				emoji: session.groupEmoji || '📂',
				sessions: [session],
			});
		}

		return [...grouped.values()]
			.sort((a, b) => {
				if (a.id === 'ungrouped') return 1;
				if (b.id === 'ungrouped') return -1;
				return a.name.localeCompare(b.name);
			})
			.map((group) => ({
				...group,
				sessions: [...group.sessions].sort((a, b) => a.name.localeCompare(b.name)),
			}));
	}, [sessions]);
	const normalizedSearchQuery = normalizeSearchText(searchQuery);
	const filteredGroups = useMemo(() => {
		if (!normalizedSearchQuery) {
			return groupedSessions;
		}

		return groupedSessions
			.map((group) => ({
				...group,
				sessions: group.sessions.filter((session) => {
					const haystack = `${group.name} ${session.name} ${session.toolType}`.toLowerCase();
					return haystack.includes(normalizedSearchQuery);
				}),
			}))
			.filter((group) => group.sessions.length > 0);
	}, [groupedSessions, normalizedSearchQuery]);
	const visibleAgentCount = filteredGroups.reduce(
		(total, group) => total + group.sessions.length,
		0
	);

	useEffect(() => {
		if (!isOpen) return;

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		setSearchQuery('');

		return () => {
			searchInputRef.current?.blur();
			document.body.style.overflow = previousOverflow;
		};
	}, [isOpen]);

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
					width: 'min(360px, calc(100vw - 28px))',
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
								Agents
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
								<span>Chats</span>
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
								placeholder="Search agents"
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
							<span>Agents</span>
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
								{visibleAgentCount}
							</span>
						</div>
						<div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
							{filteredGroups.map((group) => (
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
										<div
											style={{
												marginLeft: 'auto',
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
											const tabCount = session.aiTabs?.length || 0;
											const showTabCount = tabCount > 1;
											const gitFileCount = session.gitFileCount || 0;
											const showGitIndicator = session.isGitRepo && gitFileCount > 0;
											return (
												<div
													key={session.id}
													style={{
														padding: '4px',
														borderRadius: '14px',
														display: 'flex',
														alignItems: 'center',
														gap: '8px',
														marginBottom:
															group.sessions[group.sessions.length - 1]?.id === session.id
																? 0
																: '2px',
													}}
												>
													<button
														type="button"
														onClick={() => {
															searchInputRef.current?.blur();
															setSearchQuery('');
															onSelectSession(session.id);
														}}
														style={{
															padding: '12px 14px',
															borderRadius: '14px',
															border: 'none',
															flex: 1,
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
															transition:
																'background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease',
														}}
													>
														<span
															style={{
																fontSize: '13px',
																fontWeight: isActive ? 600 : 500,
																color: colors.textMain,
																minWidth: 0,
																flex: 1,
																letterSpacing: isActive ? '-0.01em' : undefined,
																overflow: 'hidden',
																textOverflow: 'ellipsis',
																whiteSpace: 'nowrap',
															}}
														>
															{session.name}
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
															{showGitIndicator && (
																<span
																	title={`${gitFileCount} changed file${gitFileCount === 1 ? '' : 's'}`}
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
																		background: `${colors.warning}${isActive ? '14' : '12'}`,
																		boxShadow: isActive ? activeBadgeShadow : 'none',
																	}}
																>
																	<GitBranch size={12} />
																	<span>{gitFileCount}</span>
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
																		backgroundColor: isActive
																			? `${colors.accent}10`
																			: 'rgba(255, 255, 255, 0.06)',
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
													{onDeleteSession && isActive && (
														<button
															type="button"
															onClick={(event) => {
																event.stopPropagation();
																confirmDeleteSession(session);
															}}
															aria-label={`Remove ${session.name}`}
															title={`Remove ${session.name}`}
															style={{
																width: '36px',
																height: '36px',
																borderRadius: '12px',
																border: '1px solid rgba(255, 255, 255, 0.08)',
																background:
																	'linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.05) 100%)',
																boxShadow:
																	'0 10px 18px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
																color: colors.error,
																display: 'inline-flex',
																alignItems: 'center',
																justifyContent: 'center',
																cursor: 'pointer',
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
																<path d="M3 6h18" />
																<path d="M8 6V4h8v2" />
																<path d="M19 6l-1 14H6L5 6" />
																<path d="M10 11v6" />
																<path d="M14 11v6" />
															</svg>
														</button>
													)}
												</div>
											);
										})}
									</div>
								</div>
							))}
							{filteredGroups.length === 0 && (
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
									No agents match “{searchQuery.trim()}”
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
