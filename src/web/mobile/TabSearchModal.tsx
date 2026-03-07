/**
 * Mobile tab search / jump palette.
 *
 * Empty state acts like a launcher for busy, unread, and recent chats.
 * Typing switches to cross-agent session/tab search.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type { Session, AITabData } from '../hooks/useSessions';
import type { RecentSessionTarget } from '../utils/viewState';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

interface TabSearchModalProps {
	sessions: Session[];
	activeSessionId: string | null;
	activeTabId: string | null;
	recentTargets: RecentSessionTarget[];
	onSelectTarget: (sessionId: string, tabId: string | null) => void;
	onClose: () => void;
}

interface SearchTarget {
	key: string;
	sessionId: string;
	tabId: string;
	sessionName: string;
	sessionSubtitle: string;
	tabName: string;
	providerSessionId: string | null;
	isBusy: boolean;
	isUnread: boolean;
	isActive: boolean;
	createdAt: number;
	recentViewedAt: number | null;
	searchText: string;
}

interface SectionProps {
	title: string;
	description: string;
	targets: SearchTarget[];
	colors: ReturnType<typeof useThemeColors>;
	onSelect: (target: SearchTarget) => void;
}

function getTabDisplayName(tab: AITabData): string {
	const normalizedName = tab.name?.trim();
	if (normalizedName) {
		return normalizedName;
	}
	return 'Untitled chat';
}

function getSessionSubtitle(session: Session): string {
	if (session.groupName?.trim()) {
		return session.groupName.trim();
	}

	switch (session.toolType) {
		case 'claude-code':
			return 'Claude Code';
		case 'codex':
			return 'Codex';
		case 'opencode':
			return 'OpenCode';
		case 'factory-droid':
			return 'Factory Droid';
		case 'terminal':
			return 'Terminal';
		default:
			return session.toolType;
	}
}

function scoreTarget(target: SearchTarget, query: string): number {
	const normalizedQuery = query.toLowerCase();
	const tabName = target.tabName.toLowerCase();
	const sessionName = target.sessionName.toLowerCase();
	const providerSessionId = target.providerSessionId?.toLowerCase() || '';
	let score = 0;

	if (tabName === normalizedQuery) {
		score += 80;
	} else if (tabName.startsWith(normalizedQuery)) {
		score += 45;
	} else if (tabName.includes(normalizedQuery)) {
		score += 28;
	}

	if (sessionName === normalizedQuery) {
		score += 30;
	} else if (sessionName.startsWith(normalizedQuery)) {
		score += 18;
	} else if (sessionName.includes(normalizedQuery)) {
		score += 10;
	}

	if (providerSessionId.startsWith(normalizedQuery)) {
		score += 8;
	}

	if (target.isBusy) {
		score += 6;
	}
	if (target.isUnread) {
		score += 4;
	}
	if (target.recentViewedAt) {
		score += 2;
	}

	return score;
}

function StatusGlyph({
	target,
	colors,
}: {
	target: SearchTarget;
	colors: ReturnType<typeof useThemeColors>;
}) {
	if (target.isBusy) {
		return (
			<span
				aria-hidden="true"
				style={{
					width: '9px',
					height: '9px',
					borderRadius: '999px',
					backgroundColor: colors.warning,
					flexShrink: 0,
					animation: 'tabSearchPulse 1.3s ease-in-out infinite',
				}}
			/>
		);
	}

	if (target.isUnread) {
		return (
			<span
				aria-hidden="true"
				style={{
					width: '9px',
					height: '9px',
					borderRadius: '999px',
					backgroundColor: colors.accent,
					flexShrink: 0,
				}}
			/>
		);
	}

	return (
		<span
			aria-hidden="true"
			style={{
				width: '8px',
				height: '8px',
				borderRadius: '999px',
				backgroundColor: `${colors.textDim}66`,
				flexShrink: 0,
			}}
		/>
	);
}

function JumpRow({
	target,
	colors,
	onSelect,
}: {
	target: SearchTarget;
	colors: ReturnType<typeof useThemeColors>;
	onSelect: (target: SearchTarget) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(target)}
			style={{
				display: 'flex',
				alignItems: 'flex-start',
				gap: '10px',
				width: '100%',
				padding: '12px 2px',
				border: 'none',
				borderBottom: `1px solid ${colors.border}55`,
				backgroundColor: target.isActive ? `${colors.accent}10` : 'transparent',
				color: colors.textMain,
				cursor: 'pointer',
				textAlign: 'left',
			}}
		>
			<div
				style={{
					paddingTop: '6px',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					width: '12px',
					flexShrink: 0,
				}}
			>
				<StatusGlyph target={target} colors={colors} />
			</div>

			<div
				style={{
					flex: 1,
					minWidth: 0,
					display: 'flex',
					flexDirection: 'column',
					gap: '4px',
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						minWidth: 0,
					}}
				>
					<span
						style={{
							fontSize: '16px',
							fontWeight: 650,
							color: colors.textMain,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
							minWidth: 0,
						}}
					>
						{target.tabName}
					</span>
					{target.isActive && (
						<span
							style={{
								fontSize: '11px',
								fontWeight: 700,
								letterSpacing: '0.08em',
								textTransform: 'uppercase',
								color: colors.accent,
								flexShrink: 0,
							}}
						>
							Open
						</span>
					)}
				</div>

				<span
					style={{
						fontSize: '13px',
						color: colors.textDim,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
				>
					{target.sessionName} • {target.sessionSubtitle}
					{target.providerSessionId ? ` • ${target.providerSessionId.slice(0, 8)}` : ''}
				</span>
			</div>
		</button>
	);
}

function Section({ title, description, targets, colors, onSelect }: SectionProps) {
	if (targets.length === 0) {
		return null;
	}

	return (
		<section
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: '4px',
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'baseline',
					justifyContent: 'space-between',
					gap: '12px',
				}}
			>
				<div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
					<h2
						style={{
							margin: 0,
							fontSize: '15px',
							fontWeight: 700,
							color: colors.textMain,
						}}
					>
						{title}
					</h2>
					<p
						style={{
							margin: 0,
							fontSize: '12px',
							color: colors.textDim,
						}}
					>
						{description}
					</p>
				</div>
				<span
					style={{
						fontSize: '11px',
						fontWeight: 700,
						letterSpacing: '0.08em',
						textTransform: 'uppercase',
						color: colors.textDim,
						flexShrink: 0,
					}}
				>
					{targets.length}
				</span>
			</div>

			<div style={{ display: 'flex', flexDirection: 'column' }}>
				{targets.map((target) => (
					<JumpRow
						key={`${title}-${target.key}`}
						target={target}
						colors={colors}
						onSelect={onSelect}
					/>
				))}
			</div>
		</section>
	);
}

export function TabSearchModal({
	sessions,
	activeSessionId,
	activeTabId,
	recentTargets,
	onSelectTarget,
	onClose,
}: TabSearchModalProps) {
	const colors = useThemeColors();
	const [searchQuery, setSearchQuery] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const recentLookup = useMemo(() => {
		return new Map(
			recentTargets.map(
				(target) => [`${target.sessionId}:${target.tabId}`, target.viewedAt] as const
			)
		);
	}, [recentTargets]);

	const allTargets = useMemo<SearchTarget[]>(() => {
		return sessions.flatMap((session) =>
			(session.aiTabs || []).map((tab) => {
				const key = `${session.id}:${tab.id}`;
				const recentViewedAt = recentLookup.get(key) ?? null;
				return {
					key,
					sessionId: session.id,
					tabId: tab.id,
					sessionName: session.name,
					sessionSubtitle: getSessionSubtitle(session),
					tabName: getTabDisplayName(tab),
					providerSessionId: tab.agentSessionId || null,
					isBusy: tab.state === 'busy',
					isUnread: !!tab.hasUnread,
					isActive: session.id === activeSessionId && tab.id === activeTabId,
					createdAt: tab.createdAt,
					recentViewedAt,
					searchText: [
						session.name,
						session.groupName || '',
						session.toolType,
						tab.name || '',
						tab.agentSessionId || '',
					]
						.join(' ')
						.toLowerCase(),
				};
			})
		);
	}, [sessions, recentLookup, activeSessionId, activeTabId]);

	const targetLookup = useMemo(() => {
		return new Map(allTargets.map((target) => [target.key, target] as const));
	}, [allTargets]);

	const busyTargets = useMemo(
		() =>
			allTargets
				.filter((target) => target.isBusy)
				.sort((left, right) => {
					if (left.isActive !== right.isActive) {
						return left.isActive ? -1 : 1;
					}
					return (
						(right.recentViewedAt || right.createdAt) - (left.recentViewedAt || left.createdAt)
					);
				}),
		[allTargets]
	);

	const unreadTargets = useMemo(
		() =>
			allTargets
				.filter((target) => target.isUnread)
				.sort((left, right) => {
					if (left.isActive !== right.isActive) {
						return left.isActive ? -1 : 1;
					}
					return (
						(right.recentViewedAt || right.createdAt) - (left.recentViewedAt || left.createdAt)
					);
				})
				.slice(0, 5),
		[allTargets]
	);

	const resolvedRecentTargets = useMemo(
		() =>
			recentTargets
				.map((target) => targetLookup.get(`${target.sessionId}:${target.tabId}`))
				.filter((target): target is SearchTarget => !!target)
				.slice(0, 5),
		[recentTargets, targetLookup]
	);

	const filteredTargets = useMemo(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) {
			return [];
		}

		return allTargets
			.filter((target) => target.searchText.includes(query))
			.sort((left, right) => {
				const scoreDelta = scoreTarget(right, query) - scoreTarget(left, query);
				if (scoreDelta !== 0) {
					return scoreDelta;
				}
				return (right.recentViewedAt || right.createdAt) - (left.recentViewedAt || left.createdAt);
			});
	}, [allTargets, searchQuery]);

	const handleSelect = useCallback(
		(target: SearchTarget) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onSelectTarget(target.sessionId, target.tabId);
			onClose();
		},
		[onClose, onSelectTarget]
	);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onClose();
	}, [onClose]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				handleClose();
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [handleClose]);

	return (
		<div
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: colors.bgMain,
				zIndex: 1000,
				display: 'flex',
				flexDirection: 'column',
				animation: 'tabSearchSlideUp 0.2s ease-out',
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '12px',
					padding: '12px 16px',
					paddingTop: 'max(12px, env(safe-area-inset-top))',
					borderBottom: `1px solid ${colors.border}`,
					backgroundColor: colors.bgSidebar,
				}}
			>
				<button
					type="button"
					onClick={handleClose}
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '32px',
						height: '32px',
						borderRadius: '16px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgMain,
						color: colors.textMain,
						cursor: 'pointer',
						flexShrink: 0,
					}}
					title="Close"
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
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>

				<div
					style={{
						flex: 1,
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						padding: '10px 12px',
						backgroundColor: colors.bgMain,
						border: `1px solid ${colors.border}`,
						borderRadius: '12px',
					}}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke={colors.textDim}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="11" cy="11" r="8" />
						<line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					<input
						ref={inputRef}
						type="text"
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
						placeholder="Search all chats"
						style={{
							flex: 1,
							border: 'none',
							backgroundColor: 'transparent',
							color: colors.textMain,
							fontSize: '15px',
							outline: 'none',
						}}
					/>
					{searchQuery ? (
						<button
							type="button"
							onClick={() => setSearchQuery('')}
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: '22px',
								height: '22px',
								borderRadius: '999px',
								border: 'none',
								backgroundColor: `${colors.textDim}22`,
								color: colors.textDim,
								cursor: 'pointer',
								fontSize: '14px',
							}}
						>
							×
						</button>
					) : null}
				</div>
			</div>

			<div
				style={{
					flex: 1,
					overflow: 'auto',
					padding: '18px 16px',
					paddingBottom: 'max(18px, env(safe-area-inset-bottom))',
					display: 'flex',
					flexDirection: 'column',
					gap: '24px',
				}}
			>
				{searchQuery.trim() ? (
					filteredTargets.length === 0 ? (
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								minHeight: '140px',
								color: colors.textDim,
								fontSize: '14px',
								textAlign: 'center',
							}}
						>
							No chats match "{searchQuery.trim()}"
						</div>
					) : (
						<section style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
							<div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
								<h2
									style={{
										margin: 0,
										fontSize: '15px',
										fontWeight: 700,
										color: colors.textMain,
									}}
								>
									Search Results
								</h2>
								<p
									style={{
										margin: 0,
										fontSize: '12px',
										color: colors.textDim,
									}}
								>
									Searching across every agent and chat
								</p>
							</div>
							<div style={{ display: 'flex', flexDirection: 'column' }}>
								{filteredTargets.map((target) => (
									<JumpRow
										key={target.key}
										target={target}
										colors={colors}
										onSelect={handleSelect}
									/>
								))}
							</div>
						</section>
					)
				) : (
					<>
						<Section
							title="Busy"
							description="Chats actively working right now"
							targets={busyTargets}
							colors={colors}
							onSelect={handleSelect}
						/>
						<Section
							title="Unread"
							description="Responses you have not looked at yet"
							targets={unreadTargets}
							colors={colors}
							onSelect={handleSelect}
						/>
						<Section
							title="Recent"
							description="Jump back into your last few chats"
							targets={resolvedRecentTargets}
							colors={colors}
							onSelect={handleSelect}
						/>

						{busyTargets.length === 0 &&
						unreadTargets.length === 0 &&
						resolvedRecentTargets.length === 0 ? (
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									minHeight: '160px',
									padding: '0 24px',
									color: colors.textDim,
									fontSize: '14px',
									textAlign: 'center',
								}}
							>
								Start typing to search all chats, or open a few sessions and they will show up here.
							</div>
						) : null}
					</>
				)}
			</div>

			<style>{`
				@keyframes tabSearchSlideUp {
					from {
						opacity: 0;
						transform: translateY(20px);
					}
					to {
						opacity: 1;
						transform: translateY(0);
					}
				}

				@keyframes tabSearchPulse {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.35; }
				}
			`}</style>
		</div>
	);
}

export default TabSearchModal;
