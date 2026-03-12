/**
 * ConnectionStatusIndicator component for Maestro mobile web
 *
 * Compact connection indicator that stays out of the way while still making
 * reconnect state visible.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { type WebSocketState } from '../hooks/useWebSocket';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

export interface ConnectionStatusIndicatorProps {
	connectionState: WebSocketState;
	isOffline: boolean;
	reconnectAttempts: number;
	maxReconnectAttempts?: number;
	error?: string | null;
	onRetry: () => void;
	style?: React.CSSProperties;
}

interface StatusConfig {
	message: string;
	subMessage?: string;
	showRetry: boolean;
	borderColor: string;
	bgColor: string;
	pulse: boolean;
}

const RetryIcon = () => (
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
		<polyline points="23 4 23 10 17 10" />
		<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
	</svg>
);

const CloseIcon = () => (
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
		<line x1="18" y1="6" x2="6" y2="18" />
		<line x1="6" y1="6" x2="18" y2="18" />
	</svg>
);

export function ConnectionStatusIndicator({
	connectionState,
	isOffline,
	reconnectAttempts,
	maxReconnectAttempts = 10,
	error,
	onRetry,
	style,
}: ConnectionStatusIndicatorProps) {
	const colors = useThemeColors();
	const [isDismissed, setIsDismissed] = useState(false);
	const [showDetails, setShowDetails] = useState(false);

	useEffect(() => {
		if (connectionState === 'disconnected' && !isOffline) {
			setIsDismissed(false);
		}
	}, [connectionState, isOffline]);

	const handleRetry = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onRetry();
	}, [onRetry]);

	const handleDismiss = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsDismissed(true);
	}, []);

	const handleToggleDetails = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setShowDetails((previous) => !previous);
	}, []);

	const isConnected = connectionState === 'connected' || connectionState === 'authenticated';
	if (
		isConnected ||
		(isDismissed && connectionState !== 'connecting' && connectionState !== 'authenticating')
	) {
		return null;
	}

	const getStatusConfig = (): StatusConfig => {
		if (isOffline) {
			return {
				message: 'Offline',
				subMessage: 'Will reconnect automatically when online',
				showRetry: false,
				borderColor: colors.error,
				bgColor: `${colors.error}14`,
				pulse: false,
			};
		}

		if (connectionState === 'connecting' || connectionState === 'authenticating') {
			return {
				message: connectionState === 'connecting' ? 'Connecting' : 'Authenticating',
				subMessage:
					reconnectAttempts > 0
						? `Attempt ${reconnectAttempts} of ${maxReconnectAttempts}`
						: 'Establishing connection',
				showRetry: reconnectAttempts > 2,
				borderColor: '#f97316',
				bgColor: 'rgba(249, 115, 22, 0.12)',
				pulse: true,
			};
		}

		if (connectionState === 'disconnected') {
			const isMaxAttemptsReached = reconnectAttempts >= maxReconnectAttempts;
			return {
				message: isMaxAttemptsReached ? 'Connection failed' : 'Disconnected',
				subMessage:
					error ||
					(isMaxAttemptsReached
						? `Failed after ${maxReconnectAttempts} attempts`
						: 'Tap retry to reconnect'),
				showRetry: true,
				borderColor: colors.error,
				bgColor: `${colors.error}14`,
				pulse: false,
			};
		}

		return {
			message: 'Connecting',
			subMessage: undefined,
			showRetry: false,
			borderColor: colors.warning,
			bgColor: `${colors.warning}14`,
			pulse: true,
		};
	};

	const statusConfig = getStatusConfig();

	return (
		<div
			role="status"
			aria-live="polite"
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: '8px',
				alignSelf: 'flex-start',
				maxWidth: 'min(calc(100vw - 24px), 320px)',
				padding: '8px 10px',
				borderRadius: '999px',
				border: `1px solid ${statusConfig.borderColor}`,
				background: statusConfig.bgColor,
				boxShadow: '0 8px 18px rgba(15, 23, 42, 0.10)',
				...style,
			}}
		>
			<span
				aria-hidden="true"
				style={{
					width: '8px',
					height: '8px',
					borderRadius: '999px',
					backgroundColor: statusConfig.borderColor,
					boxShadow: statusConfig.pulse
						? `0 0 0 0 ${statusConfig.borderColor}44`
						: `0 0 0 3px ${statusConfig.borderColor}14`,
					flexShrink: 0,
					animation: statusConfig.pulse
						? 'maestro-connection-indicator-pulse 1.4s ease-in-out infinite'
						: undefined,
				}}
			/>

			<button
				type="button"
				onClick={(error || statusConfig.subMessage) ? handleToggleDetails : undefined}
				disabled={!error && !statusConfig.subMessage}
				aria-expanded={showDetails}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '6px',
					minWidth: 0,
					border: 'none',
					background: 'transparent',
					padding: 0,
					cursor: error || statusConfig.subMessage ? 'pointer' : 'default',
					color: colors.textMain,
				}}
			>
				<span
					style={{
						fontSize: '12px',
						fontWeight: 600,
						whiteSpace: 'nowrap',
					}}
				>
					{statusConfig.message}
				</span>
				{showDetails && statusConfig.subMessage && (
					<span
						style={{
							fontSize: '11px',
							color: colors.textDim,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
					>
						{statusConfig.subMessage}
					</span>
				)}
			</button>

			{statusConfig.showRetry && (
				<button
					type="button"
					onClick={handleRetry}
					aria-label="Retry connection"
					title="Retry connection"
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '26px',
						height: '26px',
						borderRadius: '999px',
						border: 'none',
						backgroundColor: colors.accent,
						color: '#ffffff',
						cursor: 'pointer',
						flexShrink: 0,
					}}
				>
					<RetryIcon />
				</button>
			)}

			{connectionState === 'disconnected' && !isOffline && (
				<button
					type="button"
					onClick={handleDismiss}
					aria-label="Dismiss connection indicator"
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '26px',
						height: '26px',
						borderRadius: '999px',
						border: 'none',
						background: 'transparent',
						color: colors.textDim,
						cursor: 'pointer',
						flexShrink: 0,
					}}
				>
					<CloseIcon />
				</button>
			)}

			<style>
				{`
					@keyframes maestro-connection-indicator-pulse {
						0%, 100% {
							transform: scale(1);
							box-shadow: 0 0 0 0 ${statusConfig.borderColor}44;
						}
						50% {
							transform: scale(1.12);
							box-shadow: 0 0 0 6px transparent;
						}
					}
				`}
			</style>
		</div>
	);
}

export default ConnectionStatusIndicator;
