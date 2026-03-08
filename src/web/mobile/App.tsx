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
import type { DemoCaptureRequest } from '../../shared/demo-artifacts';
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
import { useOfflineStatus, useDesktopTheme } from '../main';
import { showLocalServiceWorkerNotification } from '../utils/serviceWorker';
import {
	buildApiUrl,
	getCurrentDemoId,
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
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator';
import { calculateContextDisplay } from '../../renderer/utils/contextUsage';

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

function createAttachmentId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface MobileHeaderProps {
	activeSession?: Session | null;
	drawerOpen: boolean;
	onToggleDrawer: () => void;
	canOpenTabSearch: boolean;
	onOpenTabSearch: () => void;
}

function MobileHeader({
	activeSession,
	drawerOpen,
	onToggleDrawer,
	canOpenTabSearch,
	onOpenTabSearch,
}: MobileHeaderProps) {
	const colors = useThemeColors();
	const activeTab = getActiveTabFromSession(activeSession);
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
	const contextBarColor =
		contextUsagePercentage === null
			? colors.textDim
			: contextUsagePercentage >= 90
				? colors.error
				: contextUsagePercentage >= 70
					? colors.warning
					: colors.success;
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
							{activeSession?.name || 'Select an agent'}
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
								<span>{activeSession.groupName || 'Ungrouped'}</span>
							</span>
						)}
					</div>
					{contextUsagePercentage !== null && activeSession && (
						<div
							title={`Context window ${contextUsagePercentage}% used`}
							aria-label={`Context window ${contextUsagePercentage}% used`}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '6px',
								flexShrink: 0,
								minWidth: '76px',
							}}
						>
							<div
								style={{
									width: '42px',
									height: '7px',
									borderRadius: '999px',
									background: 'rgba(15, 23, 42, 0.14)',
									border: '1px solid rgba(255, 255, 255, 0.10)',
									overflow: 'hidden',
									flexShrink: 0,
									boxShadow: 'inset 0 1px 2px rgba(15, 23, 42, 0.12)',
								}}
							>
								<div
									style={{
										width: `${Math.max(0, Math.min(100, contextUsagePercentage))}%`,
										height: '100%',
										borderRadius: '999px',
										background: contextBarColor,
										boxShadow: `0 0 14px ${contextBarColor}35`,
										transition: 'width 200ms ease-out, background-color 200ms ease-out',
									}}
								/>
							</div>
							<span
								style={{
									fontSize: '10px',
									fontWeight: 600,
									color: colors.textDim,
									flexShrink: 0,
									minWidth: '28px',
									textAlign: 'right',
								}}
							>
								{contextUsagePercentage}%
							</span>
						</div>
					)}
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
	onInstall: () => void;
	onEnableNotifications: () => void;
	onEnablePush: () => void;
	onDisablePush: () => void;
	onSendTestNotification: () => void;
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
	onInstall,
	onEnableNotifications,
	onEnablePush,
	onDisablePush,
	onSendTestNotification,
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
	const { setDesktopTheme } = useDesktopTheme();

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
	const [commandInput, setCommandInput] = useState('');
	const [stagedImages, setStagedImages] = useState<string[]>([]);
	const [stagedTextAttachments, setStagedTextAttachments] = useState<WebTextAttachmentInput[]>([]);
	const [demoCaptureRequested, setDemoCaptureRequested] = useState(false);
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
	}, [refreshPushSubscription]);

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
		handleNewTab,
		handleDeleteSession,
		handleCloseTab,
		handleRenameTab,
		handleStarTab,
		handleReorderTab,
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
	});
	const activeTab = getActiveTabFromSession(activeSession);
	const supportsModelSelection = Boolean(
		activeSession && activeSession.inputMode === 'ai' && activeSession.supportsModelSelection
	);
	const activeModelLabel =
		normalizeModelLabel(activeTab?.currentModel) ||
		normalizeModelLabel(activeSession?.customModel) ||
		normalizeModelLabel(activeSession?.effectiveModelLabel) ||
		'Model';

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
		const handleVisibilityChange = () => {
			if (
				document.visibilityState === 'visible' &&
				!isOffline &&
				connectionState !== 'connected' &&
				connectionState !== 'authenticated'
			) {
				connect();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
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
			setDemoCaptureRequested(false);
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
		sendCommand: (sessionId, command, inputMode, images, textAttachments, attachments, demoCapture) => {
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
		(command: string) => {
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
			const hasAttachments = stagedImages.length > 0 || stagedTextAttachments.length > 0;
			const commandText = command.trim();
			const demoCapture = currentMode === 'ai' && demoCaptureRequested ? { enabled: true } : undefined;

			// Provide haptic feedback on send
			triggerHaptic(HAPTIC_PATTERNS.send);

			// Add user message to session logs immediately for display
			addUserLogEntry(
				commandText,
				currentMode,
				stagedImages.length > 0 ? stagedImages : undefined,
				attachmentSummaries.length > 0 ? attachmentSummaries : undefined
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
			setDemoCaptureRequested(false);
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
			if (!activeSessionId) {
				return;
			}
			setActiveDemoId(demoId);
			updateUrlForDemo(activeSessionId, demoId);
		},
		[activeSessionId]
	);

	const handleCloseDemo = useCallback(() => {
		setActiveDemoId(null);
		if (activeSessionId) {
			updateUrlForSessionTab(activeSessionId, activeTabId);
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
				headers: {
					'Content-Type': 'application/json',
				},
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
								Choose an agent
							</p>
							<p
								style={{
									fontSize: '14px',
									color: colors.textDim,
									margin: '8px 0 0',
								}}
							>
								Open the navigation drawer to switch agents and conversations.
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
							Open Agents
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
		const hasTabBar =
			activeSession.inputMode === 'ai' &&
			!!activeSession.aiTabs &&
			activeSession.aiTabs.length > 0 &&
			!!activeSession.activeTabId;

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
						padding: '6px 12px 8px',
						display: 'flex',
						flexDirection: 'column',
						gap: '6px',
						background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
					}}
				>
					{hasTabBar && (
						<TabBar
							tabs={activeSession.aiTabs!}
							activeTabId={activeSession.activeTabId!}
							onSelectTab={handleSelectTab}
							onNewTab={handleNewTab}
							onCloseTab={handleCloseTab}
							onRenameTab={handleRenameTab}
							onStarTab={handleStarTab}
							onReorderTab={handleReorderTab}
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
					<MessageHistory
						logs={chatLogs}
						inputMode={activeSession.inputMode as 'ai' | 'terminal'}
						toolLogs={toolLogs}
						isSessionBusy={activeSession.state === 'busy'}
						autoScroll={true}
						maxHeight="none"
						onMessageTap={handleMessageTap}
					/>
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
			/>

			<MobileNavigationDrawer
				isOpen={showNavigationDrawer}
				sessions={sessions}
				activeSessionId={activeSessionId}
				onClose={handleCloseNavigationDrawer}
				onOpenControls={handleOpenAppControlsSheet}
				onSelectSession={handleSelectSessionFromDrawer}
				onDeleteSession={handleDeleteSession}
				onOpenTabSearch={handleOpenTabSearch}
				canOpenTabSearch={!!canOpenTabSearch}
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
							border: '1px solid rgba(255, 255, 255, 0.14)',
							background:
								'linear-gradient(180deg, rgba(245, 247, 252, 0.90) 0%, rgba(236, 240, 248, 0.84) 100%)',
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
									border: '1px solid rgba(255, 255, 255, 0.18)',
									background: 'rgba(255, 255, 255, 0.42)',
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
							onInstall={handleInstallApp}
							onEnableNotifications={handleEnableNotifications}
							onEnablePush={handleEnablePush}
							onDisablePush={handleDisablePush}
							onSendTestNotification={handleSendTestNotification}
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
