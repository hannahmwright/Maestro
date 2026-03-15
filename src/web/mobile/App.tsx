/**
 * Maestro Web Remote Control
 *
 * Lightweight interface for controlling sessions from mobile/tablet devices.
 * Focused on quick command input and session monitoring.
 */

import React, { lazy, Suspense, useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type {
	ResponseCompletedEvent,
	WebAttachmentSummary,
	WebTextAttachmentInput,
} from '../../shared/remote-web';
import type { AgentModelCatalogGroup } from '../../shared/agent-model-catalog';
import { isCompletedDemoCapture, type DemoCaptureRequest } from '../../shared/demo-artifacts';
import type { ProviderUsageSnapshot, ProviderUsageWindow } from '../../shared/provider-usage';
import {
	useWebSocket,
	type CustomCommand,
	type AutoRunState,
	type AITabData,
} from '../hooks/useWebSocket';
// Command history is no longer used in the mobile UI
import { useNotifications, type NotificationPermission } from '../hooks/useNotifications';
import { useUnreadBadge } from '../hooks/useUnreadBadge';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { useMobileSessionManagement } from '../hooks/useMobileSessionManagement';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { useOfflineStatus, useDesktopTheme, type WebAppearancePreference } from '../main';
import { showLocalServiceWorkerNotification } from '../utils/serviceWorker';
import {
	buildApiUrl,
	getCurrentDemoId,
	getCurrentSessionId,
	getDashboardUrl,
	updateUrlForDemo,
	updateUrlForSessionTab,
} from '../utils/config';
import {
	loadRecentSessionTargets,
	recordRecentSessionTarget,
	saveRecentSessionTargets,
} from '../utils/viewState';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { webLogger } from '../utils/logger';
import { CommandInputBar, type InputMode } from './CommandInputBar';
import { DEFAULT_SLASH_COMMANDS, type SlashCommand } from './SlashCommandAutocomplete';
// CommandHistoryDrawer and RecentCommandChips removed for simpler mobile UI
import { OfflineQueueBanner } from './OfflineQueueBanner';
import { MessageHistory } from './MessageHistory';
import { AutoRunIndicator } from './AutoRunIndicator';
import { TabBar } from './TabBar';
import type { ResponseItem } from './ResponseViewer';
import type { Session, LastResponsePreview } from '../hooks/useSessions';
// View state utilities are now accessed through useMobileViewState hook
// Keeping import for TypeScript types only if needed
import { useMobileKeyboardHandler } from '../hooks/useMobileKeyboardHandler';
import { useMobileViewState } from '../hooks/useMobileViewState';
import { MobileNavigationDrawer } from './MobileNavigationDrawer';
import { MobileKanbanPanel } from './MobileKanbanPanel';
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator';
import { calculateContextDisplay } from '../../renderer/utils/contextUsage';
import { ProviderModelIcon } from './CommandInputButtons';
import type {
	Group,
	Conductor,
	ConductorTask,
	ConductorRun,
	ConductorTaskPriority,
	ConductorTaskStatus,
} from '../../shared/types';

function getDemoCaptureTargetKey(sessionId: string | null, tabId: string | null): string | null {
	if (!sessionId) {
		return null;
	}
	return `${sessionId}::${tabId || ''}`;
}

const MobileHistoryPanel = lazy(() =>
	import('./MobileHistoryPanel').then((module) => ({
		default: module.MobileHistoryPanel ?? module.default,
	}))
);

const TabSearchModal = lazy(() =>
	import('./TabSearchModal').then((module) => ({
		default: module.TabSearchModal ?? module.default,
	}))
);

const ResponseViewer = lazy(() =>
	import('./ResponseViewer').then((module) => ({
		default: module.ResponseViewer ?? module.default,
	}))
);

const MobileDemoViewer = lazy(() =>
	import('./MobileDemoViewer').then((module) => ({
		default: module.MobileDemoViewer ?? module.default,
	}))
);

/**
 * Get the active tab from a session
 */
function getActiveTabFromSession(session: Session | null | undefined): AITabData | null {
	if (!session?.aiTabs || !session.activeTabId) return null;
	return session.aiTabs.find((tab) => tab.id === session.activeTabId) || null;
}

function normalizeModelLabel(model: string | null | undefined): string | null {
	const normalized = model?.trim();
	if (!normalized) return null;
	if (normalized.toLowerCase() === 'default') return null;
	return normalized;
}

function getThreadDisplayName(session: Session | null | undefined): string {
	return session?.threadTitle?.trim() || session?.name || 'Select a thread';
}

function summarizeTurnLabel(text: string | null | undefined): string {
	const normalized = (text || '').replace(/\s+/g, ' ').trim();
	if (!normalized) return 'Untitled turn';
	if (normalized.length <= 48) return normalized;
	return `${normalized.slice(0, 45).trimEnd()}...`;
}

function createAttachmentId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type MobileKanbanScope =
	| { type: 'home' }
	| {
			type: 'workspace';
			groupId: string;
	  };

interface MobileHeaderProps {
	activeSession?: Session | null;
	drawerOpen: boolean;
	onToggleDrawer: () => void;
	canOpenTabSearch: boolean;
	onOpenTabSearch: () => void;
	providerUsageSnapshot?: ProviderUsageSnapshot | null;
}

function formatUsageWindowLabel(window: ProviderUsageWindow): string {
	if (window.windowDurationMins === 10080) {
		return 'Weekly allowance';
	}

	if (window.windowDurationMins === 300) {
		return 'Current 5h window';
	}

	if (typeof window.windowDurationMins === 'number' && window.windowDurationMins > 0) {
		if (window.windowDurationMins % 60 === 0) {
			return `${window.windowDurationMins / 60}h window`;
		}
		return `${window.windowDurationMins}m window`;
	}

	return window.label;
}

function formatUsageResetTime(timestamp: number | null): string {
	if (!timestamp) {
		return 'Reset time unavailable';
	}

	try {
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		}).format(new Date(timestamp * 1000));
	} catch {
		return 'Reset time unavailable';
	}
}

function MobileHeader({
	activeSession,
	drawerOpen,
	onToggleDrawer,
	canOpenTabSearch,
	onOpenTabSearch,
	providerUsageSnapshot = null,
}: MobileHeaderProps) {
	const colors = useThemeColors();
	const providerUsagePercent = providerUsageSnapshot?.usedPercent ?? null;
	const usageMenuRef = useRef<HTMLDivElement>(null);
	const [usageMenuOpen, setUsageMenuOpen] = useState(false);
	const usageWindows = providerUsageSnapshot?.windows ?? [];

	useEffect(() => {
		if (!usageMenuOpen) {
			return;
		}

		const handlePointerDown = (event: MouseEvent | TouchEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}

			if (usageMenuRef.current && !usageMenuRef.current.contains(target)) {
				setUsageMenuOpen(false);
			}
		};

		document.addEventListener('mousedown', handlePointerDown);
		document.addEventListener('touchstart', handlePointerDown);
		return () => {
			document.removeEventListener('mousedown', handlePointerDown);
			document.removeEventListener('touchstart', handlePointerDown);
		};
	}, [usageMenuOpen]);

	useEffect(() => {
		if (!activeSession) {
			setUsageMenuOpen(false);
		}
	}, [activeSession]);

	const glassControlStyle: React.CSSProperties = {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: '42px',
		height: '42px',
		borderRadius: '15px',
		border: '1px solid rgba(255, 255, 255, 0.08)',
		background:
			'linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.05) 100%)',
		backdropFilter: 'blur(18px)',
		WebkitBackdropFilter: 'blur(18px)',
		boxShadow:
			'0 14px 28px rgba(15, 23, 42, 0.12), 0 4px 12px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.07)',
		cursor: 'pointer',
		flexShrink: 0,
	};
	const titleSurfaceStyle: React.CSSProperties = {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
		minWidth: 0,
		padding: '10px 12px',
		borderRadius: '18px',
		border: '1px solid rgba(255, 255, 255, 0.08)',
		background:
			'linear-gradient(180deg, rgba(255, 255, 255, 0.11) 0%, rgba(255, 255, 255, 0.04) 100%)',
		backdropFilter: 'blur(18px)',
		WebkitBackdropFilter: 'blur(18px)',
		boxShadow:
			'0 14px 28px rgba(15, 23, 42, 0.10), 0 4px 12px rgba(15, 23, 42, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
	};

	return (
		<header
			style={{
				position: 'relative',
				zIndex: 80,
				overflow: 'visible',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				padding: '10px 12px 10px',
				paddingTop: 'max(12px, env(safe-area-inset-top))',
				background:
					'linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.04) 100%)',
				backdropFilter: 'blur(26px)',
				WebkitBackdropFilter: 'blur(26px)',
				minHeight: '58px',
				gap: '12px',
				borderBottomLeftRadius: '24px',
				borderBottomRightRadius: '24px',
				borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
				boxShadow:
					'0 20px 38px rgba(15, 23, 42, 0.12), 0 8px 18px rgba(15, 23, 42, 0.06), inset 0 -1px 0 rgba(255, 255, 255, 0.04)',
			}}
		>
			<button
				type="button"
				onClick={onToggleDrawer}
				aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
				style={{
					...glassControlStyle,
					border: drawerOpen ? `1px solid ${colors.accent}55` : glassControlStyle.border,
					background: drawerOpen
						? `linear-gradient(180deg, ${colors.accent}18 0%, rgba(255, 255, 255, 0.04) 100%)`
						: glassControlStyle.background,
					color: drawerOpen ? colors.accent : colors.textMain,
				}}
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M4 7h16" />
					<path d="M4 12h16" />
					<path d="M4 17h16" />
				</svg>
			</button>

			<div
				style={{
					flex: 1,
					minWidth: 0,
				}}
			>
				<div
					style={{
						...titleSurfaceStyle,
						flexDirection: 'row',
						alignItems: 'center',
					}}
				>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '10px',
							minWidth: 0,
						}}
					>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '8px',
								flex: 1,
								minWidth: 0,
							}}
						>
							<span
								style={{
									fontSize: '15px',
									fontWeight: 650,
									color: colors.textMain,
									minWidth: 0,
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
									letterSpacing: '-0.02em',
									flexShrink: 1,
								}}
							>
									{getThreadDisplayName(activeSession)}
								</span>
							{activeSession && (
								<span
									style={{
										display: 'inline-flex',
										alignItems: 'center',
										gap: '5px',
										padding: '5px 10px',
										borderRadius: '999px',
										border: '1px solid rgba(255, 255, 255, 0.08)',
										background: `linear-gradient(180deg, ${colors.accent}14 0%, rgba(255, 255, 255, 0.05) 100%)`,
										backdropFilter: 'blur(16px)',
										WebkitBackdropFilter: 'blur(16px)',
										color: colors.textMain,
										fontSize: '10px',
										fontWeight: 600,
										lineHeight: 1,
										flexShrink: 0,
										whiteSpace: 'nowrap',
										boxShadow:
											'0 12px 22px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
									}}
								>
									<span style={{ lineHeight: 1 }}>{activeSession.groupEmoji || '📂'}</span>
									<span>{activeSession.groupName || 'Workspace'}</span>
								</span>
							)}
						</div>
						{activeSession && (
							<div style={{ position: 'relative', flexShrink: 0 }} ref={usageMenuRef}>
								<button
									type="button"
									onClick={() => setUsageMenuOpen((previous) => !previous)}
									title={
										providerUsagePercent === null
											? 'Provider usage unavailable'
											: `${providerUsagePercent}% provider usage`
									}
									aria-label={
										providerUsagePercent === null
											? 'Provider usage unavailable'
											: `${providerUsagePercent}% provider usage`
									}
									style={{
										display: 'inline-flex',
										alignItems: 'center',
										gap: '6px',
										flexShrink: 0,
										padding: '5px 9px',
										borderRadius: '999px',
										border: usageMenuOpen
											? `1px solid ${colors.accent}55`
											: '1px solid rgba(255, 255, 255, 0.10)',
										background: usageMenuOpen
											? `linear-gradient(180deg, ${colors.accent}18 0%, rgba(255, 255, 255, 0.06) 100%)`
											: 'linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.05) 100%)',
										boxShadow:
											'0 10px 20px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
										cursor: 'pointer',
									}}
								>
									<ProviderModelIcon
										toolType={activeSession.toolType}
										color={colors.textDim}
										size={13}
									/>
									<span
										style={{
											fontSize: '10px',
											fontWeight: 600,
											color: colors.textDim,
											whiteSpace: 'nowrap',
										}}
									>
										{providerUsagePercent === null ? '--' : `${providerUsagePercent}%`}
									</span>
								</button>
								{usageMenuOpen && (
									<div
										style={{
											position: 'absolute',
											top: 'calc(100% + 10px)',
											right: 0,
											width: 'min(240px, calc(100vw - 64px))',
											padding: '12px',
											borderRadius: '18px',
											border: '1px solid rgba(255, 255, 255, 0.12)',
											background:
												'linear-gradient(180deg, rgba(255, 255, 255, 0.90) 0%, rgba(248, 250, 252, 0.84) 100%)',
											backdropFilter: 'blur(18px)',
											WebkitBackdropFilter: 'blur(18px)',
											boxShadow:
												'0 24px 40px rgba(15, 23, 42, 0.16), 0 8px 18px rgba(15, 23, 42, 0.08)',
											zIndex: 140,
										}}
									>
										<div
											style={{
												display: 'flex',
												alignItems: 'center',
												gap: '8px',
												marginBottom: '10px',
											}}
										>
											<ProviderModelIcon
												toolType={activeSession.toolType}
												color={colors.textMain}
												size={15}
											/>
											<div style={{ minWidth: 0 }}>
												<div
													style={{
														fontSize: '12px',
														fontWeight: 700,
														color: colors.textMain,
														lineHeight: 1.2,
													}}
												>
													{providerUsageSnapshot?.label || 'Provider usage'}
												</div>
												<div
													style={{
														fontSize: '10px',
														color: colors.textDim,
														marginTop: '2px',
													}}
												>
													{providerUsagePercent === null
														? 'Usage unavailable'
														: `${providerUsagePercent}% in current window`}
												</div>
											</div>
										</div>
										<div style={{ display: 'grid', gap: '8px' }}>
											{usageWindows.length > 0 ? (
												usageWindows.map((window) => (
													<div
														key={window.id}
														style={{
															display: 'flex',
															alignItems: 'center',
															justifyContent: 'space-between',
															gap: '10px',
															padding: '9px 10px',
															borderRadius: '14px',
															background: 'rgba(255, 255, 255, 0.56)',
															border: '1px solid rgba(255, 255, 255, 0.18)',
														}}
													>
														<div style={{ minWidth: 0 }}>
															<div
																style={{
																	fontSize: '11px',
																	fontWeight: 650,
																	color: colors.textMain,
																	lineHeight: 1.2,
																}}
															>
																{formatUsageWindowLabel(window)}
															</div>
															<div
																style={{
																	fontSize: '10px',
																	color: colors.textDim,
																	marginTop: '2px',
																}}
															>
																Resets {formatUsageResetTime(window.resetsAt)}
															</div>
														</div>
														<div
															style={{
																fontSize: '13px',
																fontWeight: 700,
																color: colors.textMain,
																whiteSpace: 'nowrap',
															}}
														>
															{window.usedPercent}%
														</div>
													</div>
												))
											) : (
												<div
													style={{
														fontSize: '11px',
														color: colors.textDim,
														padding: '4px 2px',
													}}
												>
													No provider usage windows available yet.
												</div>
											)}
										</div>
									</div>
								)}
							</div>
						)}
					</div>
				</div>
			</div>

			{canOpenTabSearch ? (
				<button
					type="button"
					onClick={onOpenTabSearch}
					aria-label="Search tabs"
					style={{
						...glassControlStyle,
						color: colors.textMain,
					}}
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="11" cy="11" r="7" />
						<path d="m20 20-3.5-3.5" />
					</svg>
				</button>
			) : (
				<div style={{ width: '40px', height: '40px', flexShrink: 0 }} />
			)}
		</header>
	);
}

interface AppControlsPanelProps {
	notificationPermission: NotificationPermission;
	canInstall: boolean;
	isInstalled: boolean;
	isPushSupported: boolean;
	isPushConfigured: boolean;
	isPushSubscribed: boolean;
	isPushLoading: boolean;
	pushError: string | null;
	appearancePreference: WebAppearancePreference;
	onInstall: () => void;
	onEnableNotifications: () => void;
	onEnablePush: () => void;
	onDisablePush: () => void;
	onSendTestNotification: () => void;
	onAppearancePreferenceChange: (preference: WebAppearancePreference) => void;
	embedded?: boolean;
	hideHeader?: boolean;
}

function AppControlsPanel({
	notificationPermission,
	canInstall,
	isInstalled,
	isPushSupported,
	isPushConfigured,
	isPushSubscribed,
	isPushLoading,
	pushError,
	appearancePreference,
	onInstall,
	onEnableNotifications,
	onEnablePush,
	onDisablePush,
	onSendTestNotification,
	onAppearancePreferenceChange,
	embedded = false,
	hideHeader = false,
}: AppControlsPanelProps) {
	const colors = useThemeColors();

	const renderIcon = (type: 'install' | 'notifications' | 'push' | 'test') => {
		switch (type) {
			case 'install':
				return (
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
						<path d="M12 3v12" />
						<path d="m7 10 5 5 5-5" />
						<path d="M5 21h14" />
					</svg>
				);
			case 'notifications':
				return (
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
						<path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
						<path d="M9 17a3 3 0 0 0 6 0" />
					</svg>
				);
			case 'push':
				return (
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
						<path d="M5 12a7 7 0 0 1 14 0" />
						<path d="M8.5 12a3.5 3.5 0 0 1 7 0" />
						<path d="M12 12h.01" />
						<path d="M4 20h16" />
					</svg>
				);
			case 'test':
				return (
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
						<path d="M22 2 11 13" />
						<path d="M22 2 15 22l-4-9-9-4Z" />
					</svg>
				);
		}
	};

	const getStatusChipStyle = (
		tone: 'neutral' | 'success' | 'warning' | 'accent'
	): React.CSSProperties => {
		const toneMap = {
			neutral: {
				background: 'rgba(255, 255, 255, 0.06)',
				borderColor: 'rgba(255, 255, 255, 0.08)',
				color: colors.textDim,
			},
			success: {
				background: `${colors.success}12`,
				borderColor: `${colors.success}26`,
				color: colors.success,
			},
			warning: {
				background: `${colors.warning}12`,
				borderColor: `${colors.warning}26`,
				color: colors.warning,
			},
			accent: {
				background: `${colors.accent}12`,
				borderColor: `${colors.accent}22`,
				color: colors.accent,
			},
		} as const;

		const selectedTone = toneMap[tone];
		return {
			display: 'inline-flex',
			alignItems: 'center',
			gap: '5px',
			padding: '3px 8px',
			borderRadius: '999px',
			border: `1px solid ${selectedTone.borderColor}`,
			background: selectedTone.background,
			color: selectedTone.color,
			fontSize: '9px',
			fontWeight: 600,
			letterSpacing: '0.01em',
		};
	};

	const primaryButtonStyle: React.CSSProperties = {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '8px',
		padding: '9px 12px',
		borderRadius: '13px',
		border: `1px solid rgba(255, 255, 255, 0.12)`,
		background:
			'linear-gradient(180deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.08) 100%)',
		backdropFilter: 'blur(16px)',
		WebkitBackdropFilter: 'blur(16px)',
		color: colors.textMain,
		fontSize: '12px',
		fontWeight: 600,
		boxShadow: '0 10px 22px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
		cursor: 'pointer',
	};

	const secondaryButtonStyle: React.CSSProperties = {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '8px',
		padding: '9px 12px',
		borderRadius: '13px',
		border: `1px solid rgba(255, 255, 255, 0.08)`,
		background:
			'linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.05) 100%)',
		backdropFilter: 'blur(14px)',
		WebkitBackdropFilter: 'blur(14px)',
		color: colors.textMain,
		fontSize: '12px',
		fontWeight: 500,
		boxShadow: '0 8px 18px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
		cursor: 'pointer',
	};

	const installTone = isInstalled ? 'success' : canInstall ? 'accent' : 'neutral';
	const notificationTone =
		notificationPermission === 'granted'
			? 'success'
			: notificationPermission === 'default'
				? 'warning'
				: 'neutral';
	const pushTone =
		!isPushSupported || !isPushConfigured ? 'neutral' : isPushSubscribed ? 'success' : 'warning';
	const alertsEnabled = notificationPermission === 'granted';
	const closedAppPushEnabled = isPushSupported && isPushConfigured && isPushSubscribed;

	const setupSummary = (() => {
		if (closedAppPushEnabled) {
			return {
				tone: 'success' as const,
				title: 'Closed-app notifications are active.',
				body: 'This phone should still notify you after you fully close the PWA.',
			};
		}

		if (!alertsEnabled) {
			return {
				tone: 'warning' as const,
				title: 'Notifications are still blocked on this phone.',
				body: 'Enable Alerts first. After that, turn on Closed-App Push if you want notifications after the PWA is fully closed.',
			};
		}

		if (isPushSupported && isPushConfigured && !isPushSubscribed) {
			return {
				tone: 'accent' as const,
				title: 'Alerts work only while the PWA is open or backgrounded.',
				body: 'Turn on Closed-App Push below if you want notifications after the PWA is fully closed.',
			};
		}

		return {
			tone: 'neutral' as const,
			title: 'Closed-app push is not available on this device.',
			body: 'You can still get alerts while the PWA stays open or in the background on this phone.',
		};
	})();

	const setupSummaryStyle = (() => {
		switch (setupSummary.tone) {
			case 'success':
				return {
					background: `${colors.success}12`,
					border: `1px solid ${colors.success}24`,
					titleColor: colors.success,
				};
			case 'warning':
				return {
					background: `${colors.warning}12`,
					border: `1px solid ${colors.warning}24`,
					titleColor: colors.warning,
				};
			case 'accent':
				return {
					background: `${colors.accent}10`,
					border: `1px solid ${colors.accent}22`,
					titleColor: colors.accent,
				};
			default:
				return {
					background: 'rgba(255, 255, 255, 0.06)',
					border: '1px solid rgba(255, 255, 255, 0.08)',
					titleColor: colors.textMain,
				};
		}
	})();

	const appearanceOptions: Array<{
		value: WebAppearancePreference;
		label: string;
		description: string;
	}> = [
		{
			value: 'system',
			label: 'Auto',
			description: 'Uses the desktop theme when available, otherwise your device setting.',
		},
		{
			value: 'light',
			label: 'Light',
			description: 'Keeps the PWA in a bright reading mode on this device.',
		},
		{
			value: 'dark',
			label: 'Dark',
			description: 'Keeps the PWA in a darker low-glare mode on this device.',
		},
	];

	return (
		<section
			style={{
				padding: embedded ? 0 : '12px',
				borderRadius: embedded ? 0 : '20px',
				border: embedded ? 'none' : '1px solid rgba(255, 255, 255, 0.08)',
				background: embedded
					? 'transparent'
					: 'linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.04) 100%)',
				backdropFilter: embedded ? undefined : 'blur(22px)',
				WebkitBackdropFilter: embedded ? undefined : 'blur(22px)',
				boxShadow: embedded
					? 'none'
					: '0 14px 30px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
				display: 'flex',
				flexDirection: 'column',
				gap: '10px',
			}}
		>
			{!hideHeader && (
				<div
					style={{
						display: 'flex',
						justifyContent: 'space-between',
						gap: '10px',
						alignItems: 'flex-start',
					}}
				>
					<div style={{ minWidth: 0 }}>
						<div
							style={{ fontSize: '14px', fontWeight: 600, color: colors.textMain, lineHeight: 1.1 }}
						>
							App Controls
						</div>
						<div
							style={{
								fontSize: '11px',
								color: colors.textDim,
								marginTop: '3px',
								lineHeight: 1.35,
							}}
						>
							Install the PWA and manage completion alerts.
						</div>
					</div>
					<div
						style={{
							display: 'flex',
							flexWrap: 'wrap',
							justifyContent: 'flex-end',
							gap: '5px',
							maxWidth: '50%',
						}}
					>
						<div style={getStatusChipStyle(installTone)}>
							<span style={{ opacity: 0.7 }}>Install</span>
							<span>{isInstalled ? 'Installed' : canInstall ? 'Ready' : 'Unavailable'}</span>
						</div>
						<div style={getStatusChipStyle(notificationTone)}>
							<span style={{ opacity: 0.7 }}>Alerts</span>
							<span>
								{notificationPermission === 'granted'
									? 'On'
									: notificationPermission === 'default'
										? 'Pending'
										: 'Off'}
							</span>
						</div>
						<div style={getStatusChipStyle(pushTone)}>
							<span style={{ opacity: 0.7 }}>Push</span>
							<span>
								{!isPushSupported
									? 'Unsupported'
									: !isPushConfigured
										? 'Unavailable'
										: isPushSubscribed
											? 'On'
											: 'Off'}
							</span>
						</div>
					</div>
				</div>
			)}

			{hideHeader && (
				<div
					style={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: '5px',
					}}
				>
					<div style={getStatusChipStyle(installTone)}>
						<span style={{ opacity: 0.7 }}>Install</span>
						<span>{isInstalled ? 'Installed' : canInstall ? 'Ready' : 'Unavailable'}</span>
					</div>
					<div style={getStatusChipStyle(notificationTone)}>
						<span style={{ opacity: 0.7 }}>Alerts</span>
						<span>
							{notificationPermission === 'granted'
								? 'On'
								: notificationPermission === 'default'
									? 'Pending'
									: 'Off'}
						</span>
					</div>
					<div style={getStatusChipStyle(pushTone)}>
						<span style={{ opacity: 0.7 }}>Push</span>
						<span>
							{!isPushSupported
								? 'Unsupported'
								: !isPushConfigured
									? 'Unavailable'
									: isPushSubscribed
										? 'On'
										: 'Off'}
						</span>
					</div>
				</div>
			)}

			<div
				style={{
					padding: '10px 11px',
					borderRadius: '14px',
					border: '1px solid rgba(255, 255, 255, 0.08)',
					background: 'rgba(255, 255, 255, 0.05)',
					display: 'flex',
					flexDirection: 'column',
					gap: '8px',
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						gap: '10px',
					}}
				>
					<div>
						<div
							style={{
								fontSize: '12px',
								fontWeight: 650,
								color: colors.textMain,
								lineHeight: 1.25,
							}}
						>
							Appearance
						</div>
						<div
							style={{
								marginTop: '3px',
								fontSize: '10px',
								color: colors.textDim,
								lineHeight: 1.4,
							}}
						>
							Choose how this PWA should look on this device.
						</div>
					</div>
					<div style={getStatusChipStyle(appearancePreference === 'system' ? 'accent' : 'success')}>
						<span style={{ opacity: 0.7 }}>Theme</span>
						<span>
							{appearancePreference === 'system'
								? 'Auto'
								: appearancePreference === 'light'
									? 'Light'
									: 'Dark'}
						</span>
					</div>
				</div>

				<div
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
						gap: '6px',
					}}
				>
					{appearanceOptions.map((option) => {
						const isSelected = appearancePreference === option.value;
						return (
							<button
								key={option.value}
								type="button"
								onClick={() => onAppearancePreferenceChange(option.value)}
								aria-pressed={isSelected}
								style={{
									padding: '10px 8px',
									borderRadius: '12px',
									border: isSelected
										? `1px solid ${colors.accent}`
										: '1px solid rgba(255, 255, 255, 0.08)',
									background: isSelected
										? `${colors.accent}20`
										: 'rgba(255, 255, 255, 0.04)',
									color: isSelected ? colors.accent : colors.textDim,
									cursor: 'pointer',
									display: 'flex',
									flexDirection: 'column',
									alignItems: 'flex-start',
									gap: '3px',
									textAlign: 'left',
								}}
							>
								<span
									style={{
										fontSize: '11px',
										fontWeight: 650,
										color: colors.textMain,
									}}
								>
									{option.label}
								</span>
								<span
									style={{
										fontSize: '10px',
										lineHeight: 1.35,
									}}
								>
									{option.description}
								</span>
							</button>
						);
					})}
				</div>
			</div>

			<div
				style={{
					padding: '10px 11px',
					borderRadius: '14px',
					background: setupSummaryStyle.background,
					border: setupSummaryStyle.border,
					display: 'flex',
					flexDirection: 'column',
					gap: '4px',
				}}
			>
				<div
					style={{
						fontSize: '12px',
						fontWeight: 650,
						color: setupSummaryStyle.titleColor,
						lineHeight: 1.25,
					}}
				>
					{setupSummary.title}
				</div>
				<div
					style={{
						fontSize: '11px',
						color: colors.textDim,
						lineHeight: 1.4,
					}}
				>
					{setupSummary.body}
				</div>
			</div>

			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
					gap: '8px',
				}}
			>
				<div
					style={{
						padding: '9px 10px',
						borderRadius: '14px',
						border: '1px solid rgba(255, 255, 255, 0.08)',
						background: 'rgba(255, 255, 255, 0.05)',
					}}
				>
					<div
						style={{
							fontSize: '11px',
							fontWeight: 600,
							color: colors.textMain,
							lineHeight: 1.25,
						}}
					>
						Alerts
					</div>
					<div
						style={{
							marginTop: '4px',
							fontSize: '10px',
							color: colors.textDim,
							lineHeight: 1.45,
						}}
					>
						Works while Maestro is open or backgrounded on this phone.
					</div>
				</div>

				<div
					style={{
						padding: '9px 10px',
						borderRadius: '14px',
						border: '1px solid rgba(255, 255, 255, 0.08)',
						background: 'rgba(255, 255, 255, 0.05)',
					}}
				>
					<div
						style={{
							fontSize: '11px',
							fontWeight: 600,
							color: colors.textMain,
							lineHeight: 1.25,
						}}
					>
						Closed-App Push
					</div>
					<div
						style={{
							marginTop: '4px',
							fontSize: '10px',
							color: colors.textDim,
							lineHeight: 1.45,
						}}
					>
						Keeps notifying after you fully close the PWA.
					</div>
				</div>
			</div>

			<div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
				{canInstall && (
					<button onClick={onInstall} style={primaryButtonStyle}>
						<span
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: '24px',
								height: '24px',
								borderRadius: '999px',
								background: 'rgba(255, 255, 255, 0.14)',
								color: colors.accent,
								flexShrink: 0,
							}}
						>
							{renderIcon('install')}
						</span>
						<span>Install App</span>
					</button>
				)}

				{notificationPermission !== 'granted' && (
					<button onClick={onEnableNotifications} style={secondaryButtonStyle}>
						<span
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: '24px',
								height: '24px',
								borderRadius: '999px',
								background: 'rgba(255, 255, 255, 0.10)',
								color: colors.accent,
								flexShrink: 0,
							}}
						>
							{renderIcon('notifications')}
						</span>
						<span>Enable Alerts</span>
					</button>
				)}

				{isPushSupported && isPushConfigured && !isPushSubscribed && (
					<button onClick={onEnablePush} style={primaryButtonStyle} disabled={isPushLoading}>
						<span
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: '24px',
								height: '24px',
								borderRadius: '999px',
								background: 'rgba(255, 255, 255, 0.14)',
								color: colors.accent,
								flexShrink: 0,
							}}
						>
							{renderIcon('push')}
						</span>
						<span>{isPushLoading ? 'Enabling Push...' : 'Enable Closed-App Push'}</span>
					</button>
				)}

				{isPushSupported && isPushConfigured && isPushSubscribed && (
					<button onClick={onDisablePush} style={secondaryButtonStyle} disabled={isPushLoading}>
						<span
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: '24px',
								height: '24px',
								borderRadius: '999px',
								background: 'rgba(255, 255, 255, 0.10)',
								color: colors.accent,
								flexShrink: 0,
							}}
						>
							{renderIcon('push')}
						</span>
						<span>{isPushLoading ? 'Updating...' : 'Disable Closed-App Push'}</span>
					</button>
				)}

				{isPushSupported && isPushConfigured && isPushSubscribed && (
					<button
						onClick={onSendTestNotification}
						style={secondaryButtonStyle}
						disabled={isPushLoading}
					>
						<span
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: '24px',
								height: '24px',
								borderRadius: '999px',
								background: 'rgba(255, 255, 255, 0.10)',
								color: colors.accent,
								flexShrink: 0,
							}}
						>
							{renderIcon('test')}
						</span>
						<span>Send Test Notification</span>
					</button>
				)}
			</div>

			{pushError && (
				<div
					style={{
						fontSize: '11px',
						color: colors.error,
						backgroundColor: `${colors.error}15`,
						borderRadius: '10px',
						padding: '7px 9px',
					}}
				>
					{pushError}
				</div>
			)}
		</section>
	);
}

/**
 * Main mobile app component with WebSocket connection management
 */
export default function MobileApp() {
	const colors = useThemeColors();
	const isOffline = useOfflineStatus();
	const { setDesktopTheme, appearancePreference, setAppearancePreference } = useDesktopTheme();

	// View state persistence and screen tracking (hook consolidates multiple effects)
	const {
		isSmallScreen,
		savedState,
		savedScrollState: _savedScrollState,
		persistViewState,
		persistHistoryState,
		persistSessionSelection,
	} = useMobileViewState();

	// UI state (not part of session management)
	const [showNavigationDrawer, setShowNavigationDrawer] = useState(false);
	const [showAppControlsSheet, setShowAppControlsSheet] = useState(false);
	const [showHistoryPanel, setShowHistoryPanel] = useState(savedState.showHistoryPanel);
	const [showTabSearch, setShowTabSearch] = useState(savedState.showTabSearch);
	const [kanbanScope, setKanbanScope] = useState<MobileKanbanScope | null>(null);
	const [commandInput, setCommandInput] = useState('');
	const [stagedImages, setStagedImages] = useState<string[]>([]);
	const [stagedTextAttachments, setStagedTextAttachments] = useState<WebTextAttachmentInput[]>([]);
	const [demoCaptureRequiredByTarget, setDemoCaptureRequiredByTarget] = useState<
		Record<string, true | undefined>
	>({});
	const [composerHeight, setComposerHeight] = useState(0);
	const [showResponseViewer, setShowResponseViewer] = useState(false);
	const [selectedResponse, setSelectedResponse] = useState<LastResponsePreview | null>(null);
	const [responseIndex, setResponseIndex] = useState(0);
	const [recentTargets, setRecentTargets] = useState(() => loadRecentSessionTargets());
	const [activeDemoId, setActiveDemoId] = useState<string | null>(() => getCurrentDemoId());

	// Custom slash commands from desktop
	const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);

	// AutoRun state per session (batch processing on desktop)
	const [autoRunStates, setAutoRunStates] = useState<Record<string, AutoRunState | null>>({});

	// History panel state (persisted)
	const [historyFilter, setHistoryFilter] = useState<'all' | 'AUTO' | 'USER'>(
		savedState.historyFilter
	);
	const [historySearchQuery, setHistorySearchQuery] = useState(savedState.historySearchQuery);
	const [historySearchOpen, setHistorySearchOpen] = useState(savedState.historySearchOpen);

	// Notification permission hook - prompt only from explicit user actions
	const {
		permission: notificationPermission,
		showNotification,
		requestPermission: requestNotificationPermission,
	} = useNotifications({
		autoRequest: false,
		onGranted: () => {
			webLogger.debug('Notification permission granted', 'Mobile');
			triggerHaptic(HAPTIC_PATTERNS.success);
		},
		onDenied: () => {
			webLogger.debug('Notification permission denied', 'Mobile');
		},
	});

	const { canInstall, isInstalled, install } = useInstallPrompt();

	const {
		isSupported: isPushSupported,
		isConfigured: isPushConfigured,
		isSubscribed: isPushSubscribed,
		isLoading: isPushLoading,
		error: pushError,
		subscribe: subscribeToPush,
		unsubscribe: unsubscribeFromPush,
		sendTestNotification,
		refresh: refreshPushSubscription,
	} = usePushSubscription({
		notificationPermission,
		requestNotificationPermission,
	});

	// Unread badge hook - tracks unread responses and updates app badge
	const { addUnread: addUnreadResponse, unreadCount: _unreadCount } = useUnreadBadge({
		autoClearOnVisible: true, // Clear badge when user opens the app
		onCountChange: (count) => {
			webLogger.debug(`Unread response count: ${count}`, 'Mobile');
		},
	});

	// Reference to send function for offline queue (will be set after useWebSocket)
	const sendRef = useRef<
		| ((
				sessionId: string,
				command: string,
				inputMode: InputMode,
				images?: string[],
				textAttachments?: WebTextAttachmentInput[],
				attachments?: WebAttachmentSummary[],
				demoCapture?: DemoCaptureRequest
		  ) => boolean)
		| null
	>(null);
	const handledResponseEventIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (!isPushConfigured) {
			return;
		}

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				refreshPushSubscription().catch((error) => {
					webLogger.error(
						'Failed to refresh push subscription on visibility change',
						'Mobile',
						error
					);
				});
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
	}, [isPushConfigured, refreshPushSubscription]);

	// Save view state when overlays change (using hook's persistence function)
	useEffect(() => {
		persistViewState({ showAllSessions: false, showHistoryPanel, showTabSearch });
	}, [showHistoryPanel, showTabSearch, persistViewState]);

	// Save history panel state when it changes (using hook's persistence function)
	useEffect(() => {
		persistHistoryState({ historyFilter, historySearchQuery, historySearchOpen });
	}, [historyFilter, historySearchQuery, historySearchOpen, persistHistoryState]);

	// Ref to WebSocket send function (updated after useWebSocket is initialized)
	const wsSendRef = useRef<((message: Record<string, unknown>) => boolean) | null>(null);

	const rememberResponseEvent = useCallback((eventId: string): boolean => {
		const handled = handledResponseEventIdsRef.current;
		if (handled.has(eventId)) {
			return false;
		}
		handled.add(eventId);
		if (handled.size > 300) {
			const recentIds = Array.from(handled).slice(-150);
			handledResponseEventIdsRef.current = new Set(recentIds);
		}
		return true;
	}, []);

	const handleResponseCompletedEvent = useCallback(
		async (event: ResponseCompletedEvent) => {
			if (!rememberResponseEvent(event.eventId)) {
				return;
			}

			if (document.visibilityState !== 'hidden') {
				webLogger.debug(`Response event ${event.eventId} received while visible`, 'Mobile');
				return;
			}

			addUnreadResponse(event.eventId);
			webLogger.debug(`Added unread response event: ${event.eventId}`, 'Mobile');

			if (notificationPermission !== 'granted') {
				return;
			}

			let shown = await showLocalServiceWorkerNotification(event);
			if (!shown) {
				shown = await showNotification(event.title, {
					body: event.body,
					tag: `maestro-response-${event.eventId}`,
					silent: false,
					requireInteraction: false,
					data: {
						eventId: event.eventId,
						sessionId: event.sessionId,
						tabId: event.tabId,
						deepLinkUrl: event.deepLinkUrl,
					},
				});
			}

			if (shown) {
				webLogger.debug(`Notification shown for response event: ${event.eventId}`, 'Mobile');
			}
		},
		[addUnreadResponse, notificationPermission, rememberResponseEvent, showNotification]
	);

	const clearDemoCaptureRequirement = useCallback((sessionId: string, tabId: string | null) => {
		const targetKey = getDemoCaptureTargetKey(sessionId, tabId);
		if (!targetKey) {
			return;
		}

		setDemoCaptureRequiredByTarget((prev) => {
			if (!prev[targetKey]) {
				return prev;
			}
			const { [targetKey]: _removed, ...rest } = prev;
			return rest;
		});
	}, []);

	const handleLiveSessionLogEntry = useCallback(
		(
			sessionId: string,
			tabId: string | null,
			inputMode: 'ai' | 'terminal',
			logEntry: { metadata?: { demoCard?: Parameters<typeof isCompletedDemoCapture>[0] } }
		) => {
			if (inputMode !== 'ai') {
				return;
			}

			const demoCard = logEntry.metadata?.demoCard;
			if (demoCard && isCompletedDemoCapture(demoCard)) {
				clearDemoCaptureRequirement(sessionId, tabId);
			}
		},
		[clearDemoCaptureRequirement]
	);

	// Session management hook - handles session state, logs, and WebSocket handlers
	const {
		sessions,
		setSessions,
		activeSessionId,
		activeTabId,
		activeSession,
		sessionLogs,
		isLoadingLogs,
		isSyncingLogs,
		handleSelectSession,
		handleSelectSessionTab,
		handleSelectTab,
		handleNewThread,
		handleDeleteSession,
		addUserLogEntry,
		sessionsHandlers,
	} = useMobileSessionManagement({
		savedActiveSessionId: savedState.activeSessionId,
		savedActiveTabId: savedState.activeTabId,
		isOffline,
		sendRef: wsSendRef,
		triggerHaptic,
		hapticTapPattern: HAPTIC_PATTERNS.tap,
		onResponseCompletedEvent: (event) => {
			void handleResponseCompletedEvent(event);
		},
		onThemeUpdate: setDesktopTheme,
		onCustomCommands: setCustomCommands,
		onAutoRunStateChange: (sessionId, state) => {
			webLogger.info(
				`[App] AutoRun state change: session=${sessionId}, isRunning=${state?.isRunning}, tasks=${state?.completedTasks}/${state?.totalTasks}`,
				'Mobile'
			);
			setAutoRunStates((prev) => ({
				...prev,
				[sessionId]: state,
			}));
		},
		onLiveSessionLogEntry: handleLiveSessionLogEntry,
	});
	const activeTab = getActiveTabFromSession(activeSession);
	const activeDemoCaptureTargetKey = getDemoCaptureTargetKey(activeSessionId, activeTabId);
	const demoCaptureRequested = activeDemoCaptureTargetKey
		? demoCaptureRequiredByTarget[activeDemoCaptureTargetKey] === true
		: false;
	const setDemoCaptureRequested = useCallback(
		(nextValue: boolean | ((previous: boolean) => boolean)) => {
			if (!activeDemoCaptureTargetKey) {
				return;
			}

			setDemoCaptureRequiredByTarget((previous) => {
				const currentValue = previous[activeDemoCaptureTargetKey] === true;
				const resolvedValue =
					typeof nextValue === 'function' ? nextValue(currentValue) : nextValue;

				if (resolvedValue === currentValue) {
					return previous;
				}

				if (resolvedValue) {
					return {
						...previous,
						[activeDemoCaptureTargetKey]: true,
					};
				}

				const { [activeDemoCaptureTargetKey]: _removed, ...rest } = previous;
				return rest;
			});
		},
		[activeDemoCaptureTargetKey]
	);
	const isAiThread = Boolean(activeSession && activeSession.toolType !== 'terminal');
	const supportsModelSelection = Boolean(isAiThread && activeSession?.supportsModelSelection);
	const activeModelLabel =
		normalizeModelLabel(activeTab?.currentModel) ||
		normalizeModelLabel(activeSession?.customModel) ||
		normalizeModelLabel(activeSession?.effectiveModelLabel) ||
		'Model';
	const contextUsagePercentage = activeTab?.usageStats
		? calculateContextDisplay(
				{
					inputTokens: activeTab.usageStats.inputTokens,
					outputTokens: activeTab.usageStats.outputTokens,
					cacheReadInputTokens: activeTab.usageStats.cacheReadInputTokens ?? 0,
					cacheCreationInputTokens: activeTab.usageStats.cacheCreationInputTokens ?? 0,
				},
				activeSession?.effectiveContextWindow ??
					activeTab.usageStats.contextWindow ??
					activeSession?.usageStats?.contextWindow ??
					0,
				activeSession?.toolType,
				activeSession?.contextUsage ?? null
			).percentage
		: activeSession?.usageStats
			? calculateContextDisplay(
					{
						inputTokens: activeSession.usageStats.inputTokens,
						outputTokens: activeSession.usageStats.outputTokens,
						cacheReadInputTokens: activeSession.usageStats.cacheReadInputTokens ?? 0,
						cacheCreationInputTokens: activeSession.usageStats.cacheCreationInputTokens ?? 0,
					},
					activeSession.effectiveContextWindow ?? activeSession.usageStats.contextWindow ?? 0,
					activeSession.toolType,
					activeSession.contextUsage ?? null
				).percentage
			: null;
	const contextUsageColor =
		contextUsagePercentage === null
			? colors.textDim
			: contextUsagePercentage >= 90
				? colors.error
				: contextUsagePercentage >= 70
					? colors.warning
					: colors.success;
	const [activeTurnMarkerKey, setActiveTurnMarkerKey] = useState<string | null>(null);
	const [pendingTurnJumpKey, setPendingTurnJumpKey] = useState<string | null>(null);
	const [providerUsageSnapshot, setProviderUsageSnapshot] = useState<ProviderUsageSnapshot | null>(
		null
	);
	const [conductorGroups, setConductorGroups] = useState<Group[]>([]);
	const [conductorState, setConductorState] = useState<{
		conductors: Conductor[];
		tasks: ConductorTask[];
		runs: ConductorRun[];
	}>({
		conductors: [],
		tasks: [],
		runs: [],
	});
	const [isKanbanLoading, setIsKanbanLoading] = useState(false);
	const [kanbanError, setKanbanError] = useState<string | null>(null);
	const providerUsageSnapshotCacheRef = useRef<Record<string, ProviderUsageSnapshot>>({});
	const threadConversationLogs = useMemo(
		() => (isAiThread ? sessionLogs.aiLogs : []),
		[isAiThread, sessionLogs.aiLogs]
	);
	const threadChatLogs = useMemo(
		() => threadConversationLogs.filter((log) => log.source !== 'tool'),
		[threadConversationLogs]
	);
	const currentConversationLogs = useMemo(
		() =>
			activeSession?.inputMode === 'ai'
				? sessionLogs.aiLogs
				: activeSession?.inputMode === 'terminal'
					? sessionLogs.shellLogs
					: [],
		[activeSession?.inputMode, sessionLogs.aiLogs, sessionLogs.shellLogs]
	);
	const currentChatLogs = useMemo(
		() =>
			activeSession?.inputMode === 'ai'
				? currentConversationLogs.filter((log) => log.source !== 'tool')
				: currentConversationLogs,
		[activeSession?.inputMode, currentConversationLogs]
	);
	const hasStartedConversation = useMemo(() => {
		if (!isAiThread) {
			return true;
		}
		if (activeTab?.agentSessionId) {
			return true;
		}
		return threadChatLogs.some((entry) => entry.source !== 'system');
	}, [activeTab?.agentSessionId, isAiThread, threadChatLogs]);
	const canChooseProviderModels = Boolean(isAiThread && !hasStartedConversation);
	useEffect(() => {
		if (!isAiThread) {
			setActiveTurnMarkerKey(null);
			setPendingTurnJumpKey(null);
		}
	}, [isAiThread]);

	useEffect(() => {
		let cancelled = false;

		if (!activeSessionId || !isAiThread) {
			setProviderUsageSnapshot(null);
			return;
		}

		setProviderUsageSnapshot(providerUsageSnapshotCacheRef.current[activeSessionId] ?? null);

		const loadProviderUsage = async () => {
			try {
				const response = await fetch(buildApiUrl(`/session/${activeSessionId}/provider-usage`), {
					credentials: 'include',
					cache: 'no-store',
				});

				if (!response.ok) {
					throw new Error(`Failed to load provider usage for session ${activeSessionId}`);
				}

				const data = (await response.json()) as { usage?: ProviderUsageSnapshot | null };
				if (!cancelled && data.usage) {
					providerUsageSnapshotCacheRef.current[activeSessionId] = data.usage;
					setProviderUsageSnapshot(data.usage);
				}
			} catch (error) {
				webLogger.debug('Failed to load provider usage snapshot', 'Mobile', error);
			}
		};

		void loadProviderUsage();
		const intervalId = window.setInterval(() => {
			void loadProviderUsage();
		}, 60000);

		return () => {
			cancelled = true;
			window.clearInterval(intervalId);
		};
	}, [activeSessionId, isAiThread]);

	// Save session selection when it changes (using hook's persistence function)
	useEffect(() => {
		persistSessionSelection({ activeSessionId, activeTabId });
	}, [activeSessionId, activeTabId, persistSessionSelection]);

	useEffect(() => {
		if (!activeSessionId || !activeTabId || activeTabId.startsWith('pending-tab-')) {
			return;
		}

		setRecentTargets((previous) => {
			const next = recordRecentSessionTarget(previous, activeSessionId, activeTabId);
			saveRecentSessionTargets(next);
			return next;
		});
	}, [activeSessionId, activeTabId]);

	const {
		state: connectionState,
		connect,
		send,
		error,
		reconnectAttempts,
	} = useWebSocket({
		autoReconnect: true,
		maxReconnectAttempts: 6,
		reconnectDelay: 1500,
		handlers: sessionsHandlers,
	});

	// Update wsSendRef after WebSocket is initialized (for session management hook)
	useEffect(() => {
		wsSendRef.current = send;
	}, [send]);

	useEffect(() => {
		const handleResume = () => {
			if (document.visibilityState === 'hidden' || isOffline) {
				return;
			}

			if (connectionState === 'connecting' || connectionState === 'authenticating') {
				return;
			}

			connect();
		};

		document.addEventListener('visibilitychange', handleResume);
		window.addEventListener('focus', handleResume);
		window.addEventListener('pageshow', handleResume);
		window.addEventListener('online', handleResume);
		return () => {
			document.removeEventListener('visibilitychange', handleResume);
			window.removeEventListener('focus', handleResume);
			window.removeEventListener('pageshow', handleResume);
			window.removeEventListener('online', handleResume);
		};
	}, [connect, connectionState, isOffline]);

	// Connect on mount. The config is injected into the HTML shell before React loads,
	// so waiting for full page load only adds an extra disconnected -> connecting hop.
	useEffect(() => {
		connect();
	}, [connect]);

	// Update sendRef after WebSocket is initialized (for offline queue)
	useEffect(() => {
		sendRef.current = (
			sessionId: string,
			command: string,
			inputMode: InputMode,
			images?: string[],
			textAttachments?: WebTextAttachmentInput[],
			attachments?: WebAttachmentSummary[],
			demoCapture?: DemoCaptureRequest
		) => {
			return send({
				type: 'send_command',
				sessionId,
				command,
				inputMode,
				images,
				textAttachments,
				attachments,
				demoCapture,
			});
		};
	}, [send]);

	// Determine if we're actually connected
	const isActuallyConnected =
		!isOffline && (connectionState === 'connected' || connectionState === 'authenticated');

	useEffect(() => {
		if (activeSession?.inputMode !== 'ai') {
			setStagedImages([]);
			setStagedTextAttachments([]);
		}
	}, [activeSession?.id, activeSession?.inputMode]);

	useEffect(() => {
		const handlePopState = () => {
			setActiveDemoId(getCurrentDemoId());
		};

		window.addEventListener('popstate', handlePopState);
		return () => window.removeEventListener('popstate', handlePopState);
	}, []);

	// Offline queue hook - stores commands typed while offline and sends when reconnected
	const {
		queue: offlineQueue,
		queueLength: offlineQueueLength,
		status: offlineQueueStatus,
		queueCommand,
		removeCommand: removeQueuedCommand,
		clearQueue: clearOfflineQueue,
		processQueue: processOfflineQueue,
	} = useOfflineQueue({
		isOnline: !isOffline,
		isConnected: isActuallyConnected,
		sendCommand: (
			sessionId,
			command,
			inputMode,
			images,
			textAttachments,
			attachments,
			demoCapture
		) => {
			if (sendRef.current) {
				return sendRef.current(
					sessionId,
					command,
					inputMode,
					images,
					textAttachments,
					attachments,
					demoCapture
				);
			}
			return false;
		},
		onCommandSent: (cmd) => {
			webLogger.debug(`Queued command sent: ${cmd.command.substring(0, 50)}`, 'Mobile');
			triggerHaptic(HAPTIC_PATTERNS.success);
		},
		onCommandFailed: (cmd, error) => {
			webLogger.error(`Queued command failed: ${cmd.command.substring(0, 50)}`, 'Mobile', error);
		},
		onProcessingStart: () => {
			webLogger.debug('Processing offline queue...', 'Mobile');
		},
		onProcessingComplete: (successCount, failCount) => {
			webLogger.debug(
				`Offline queue processed. Success: ${successCount}, Failed: ${failCount}`,
				'Mobile'
			);
			if (successCount > 0) {
				triggerHaptic(HAPTIC_PATTERNS.success);
			}
		},
	});

	const handleToggleNavigationDrawer = useCallback(() => {
		setShowNavigationDrawer((prev) => !prev);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	const handleCloseNavigationDrawer = useCallback(() => {
		setShowNavigationDrawer(false);
	}, []);

	const handleOpenAppControlsSheet = useCallback(() => {
		setShowNavigationDrawer(false);
		setShowAppControlsSheet(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	const handleCloseAppControlsSheet = useCallback(() => {
		setShowAppControlsSheet(false);
	}, []);

	const handleInstallApp = useCallback(() => {
		void install();
	}, [install]);

	const handleEnableNotifications = useCallback(() => {
		void requestNotificationPermission();
	}, [requestNotificationPermission]);

	const handleEnablePush = useCallback(() => {
		void subscribeToPush();
	}, [subscribeToPush]);

	const handleDisablePush = useCallback(() => {
		void unsubscribeFromPush();
	}, [unsubscribeFromPush]);

	const handleSendTestNotification = useCallback(() => {
		void sendTestNotification();
	}, [sendTestNotification]);

	const handleAppearancePreferenceChange = useCallback(
		(preference: WebAppearancePreference) => {
			setAppearancePreference(preference);
			triggerHaptic(HAPTIC_PATTERNS.tap);
		},
		[setAppearancePreference]
	);

	const isBootstrappingConnection =
		!isOffline &&
		sessions.length === 0 &&
		(connectionState === 'disconnected' ||
			connectionState === 'connecting' ||
			connectionState === 'authenticating') &&
		!error &&
		reconnectAttempts === 0;

	// Handle opening History panel (separate from command history drawer)
	const handleOpenHistoryPanel = useCallback(() => {
		setShowNavigationDrawer(false);
		setShowHistoryPanel(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	// Handle closing History panel
	const handleCloseHistoryPanel = useCallback(() => {
		setShowHistoryPanel(false);
	}, []);

	// Handle opening Tab Search modal
	const handleOpenTabSearch = useCallback(() => {
		setShowNavigationDrawer(false);
		setShowTabSearch(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	// Handle closing Tab Search modal
	const handleCloseTabSearch = useCallback(() => {
		setShowTabSearch(false);
	}, []);

	const handleOpenKanbanHome = useCallback(() => {
		setShowNavigationDrawer(false);
		setKanbanScope({ type: 'home' });
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	const handleOpenWorkspaceKanban = useCallback((groupId: string) => {
		setShowNavigationDrawer(false);
		setKanbanScope({ type: 'workspace', groupId });
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	const handleCloseKanbanPanel = useCallback(() => {
		setKanbanScope(null);
	}, []);

	const handleSelectSessionFromDrawer = useCallback(
		(sessionId: string) => {
			setShowNavigationDrawer(false);
			handleSelectSession(sessionId);
		},
		[handleSelectSession]
	);

	const handleLoadSessionModels = useCallback(
		async (forceRefresh = false): Promise<string[]> => {
			if (!activeSessionId) {
				return [];
			}

			const apiUrl = new URL(
				buildApiUrl(`/session/${activeSessionId}/models`),
				window.location.origin
			);
			if (forceRefresh) {
				apiUrl.searchParams.set('forceRefresh', 'true');
			}

			const response = await fetch(apiUrl.toString(), {
				credentials: 'include',
			});
			if (!response.ok) {
				throw new Error(`Failed to load models for session ${activeSessionId}`);
			}

			const data = (await response.json()) as { models?: string[] };
			return Array.isArray(data.models) ? data.models : [];
		},
		[activeSessionId]
	);

	const handleLoadProviderModels = useCallback(
		async (forceRefresh = false): Promise<AgentModelCatalogGroup[]> => {
			if (!activeSessionId) {
				return [];
			}

			const apiUrl = new URL(
				buildApiUrl(`/session/${activeSessionId}/model-catalog`),
				window.location.origin
			);
			if (forceRefresh) {
				apiUrl.searchParams.set('forceRefresh', 'true');
			}

			const response = await fetch(apiUrl.toString(), {
				credentials: 'include',
			});
			if (!response.ok) {
				throw new Error(`Failed to load model catalog for session ${activeSessionId}`);
			}

			const data = (await response.json()) as { groups?: AgentModelCatalogGroup[] };
			return Array.isArray(data.groups) ? data.groups : [];
		},
		[activeSessionId]
	);

	const handleSelectSessionModel = useCallback(
		async (model: string | null) => {
			if (!activeSessionId) {
				return;
			}

			const normalizedModel = model?.trim() ? model.trim() : null;
			const response = await fetch(buildApiUrl(`/session/${activeSessionId}/model`), {
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: normalizedModel,
				}),
			});

			if (!response.ok) {
				throw new Error(`Failed to update model for session ${activeSessionId}`);
			}

			setSessions((prev) =>
				prev.map((session) =>
					session.id === activeSessionId
						? {
								...session,
								customModel: normalizedModel,
							}
						: session
				)
			);
		},
		[activeSessionId, setSessions]
	);

	const handleSelectProviderModel = useCallback(
		async (provider: string, model: string | null) => {
			if (!activeSessionId || !activeSession) {
				return;
			}

			if (provider === activeSession.toolType) {
				await handleSelectSessionModel(model);
				return;
			}

			const response = await fetch(buildApiUrl(`/session/${activeSessionId}/fork-thread`), {
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					toolType: provider,
					model: model?.trim() ? model.trim() : null,
				}),
			});

			if (!response.ok) {
				throw new Error(`Failed to fork thread for session ${activeSessionId}`);
			}

			const data = (await response.json()) as {
				success?: boolean;
				sessionId?: string | null;
			};

			if (!data.success || !data.sessionId) {
				throw new Error(`Forked thread did not return a new session for ${activeSessionId}`);
			}

			handleSelectSession(data.sessionId);
		},
		[activeSession, activeSessionId, handleSelectSession, handleSelectSessionModel]
	);

	const loadConductorSnapshot = useCallback(async () => {
		setIsKanbanLoading(true);
		setKanbanError(null);

		try {
			const response = await fetch(buildApiUrl('/conductor'), {
				credentials: 'include',
				cache: 'no-store',
			});

			if (!response.ok) {
				throw new Error('Failed to load kanban data');
			}

			const data = (await response.json()) as {
				groups?: Group[];
				conductors?: Conductor[];
				tasks?: ConductorTask[];
				runs?: ConductorRun[];
			};

			setConductorGroups(Array.isArray(data.groups) ? data.groups : []);
			setConductorState({
				conductors: Array.isArray(data.conductors) ? data.conductors : [],
				tasks: Array.isArray(data.tasks) ? data.tasks : [],
				runs: Array.isArray(data.runs) ? data.runs : [],
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to load kanban data';
			setKanbanError(message);
		} finally {
			setIsKanbanLoading(false);
		}
	}, []);

	const mutateConductorTask = useCallback(
		async (path: string, options: RequestInit) => {
			const response = await fetch(buildApiUrl(path), {
				credentials: 'include',
				...options,
			});

			if (!response.ok) {
				throw new Error('Kanban update failed');
			}

			const result = (await response.json()) as { success?: boolean };
			if (!result.success) {
				throw new Error('Kanban update failed');
			}

			await loadConductorSnapshot();
		},
		[loadConductorSnapshot]
	);

	const handleCreateConductorTask = useCallback(
		async (input: {
			groupId: string;
			title: string;
			description?: string;
			priority?: ConductorTaskPriority;
			status?: ConductorTaskStatus;
		}) => {
			await mutateConductorTask('/conductor/tasks', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(input),
			});
		},
		[mutateConductorTask]
	);

	const handleUpdateConductorTask = useCallback(
		async (
			taskId: string,
			updates: {
				title?: string;
				description?: string;
				priority?: ConductorTaskPriority;
				status?: ConductorTaskStatus;
			}
		) => {
			await mutateConductorTask(`/conductor/tasks/${encodeURIComponent(taskId)}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(updates),
			});
		},
		[mutateConductorTask]
	);

	const handleDeleteConductorTask = useCallback(
		async (taskId: string) => {
			await mutateConductorTask(`/conductor/tasks/${encodeURIComponent(taskId)}`, {
				method: 'DELETE',
			});
		},
		[mutateConductorTask]
	);

	useEffect(() => {
		if (!kanbanScope) {
			return;
		}

		void loadConductorSnapshot();
		const intervalId = window.setInterval(() => {
			void loadConductorSnapshot();
		}, 15000);

		return () => {
			window.clearInterval(intervalId);
		};
	}, [kanbanScope, loadConductorSnapshot]);

	const attachmentSummaries = useMemo(
		(): WebAttachmentSummary[] =>
			stagedTextAttachments.map((attachment) => ({
				id: attachment.id,
				kind: 'file' as const,
				name: attachment.name,
				mimeType: attachment.mimeType,
				size: attachment.size,
			})),
		[stagedTextAttachments]
	);

	const handleAddAttachments = useCallback(
		(payload: { images?: string[]; textAttachments?: WebTextAttachmentInput[] }) => {
			if (payload.images?.length) {
				setStagedImages((prev) => {
					const seen = new Set(prev);
					const next = [...prev];
					for (const image of payload.images || []) {
						if (seen.has(image)) {
							continue;
						}
						seen.add(image);
						next.push(image);
					}
					return next;
				});
			}

			if (payload.textAttachments?.length) {
				setStagedTextAttachments((prev) => {
					const existingKeys = new Set(
						prev.map((attachment) => `${attachment.name}::${attachment.content}`)
					);
					const next = [...prev];
					for (const attachment of payload.textAttachments || []) {
						const dedupeKey = `${attachment.name}::${attachment.content}`;
						if (existingKeys.has(dedupeKey)) {
							continue;
						}
						existingKeys.add(dedupeKey);
						next.push({
							...attachment,
							id: attachment.id || createAttachmentId(),
						});
					}
					return next;
				});
			}
		},
		[]
	);

	const handleRemoveStagedImage = useCallback((index: number) => {
		setStagedImages((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
	}, []);

	const handleRemoveStagedTextAttachment = useCallback((attachmentId: string) => {
		setStagedTextAttachments((prev) =>
			prev.filter((attachment) => (attachment.id || attachment.name) !== attachmentId)
		);
	}, []);

	// Handle command submission
	const handleCommandSubmit = useCallback(
		(command: string, options?: { disposition?: 'default' | 'queue' }) => {
			if (!activeSessionId) return;
			if (
				command.trim().length === 0 &&
				stagedImages.length === 0 &&
				stagedTextAttachments.length === 0
			) {
				return;
			}

			// Find the active session to get input mode
			const currentMode = (activeSession?.inputMode as InputMode) || 'ai';
			const disposition = options?.disposition ?? 'default';
			const hasAttachments = stagedImages.length > 0 || stagedTextAttachments.length > 0;
			const commandText = command.trim();
			const demoCapture =
				currentMode === 'ai' && demoCaptureRequested ? { enabled: true } : undefined;
			const interactionMetadata =
				currentMode === 'ai'
					? activeSession?.state === 'busy'
						? disposition === 'queue'
							? {
									interactionKind: 'queued' as const,
									deliveryState: 'pending' as const,
									delivered: false,
								}
							: {
									interactionKind: 'steer' as const,
									deliveryState:
										activeTab?.steerMode === 'true-steer'
											? ('pending' as const)
											: ('fallback_interrupt' as const),
									delivered: false,
								}
						: {
								interactionKind: 'turn' as const,
								deliveryState: 'pending' as const,
								delivered: false,
							}
					: undefined;

			// Provide haptic feedback on send
			triggerHaptic(HAPTIC_PATTERNS.send);

			// Add user message to session logs immediately for display
			addUserLogEntry(
				commandText,
				currentMode,
				stagedImages.length > 0 ? stagedImages : undefined,
				attachmentSummaries.length > 0 ? attachmentSummaries : undefined,
				interactionMetadata
			);

			// If offline or not connected, queue the command for later
			if (isOffline || !isActuallyConnected) {
				const queued = queueCommand(
					activeSessionId,
					commandText,
					currentMode,
					stagedImages.length > 0 ? stagedImages : undefined,
					stagedTextAttachments.length > 0 ? stagedTextAttachments : undefined,
					attachmentSummaries.length > 0 ? attachmentSummaries : undefined,
					demoCapture
				);
				if (queued) {
					webLogger.debug(`Command queued for later: ${commandText.substring(0, 50)}`, 'Mobile');
					// Provide different haptic feedback for queued commands
					triggerHaptic(HAPTIC_PATTERNS.tap);
				} else {
					webLogger.warn('Failed to queue command - queue may be full', 'Mobile');
				}
			} else {
				// Send the command to the active session immediately
				// Include inputMode so the server uses the web's intended mode (not stale server state)
				const sendResult = send({
					type: 'send_command',
					sessionId: activeSessionId,
					command: commandText,
					commandAction: disposition,
					inputMode: currentMode,
					images: stagedImages.length > 0 ? stagedImages : undefined,
					textAttachments:
						currentMode === 'ai' && stagedTextAttachments.length > 0
							? stagedTextAttachments
							: undefined,
					attachments:
						currentMode === 'ai' && attachmentSummaries.length > 0
							? attachmentSummaries
							: undefined,
					demoCapture,
				});
				webLogger.info(
					`[Web->Server] Command send result: ${sendResult}, command="${commandText.substring(0, 50)}" mode=${currentMode} session=${activeSessionId} attachments=${hasAttachments}`,
					'Mobile'
				);
			}

			// Clear the input
			setCommandInput('');
			setStagedImages([]);
			setStagedTextAttachments([]);
		},
		[
			activeSessionId,
			activeSession,
			send,
			isOffline,
			isActuallyConnected,
			queueCommand,
			addUserLogEntry,
			attachmentSummaries,
			stagedImages,
			stagedTextAttachments,
			demoCaptureRequested,
		]
	);

	// Handle command input change
	const handleCommandChange = useCallback((value: string) => {
		setCommandInput(value);
	}, []);

	const handleOpenDemo = useCallback(
		(demoId: string) => {
			const resolvedSessionId = activeSessionId || getCurrentSessionId();
			if (!resolvedSessionId) {
				return;
			}
			setActiveDemoId(demoId);
			updateUrlForDemo(resolvedSessionId, demoId);
		},
		[activeSessionId]
	);

	const handleCloseDemo = useCallback(() => {
		setActiveDemoId(null);
		const resolvedSessionId = activeSessionId || getCurrentSessionId();
		if (resolvedSessionId) {
			updateUrlForSessionTab(resolvedSessionId, activeTabId);
			return;
		}

		const dashboardUrl = getDashboardUrl();
		if (window.location.href !== dashboardUrl) {
			window.history.replaceState({}, '', dashboardUrl);
		}
	}, [activeSessionId, activeTabId]);

	const handleMessageTap = useCallback(
		(entry: { metadata?: { demoCard?: { demoId: string } } }) => {
			const demoId = entry.metadata?.demoCard?.demoId;
			if (demoId) {
				handleOpenDemo(demoId);
			}
		},
		[handleOpenDemo]
	);

	// Handle interrupt request
	const handleInterrupt = useCallback(async () => {
		if (!activeSessionId) return;

		// Provide haptic feedback
		triggerHaptic(HAPTIC_PATTERNS.tap);

		try {
			// Build the API URL with security token in path
			const apiUrl = buildApiUrl(`/session/${activeSessionId}/interrupt`);
			const response = await fetch(apiUrl, {
				method: 'POST',
			});

			const result = await response.json();

			if (response.ok && result.success) {
				webLogger.debug(`Session interrupted: ${activeSessionId}`, 'Mobile');
				triggerHaptic(HAPTIC_PATTERNS.success);
			} else {
				webLogger.error(`Failed to interrupt session: ${result.error}`, 'Mobile');
			}
		} catch (error) {
			webLogger.error('Error interrupting session', 'Mobile', error);
		}
	}, [activeSessionId]);

	// Combined slash commands (default + custom from desktop)
	const allSlashCommands = useMemo((): SlashCommand[] => {
		// Convert custom commands to SlashCommand format
		const customSlashCommands: SlashCommand[] = customCommands.map((cmd) => ({
			command: cmd.command.startsWith('/') ? cmd.command : `/${cmd.command}`,
			description: cmd.description,
			aiOnly: true, // Custom commands are AI-only
		}));
		// Combine defaults with custom commands
		return [...DEFAULT_SLASH_COMMANDS, ...customSlashCommands];
	}, [customCommands]);

	// Collect all responses from sessions for navigation
	const allResponses = useMemo((): ResponseItem[] => {
		return (
			sessions
				.filter((s) => (s as any).lastResponse)
				.map((s) => ({
					response: (s as any).lastResponse as LastResponsePreview,
					sessionId: s.id,
					sessionName: s.name,
				}))
				// Sort by timestamp (most recent first)
				.sort((a, b) => b.response.timestamp - a.response.timestamp)
		);
	}, [sessions]);

	// Handle navigating between responses in the viewer
	const handleNavigateResponse = useCallback(
		(index: number) => {
			if (index >= 0 && index < allResponses.length) {
				setResponseIndex(index);
				setSelectedResponse(allResponses[index].response);
				webLogger.debug(`Navigating to response index: ${index}`, 'Mobile');
			}
		},
		[allResponses]
	);

	// Handle closing response viewer
	const handleCloseResponseViewer = useCallback(() => {
		setShowResponseViewer(false);
		// Keep selectedResponse so animation can complete
		setTimeout(() => setSelectedResponse(null), 300);
	}, []);

	// Keyboard shortcuts (Cmd+J mode toggle, Cmd+[/] tab navigation)
	useMobileKeyboardHandler({
		activeSessionId,
		activeSession,
		handleSelectTab,
	});

	// Determine content based on connection state
	const renderContent = () => {
		// Show offline state when device has no network connectivity
		if (isOffline) {
			return (
				<div
					style={{
						marginBottom: '24px',
						padding: '16px',
						borderRadius: '12px',
						backgroundColor: colors.bgSidebar,
						border: `1px solid ${colors.border}`,
						maxWidth: '300px',
					}}
				>
					<h2 style={{ fontSize: '16px', marginBottom: '8px', color: colors.textMain }}>
						You're Offline
					</h2>
					<p style={{ fontSize: '14px', color: colors.textDim, marginBottom: '12px' }}>
						No internet connection. Maestro requires a network connection to communicate with your
						desktop app.
					</p>
					<p style={{ fontSize: '12px', color: colors.textDim }}>
						The app will automatically reconnect when you're back online.
					</p>
				</div>
			);
		}

		if (isBootstrappingConnection) {
			return (
				<div
					style={{
						width: '100%',
						display: 'flex',
						flexDirection: 'column',
						flex: 1,
						minHeight: 0,
						overflow: 'hidden',
					}}
				>
					<div
						style={{
							padding: '14px 16px 10px',
							display: 'flex',
							flexDirection: 'column',
							gap: '10px',
							background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
						}}
					>
						<div
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								gap: '8px',
								alignSelf: 'flex-start',
								padding: '8px 12px',
								borderRadius: '999px',
								backgroundColor: colors.bgSidebar,
								border: `1px solid ${colors.border}`,
								color: colors.textDim,
								fontSize: '13px',
							}}
						>
							<span
								style={{
									width: '8px',
									height: '8px',
									borderRadius: '999px',
									backgroundColor: colors.accent,
									opacity: 0.9,
								}}
							/>
							Syncing with Maestro…
						</div>
					</div>
					<div
						style={{
							flex: 1,
							padding: '18px 16px',
							display: 'flex',
							flexDirection: 'column',
							gap: '12px',
						}}
					>
						<div
							style={{
								height: '16px',
								width: '84px',
								borderRadius: '999px',
								backgroundColor: colors.bgSidebar,
								opacity: 0.8,
							}}
						/>
						<div
							style={{
								height: '54px',
								borderRadius: '18px',
								backgroundColor: colors.bgSidebar,
								opacity: 0.55,
							}}
						/>
						<div
							style={{
								height: '14px',
								width: '72%',
								borderRadius: '999px',
								backgroundColor: colors.bgSidebar,
								opacity: 0.45,
							}}
						/>
						<div
							style={{
								height: '14px',
								width: '58%',
								borderRadius: '999px',
								backgroundColor: colors.bgSidebar,
								opacity: 0.38,
							}}
						/>
					</div>
				</div>
			);
		}

		// Connected or authenticated state - show conversation or prompt to select session
		if (!activeSession) {
			return (
				<div
					style={{
						flex: 1,
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						justifyContent: 'center',
						padding: '24px',
						textAlign: 'center',
					}}
				>
					<div
						style={{
							maxWidth: '320px',
							display: 'flex',
							flexDirection: 'column',
							gap: '14px',
							alignItems: 'center',
						}}
					>
						<div
							style={{
								width: '56px',
								height: '56px',
								borderRadius: '18px',
								backgroundColor: colors.bgSidebar,
								border: `1px solid ${colors.border}`,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								color: colors.accent,
							}}
						>
							<svg
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M4 7h16" />
								<path d="M4 12h16" />
								<path d="M4 17h16" />
							</svg>
						</div>
						<div>
							<p
								style={{
									fontSize: '20px',
									fontWeight: 600,
									color: colors.textMain,
									margin: 0,
								}}
							>
								Choose a thread
							</p>
							<p
								style={{
									fontSize: '14px',
									color: colors.textDim,
									margin: '8px 0 0',
								}}
							>
								Open the navigation drawer to switch workspaces, threads, or kanban boards.
							</p>
						</div>
						<button
							type="button"
							onClick={handleToggleNavigationDrawer}
							style={{
								padding: '12px 16px',
								borderRadius: '12px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								color: colors.textMain,
								fontSize: '14px',
								fontWeight: 600,
								cursor: 'pointer',
							}}
						>
							Open Workspaces
						</button>
					</div>
				</div>
			);
		}

		const currentLogs =
			activeSession.inputMode === 'ai' ? sessionLogs.aiLogs : sessionLogs.shellLogs;
		const latestUserLogIndex =
			activeSession.inputMode === 'ai'
				? (() => {
						for (let index = currentLogs.length - 1; index >= 0; index -= 1) {
							if (currentLogs[index]?.source === 'user') {
								return index;
							}
						}
						return -1;
					})()
				: -1;
		const toolLogs =
			activeSession.inputMode === 'ai'
				? currentLogs
						.slice(latestUserLogIndex >= 0 ? latestUserLogIndex + 1 : 0)
						.filter((log) => log.source === 'tool')
				: [];
		const chatLogs =
			activeSession.inputMode === 'ai'
				? currentLogs.filter((log) => log.source !== 'tool')
				: currentLogs;
		const hasThreadNavigation = isAiThread;

		return (
			<div
				style={{
					width: '100%',
					display: 'flex',
					flexDirection: 'column',
					flex: 1,
					minHeight: 0,
					overflow: 'hidden',
				}}
			>
				<div
					style={{
						position: 'relative',
						zIndex: 30,
						overflow: 'visible',
						padding: '6px 12px 8px',
						display: 'flex',
						flexDirection: 'column',
						gap: '6px',
						background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
					}}
				>
					{hasThreadNavigation && (
						<TabBar
							sessionKey={activeSession?.id || null}
							onNewThread={handleNewThread}
							supportsModelSelection={supportsModelSelection}
							modelLabel={activeModelLabel}
							modelToolType={activeSession?.toolType || null}
							loadModels={handleLoadSessionModels}
							onSelectModel={handleSelectSessionModel}
							canChooseProviderModels={canChooseProviderModels}
							loadProviderModels={handleLoadProviderModels}
							onSelectProviderModel={handleSelectProviderModel}
							contextUsagePercentage={contextUsagePercentage}
							contextUsageColor={contextUsageColor}
						/>
					)}

					{activeSessionId && autoRunStates[activeSessionId] && (
						<AutoRunIndicator
							state={autoRunStates[activeSessionId]}
							sessionName={activeSession?.name}
						/>
					)}

					{offlineQueueLength > 0 && (
						<OfflineQueueBanner
							queue={offlineQueue}
							status={offlineQueueStatus}
							onClearQueue={clearOfflineQueue}
							onProcessQueue={processOfflineQueue}
							onRemoveCommand={removeQueuedCommand}
							isOffline={isOffline}
							isConnected={isActuallyConnected}
						/>
					)}
					{isSyncingLogs && currentLogs.length > 0 && (
						<div
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								gap: '8px',
								alignSelf: 'flex-start',
								padding: '7px 10px',
								borderRadius: '999px',
								border: `1px solid ${colors.border}`,
								background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
								color: colors.textDim,
								fontSize: '12px',
								fontWeight: 600,
							}}
						>
							<span
								style={{
									width: '8px',
									height: '8px',
									borderRadius: '999px',
									backgroundColor: colors.accent,
									animation: 'maestro-mobile-sync-pulse 1.2s ease-in-out infinite',
								}}
							/>
							Syncing latest output
						</div>
					)}
				</div>

				{isLoadingLogs ? (
					<div
						style={{
							padding: '24px 16px',
							textAlign: 'center',
							color: colors.textDim,
							fontSize: '13px',
						}}
					>
						Loading conversation...
					</div>
				) : chatLogs.length === 0 ? (
					<div
						style={{
							flex: 1,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '24px',
							textAlign: 'center',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						{activeSession.inputMode === 'ai'
							? 'Ask your AI assistant anything'
							: 'Run shell commands'}
					</div>
				) : (
					<div
						style={{
							position: 'relative',
							zIndex: 0,
							minHeight: 0,
							flex: 1,
							display: 'flex',
							flexDirection: 'column',
							overflow: 'hidden',
						}}
					>
						<MessageHistory
							logs={chatLogs}
							sessionId={activeSessionId}
							inputMode={activeSession.inputMode as 'ai' | 'terminal'}
							toolLogs={toolLogs}
							isSessionBusy={activeSession.state === 'busy'}
							autoScroll={true}
							maxHeight="none"
							onMessageTap={handleMessageTap}
							jumpToMessageKey={pendingTurnJumpKey}
							onJumpHandled={() => setPendingTurnJumpKey(null)}
							onVisibleUserTurnChange={(messageKey) => {
								if (!messageKey) {
									return;
								}
								setActiveTurnMarkerKey(messageKey);
							}}
						/>
					</div>
				)}
			</div>
		);
	};

	// CSS variable for dynamic viewport height with fallback
	// The fixed CommandInputBar requires padding at the bottom of the container
	const containerStyle: React.CSSProperties = {
		display: 'flex',
		flexDirection: 'column',
		height: '100dvh',
		maxHeight: '100dvh',
		overflow: 'hidden',
		backgroundColor: colors.bgMain,
		color: colors.textMain,
	};
	const composerReserveHeight =
		composerHeight > 0 ? Math.max(68, Math.round(composerHeight * 0.53)) : null;
	const searchableSessions = useMemo(
		() => sessions.filter((session) => (session.aiTabs?.length || 0) > 0),
		[sessions]
	);
	const canOpenTabSearch = searchableSessions.length > 0;

	return (
		<div style={containerStyle}>
			<MobileHeader
				activeSession={activeSession}
				drawerOpen={showNavigationDrawer}
				onToggleDrawer={handleToggleNavigationDrawer}
				canOpenTabSearch={!!canOpenTabSearch}
				onOpenTabSearch={handleOpenTabSearch}
				providerUsageSnapshot={providerUsageSnapshot}
			/>

			<MobileNavigationDrawer
				isOpen={showNavigationDrawer}
				sessions={sessions}
				activeSessionId={activeSessionId}
				onClose={handleCloseNavigationDrawer}
				onOpenControls={handleOpenAppControlsSheet}
				onSelectSession={handleSelectSessionFromDrawer}
				onNewThreadInWorkspace={(sessionId) => {
					handleCloseNavigationDrawer();
					send({
						type: 'new_thread',
						sessionId,
					});
				}}
				onDeleteSession={handleDeleteSession}
				onOpenTabSearch={handleOpenTabSearch}
				canOpenTabSearch={!!canOpenTabSearch}
				onOpenKanbanHome={handleOpenKanbanHome}
				onOpenWorkspaceKanban={handleOpenWorkspaceKanban}
			/>

			{!isOffline && !isBootstrappingConnection && (
				<ConnectionStatusIndicator
					connectionState={connectionState}
					isOffline={isOffline}
					reconnectAttempts={reconnectAttempts}
					error={error}
					onRetry={connect}
					style={{
						margin: '8px 12px 0',
						alignSelf: 'stretch',
						position: 'relative',
						top: 'auto',
						left: 'auto',
						right: 'auto',
					}}
				/>
			)}

			<MobileKanbanPanel
				isOpen={kanbanScope !== null}
				scope={kanbanScope}
				groups={conductorGroups}
				conductors={conductorState.conductors}
				tasks={conductorState.tasks}
				runs={conductorState.runs}
				isLoading={isKanbanLoading}
				error={kanbanError}
				onClose={handleCloseKanbanPanel}
				onRefresh={loadConductorSnapshot}
				onOpenHome={() => setKanbanScope({ type: 'home' })}
				onOpenWorkspace={(groupId) => setKanbanScope({ type: 'workspace', groupId })}
				onCreateTask={handleCreateConductorTask}
				onUpdateTask={handleUpdateConductorTask}
				onDeleteTask={handleDeleteConductorTask}
			/>

			{showAppControlsSheet && (
				<div
					style={{
						position: 'fixed',
						inset: 0,
						zIndex: 170,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: '20px 16px',
					}}
				>
					<button
						type="button"
						onClick={handleCloseAppControlsSheet}
						aria-label="Close app controls"
						style={{
							position: 'absolute',
							inset: 0,
							border: 'none',
							background: 'rgba(2, 8, 23, 0.48)',
							padding: 0,
							cursor: 'pointer',
						}}
					/>
					<div
						style={{
							position: 'relative',
							width: 'min(100%, 368px)',
							maxHeight: 'min(68dvh, 520px)',
							padding: '14px 14px 16px',
							borderRadius: '24px',
							border: `1px solid ${colors.border}`,
							background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
							backdropFilter: 'blur(30px) saturate(140%)',
							WebkitBackdropFilter: 'blur(30px) saturate(140%)',
							boxShadow:
								'0 28px 64px rgba(2, 8, 23, 0.26), 0 12px 28px rgba(2, 8, 23, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.32)',
							overflowY: 'auto',
						}}
					>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: '10px',
								marginBottom: '10px',
								padding: 0,
							}}
						>
							<div>
								<div
									style={{
										fontSize: '15px',
										fontWeight: 650,
										color: colors.textMain,
										lineHeight: 1.15,
									}}
								>
									App Controls
								</div>
							</div>
							<button
								type="button"
								onClick={handleCloseAppControlsSheet}
								aria-label="Close app controls"
								style={{
									width: '30px',
									height: '30px',
									borderRadius: '10px',
									border: `1px solid ${colors.border}`,
									background: colors.bgActivity,
									color: colors.textMain,
									display: 'inline-flex',
									alignItems: 'center',
									justifyContent: 'center',
									cursor: 'pointer',
									flexShrink: 0,
								}}
							>
								×
							</button>
						</div>
						<AppControlsPanel
							notificationPermission={notificationPermission}
							canInstall={canInstall}
							isInstalled={isInstalled}
							isPushSupported={isPushSupported}
							isPushConfigured={isPushConfigured}
							isPushSubscribed={isPushSubscribed}
							isPushLoading={isPushLoading}
							pushError={pushError}
							appearancePreference={appearancePreference}
							onInstall={handleInstallApp}
							onEnableNotifications={handleEnableNotifications}
							onEnablePush={handleEnablePush}
							onDisablePush={handleDisablePush}
							onSendTestNotification={handleSendTestNotification}
							onAppearancePreferenceChange={handleAppearancePreferenceChange}
							embedded={true}
							hideHeader={true}
						/>
					</div>
				</div>
			)}

			{/* History panel - full-screen modal with history entries */}
			{showHistoryPanel && (
				<Suspense fallback={null}>
					<MobileHistoryPanel
						onClose={handleCloseHistoryPanel}
						projectPath={activeSession?.cwd}
						sessionId={activeSessionId || undefined}
						initialFilter={historyFilter}
						initialSearchQuery={historySearchQuery}
						initialSearchOpen={historySearchOpen}
						onFilterChange={setHistoryFilter}
						onSearchChange={(query, isOpen) => {
							setHistorySearchQuery(query);
							setHistorySearchOpen(isOpen);
						}}
					/>
				</Suspense>
			)}

			{/* Tab search modal - full-screen modal for searching tabs */}
			{showTabSearch && searchableSessions.length > 0 && (
				<Suspense fallback={null}>
					<TabSearchModal
						sessions={searchableSessions}
						activeSessionId={activeSessionId}
						activeTabId={activeTabId}
						recentTargets={recentTargets}
						onSelectTarget={handleSelectSessionTab}
						onClose={handleCloseTabSearch}
					/>
				</Suspense>
			)}

			{/* Main content area */}
			<main
				style={{
					flex: 1,
					display: 'flex',
					flexDirection: 'column',
					backgroundColor: colors.bgMain,
					paddingBottom:
						composerReserveHeight !== null
							? `${composerReserveHeight}px`
							: 'calc(96px + env(safe-area-inset-bottom))',
					overflow: 'hidden',
					minHeight: 0,
				}}
			>
				<div
					style={{
						flex: 1,
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'stretch',
						justifyContent:
							connectionState === 'connected' || connectionState === 'authenticated'
								? 'flex-start'
								: 'center',
						width: '100%',
						minHeight: 0,
						overflow: 'hidden',
					}}
				>
					{renderContent()}
				</div>
			</main>

			{/* Sticky bottom command input bar */}
			<CommandInputBar
				isOffline={isOffline}
				isConnected={connectionState === 'connected' || connectionState === 'authenticated'}
				value={commandInput}
				onChange={handleCommandChange}
				onSubmit={handleCommandSubmit}
				stagedImages={stagedImages}
				stagedTextAttachments={stagedTextAttachments}
				onAddAttachments={handleAddAttachments}
				onRemoveImage={handleRemoveStagedImage}
				onRemoveTextAttachment={handleRemoveStagedTextAttachment}
				demoCaptureEnabled={demoCaptureRequested}
				onToggleDemoCapture={() => setDemoCaptureRequested((prev) => !prev)}
				placeholder={
					!activeSessionId ? 'Select a session first...' : isSmallScreen ? 'Message' : 'Message'
				}
				disabled={!activeSessionId}
				inputMode={(activeSession?.inputMode as InputMode) || 'ai'}
				isSessionBusy={activeSession?.state === 'busy'}
				onInterrupt={handleInterrupt}
				busyPrimaryLabel={activeTab?.steerMode === 'true-steer' ? 'Steer' : 'Steer (Interrupt)'}
				hasActiveSession={!!activeSessionId}
				supportsModelSelection={supportsModelSelection}
				modelLabel={activeModelLabel}
				modelToolType={activeSession?.toolType || null}
				loadModels={handleLoadSessionModels}
				onSelectModel={handleSelectSessionModel}
				slashCommands={allSlashCommands}
				showRecentCommands={false}
				onHeightChange={setComposerHeight}
			/>

			{/* Full-screen response viewer modal */}
			{(showResponseViewer || selectedResponse) && (
				<Suspense fallback={null}>
					<ResponseViewer
						isOpen={showResponseViewer}
						response={selectedResponse}
						allResponses={allResponses.length > 1 ? allResponses : undefined}
						currentIndex={responseIndex}
						onNavigate={handleNavigateResponse}
						onClose={handleCloseResponseViewer}
						sessionName={activeSession?.name}
					/>
				</Suspense>
			)}

			{activeDemoId && (
				<Suspense fallback={null}>
					<MobileDemoViewer demoId={activeDemoId} onClose={handleCloseDemo} />
				</Suspense>
			)}

			<style>{`
				@keyframes maestro-mobile-sync-pulse {
					0%, 100% { opacity: 0.45; transform: scale(0.9); }
					50% { opacity: 1; transform: scale(1); }
				}
			`}</style>
		</div>
	);
}
