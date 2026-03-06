/**
 * CommandInputButtons - Extracted button components for CommandInputBar
 *
 * These button components are specialized for the mobile input bar with:
 * - Large touch targets (48px minimum per Apple HIG)
 * - Touch feedback with scale animations
 * - Haptic feedback via Vibration API
 * - Theme-aware styling
 *
 * Components:
 * - InputModeToggleButton: Switches between AI and Terminal modes
 * - VoiceInputButton: Microphone button for recording/transcription
 * - SlashCommandButton: Opens slash command autocomplete
 * - SendInterruptButton: Send message or cancel running AI query
 */

import React from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type { InputMode } from './CommandInputBar';
import { triggerHaptic, MIN_TOUCH_TARGET } from './constants';

/** Default minimum height for the buttons */
const MIN_INPUT_HEIGHT = 48;

/**
 * Common base styles for all input bar buttons
 */
const buttonBaseStyles: React.CSSProperties = {
	padding: '10px',
	borderRadius: '16px',
	cursor: 'pointer',
	width: `${MIN_TOUCH_TARGET + 4}px`,
	height: `${MIN_INPUT_HEIGHT}px`,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	transition: 'all 150ms ease',
	flexShrink: 0,
	WebkitTapHighlightColor: 'transparent',
	border: 'none',
	boxShadow: '0 8px 18px rgba(15, 23, 42, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
};

// ============================================================================
// InputModeToggleButton
// ============================================================================

export interface InputModeToggleButtonProps {
	/** Current input mode (AI or terminal) */
	inputMode: InputMode;
	/** Callback when mode is toggled */
	onModeToggle: () => void;
	/** Whether the button is disabled */
	disabled: boolean;
}

/**
 * InputModeToggleButton - Switches between AI and Terminal modes
 *
 * Displays an AI sparkle icon in AI mode, or a terminal prompt icon in terminal mode.
 * Shows mode label below the icon.
 */
export function InputModeToggleButton({
	inputMode,
	onModeToggle,
	disabled,
}: InputModeToggleButtonProps) {
	const colors = useThemeColors();
	const isAiMode = inputMode === 'ai';

	const handleClick = () => {
		triggerHaptic(10);
		onModeToggle();
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={disabled}
			style={{
				...buttonBaseStyles,
				backgroundColor: isAiMode ? `${colors.accent}20` : `${colors.textDim}20`,
				border: `2px solid ${isAiMode ? colors.accent : colors.textDim}`,
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.5 : 1,
				flexDirection: 'column',
				gap: '2px',
			}}
			onTouchStart={(e) => {
				if (!disabled) {
					e.currentTarget.style.transform = 'scale(0.95)';
				}
			}}
			onTouchEnd={(e) => {
				e.currentTarget.style.transform = 'scale(1)';
			}}
			aria-label={`Switch to ${isAiMode ? 'terminal' : 'AI'} mode. Currently in ${isAiMode ? 'AI' : 'terminal'} mode.`}
			aria-pressed={isAiMode}
		>
			{/* Mode icon - AI sparkle or Terminal prompt */}
			{isAiMode ? (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke={colors.accent}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M12 3v2M12 19v2M5.64 5.64l1.42 1.42M16.95 16.95l1.41 1.41M3 12h2M19 12h2M5.64 18.36l1.42-1.42M16.95 7.05l1.41-1.41" />
					<circle cx="12" cy="12" r="4" />
				</svg>
			) : (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke={colors.textDim}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="4 17 10 11 4 5" />
					<line x1="12" y1="19" x2="20" y2="19" />
				</svg>
			)}
			{/* Mode label */}
			<span
				style={{
					fontSize: '9px',
					fontWeight: 600,
					color: isAiMode ? colors.accent : colors.textDim,
					textTransform: 'uppercase',
					letterSpacing: '0.5px',
				}}
			>
				{isAiMode ? 'AI' : 'CLI'}
			</span>
		</button>
	);
}

// ============================================================================
// VoiceInputButton
// ============================================================================

export interface VoiceInputButtonProps {
	/** Whether currently listening for voice input */
	isListening: boolean;
	/** Whether microphone permission/request is pending */
	isRequesting?: boolean;
	/** Whether audio is currently being transcribed */
	isTranscribing?: boolean;
	/** Current voice state label */
	statusText?: string | null;
	/** Callback to toggle voice input */
	onToggle: () => void;
	/** Whether the button is disabled */
	disabled: boolean;
}

/**
 * VoiceInputButton - Microphone button for recording/transcription
 *
 * Shows a microphone icon that pulses red when actively recording and a
 * spinner while microphone access or transcription is in progress.
 */
export function VoiceInputButton({
	isListening,
	isRequesting = false,
	isTranscribing = false,
	statusText,
	onToggle,
	disabled,
}: VoiceInputButtonProps) {
	const colors = useThemeColors();
	const isActive = isListening || isRequesting || isTranscribing;
	const showSpinner = isRequesting || isTranscribing;

	return (
		<button
			type="button"
			onClick={onToggle}
			disabled={disabled}
			style={{
				...buttonBaseStyles,
				backgroundColor: isListening
					? '#ef444426'
					: isRequesting
						? `${colors.accent}14`
						: isTranscribing
							? `${colors.accent}1c`
							: `${colors.bgMain}c8`,
				border: `1px solid ${
					isListening
						? '#ef444488'
						: isRequesting || isTranscribing
							? `${colors.accent}66`
							: colors.border
				}`,
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.5 : 1,
				animation: isListening ? 'pulse 1.5s ease-in-out infinite' : 'none',
			}}
			onTouchStart={(e) => {
				if (!disabled) {
					e.currentTarget.style.transform = 'scale(0.95)';
				}
			}}
			onTouchEnd={(e) => {
				e.currentTarget.style.transform = 'scale(1)';
			}}
			aria-label={
				isListening
					? 'Stop voice recording'
					: isRequesting
						? 'Waiting for microphone permission'
						: isTranscribing
							? 'Voice transcription in progress'
							: 'Start voice recording'
			}
			aria-pressed={isActive}
			title={statusText || undefined}
		>
			{showSpinner ? (
				<span
					style={{
						width: '18px',
						height: '18px',
						borderRadius: '999px',
						border: `2px solid ${isRequesting || isTranscribing ? `${colors.accent}33` : `${colors.textDim}33`}`,
						borderTopColor: colors.accent,
						animation: 'spin 0.8s linear infinite',
					}}
				/>
			) : (
				<svg
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill={isListening ? '#ef4444' : 'none'}
					stroke={isListening ? '#ef4444' : colors.textDim}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
					<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
					<line x1="12" x2="12" y1="19" y2="22" />
				</svg>
			)}
		</button>
	);
}

export interface ModelSelectorButtonProps {
	label: string;
	toolType?: string | null;
	onClick: () => void;
	disabled: boolean;
	isOpen: boolean;
}

function hasSupportedProviderIcon(toolType?: string | null): boolean {
	return (
		toolType === 'codex' ||
		toolType === 'claude-code' ||
		toolType === 'opencode' ||
		toolType === 'factory-droid' ||
		toolType === 'terminal'
	);
}

function ProviderModelIcon({ toolType, color }: { toolType?: string | null; color: string }) {
	switch (toolType) {
		case 'codex':
			return (
				<svg width="16" height="16" viewBox="0 0 24 24" fill={color} aria-hidden="true">
					<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
				</svg>
			);
		case 'claude-code':
			return (
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="1.9"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M6 18 11.2 6h1.6L18 18" />
					<path d="M8.6 13h6.8" />
				</svg>
			);
		case 'opencode':
			return (
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="1.9"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="m8.5 7-4 5 4 5" />
					<path d="m15.5 7 4 5-4 5" />
					<path d="m13.5 5-3 14" />
				</svg>
			);
		case 'factory-droid':
			return (
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M4.5 19.5V11h6l2-3.5h7v12Z" />
					<path d="M9 11V7.5h2.2" />
					<circle cx="9" cy="19" r="1.5" fill={color} stroke="none" />
					<circle cx="17" cy="19" r="1.5" fill={color} stroke="none" />
				</svg>
			);
		case 'terminal':
			return (
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="1.9"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<rect x="3.5" y="5" width="17" height="14" rx="2.5" />
					<path d="m8 10 2.5 2L8 14" />
					<path d="M13 15h3.5" />
				</svg>
			);
		default:
			return null;
	}
}

export function ModelSelectorButton({
	label,
	toolType,
	onClick,
	disabled,
	isOpen,
}: ModelSelectorButtonProps) {
	const colors = useThemeColors();
	const iconColor = isOpen ? colors.accent : colors.textMain;
	const showProviderIcon = hasSupportedProviderIcon(toolType);

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			style={{
				...buttonBaseStyles,
				width: 'auto',
				minWidth: '70px',
				maxWidth: '120px',
				padding: '0 12px',
				gap: '6px',
				backgroundColor: isOpen ? `${colors.accent}20` : `${colors.bgMain}c8`,
				border: `1px solid ${isOpen ? `${colors.accent}66` : colors.border}`,
				color: isOpen ? colors.accent : colors.textMain,
				opacity: disabled ? 0.5 : 1,
			}}
			onTouchStart={(e) => {
				if (!disabled) {
					e.currentTarget.style.transform = 'scale(0.97)';
				}
			}}
			onTouchEnd={(e) => {
				e.currentTarget.style.transform = 'scale(1)';
			}}
			aria-label={`Choose model. Current model: ${label}`}
			aria-expanded={isOpen}
		>
			{showProviderIcon ? (
				<span
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '16px',
						height: '16px',
						flexShrink: 0,
					}}
				>
					<ProviderModelIcon toolType={toolType} color={iconColor} />
				</span>
			) : null}
			<span
				style={{
					fontSize: '12px',
					fontWeight: 600,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
				}}
			>
				{label}
			</span>
		</button>
	);
}

// ============================================================================
// SlashCommandButton
// ============================================================================

export interface SlashCommandButtonProps {
	/** Whether the slash command autocomplete is open */
	isOpen: boolean;
	/** Callback to open the autocomplete */
	onOpen: () => void;
	/** Whether the button is disabled */
	disabled: boolean;
}

/**
 * SlashCommandButton - Opens slash command autocomplete
 *
 * Shows a "/" character that becomes accented when the autocomplete is open.
 * Only visible in AI mode.
 */
export function SlashCommandButton({ isOpen, onOpen, disabled }: SlashCommandButtonProps) {
	const colors = useThemeColors();

	return (
		<button
			type="button"
			onClick={onOpen}
			disabled={disabled}
			style={{
				...buttonBaseStyles,
				backgroundColor: isOpen ? `${colors.accent}20` : `${colors.textDim}15`,
				border: `2px solid ${isOpen ? colors.accent : colors.border}`,
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.5 : 1,
			}}
			onTouchStart={(e) => {
				if (!disabled) {
					e.currentTarget.style.transform = 'scale(0.95)';
				}
			}}
			onTouchEnd={(e) => {
				e.currentTarget.style.transform = 'scale(1)';
			}}
			aria-label="Open slash commands"
		>
			{/* Slash icon */}
			<span
				style={{
					fontSize: '20px',
					fontWeight: 600,
					color: isOpen ? colors.accent : colors.textDim,
					fontFamily: 'ui-monospace, monospace',
				}}
			>
				/
			</span>
		</button>
	);
}

// ============================================================================
// SendInterruptButton
// ============================================================================

export interface SendInterruptButtonProps {
	/** Whether to show the interrupt (cancel) button instead of send */
	isInterruptMode: boolean;
	/** Whether the send button is disabled */
	isSendDisabled: boolean;
	/** Callback when interrupt button is clicked */
	onInterrupt: () => void;
	/** Ref for the send button (used by long-press menu) */
	sendButtonRef?: React.RefObject<HTMLButtonElement>;
	/** Touch start handler for long-press detection */
	onTouchStart?: React.TouchEventHandler<HTMLButtonElement>;
	/** Touch end handler for long-press detection */
	onTouchEnd?: React.TouchEventHandler<HTMLButtonElement>;
	/** Touch move handler for long-press cancellation */
	onTouchMove?: React.TouchEventHandler<HTMLButtonElement>;
}

/**
 * SendInterruptButton - Send message or cancel running AI query
 *
 * Shows an up-arrow send button normally, or a red X when AI is busy.
 * The send button supports long-press for quick actions menu.
 */
export function SendInterruptButton({
	isInterruptMode,
	isSendDisabled,
	onInterrupt,
	sendButtonRef,
	onTouchStart,
	onTouchEnd,
	onTouchMove,
}: SendInterruptButtonProps) {
	const colors = useThemeColors();

	const handleInterrupt = () => {
		triggerHaptic(50);
		onInterrupt();
	};

	if (isInterruptMode) {
		return (
			<button
				type="button"
				onClick={handleInterrupt}
				style={{
					...buttonBaseStyles,
					padding: '14px',
					background: 'linear-gradient(180deg, #f87171 0%, #ef4444 100%)',
					color: '#ffffff',
					fontSize: '14px',
					fontWeight: 500,
				}}
				onTouchStart={(e) => {
					e.currentTarget.style.transform = 'scale(0.95)';
					e.currentTarget.style.backgroundColor = '#dc2626';
				}}
				onTouchEnd={(e) => {
					e.currentTarget.style.transform = 'scale(1)';
					e.currentTarget.style.backgroundColor = '#ef4444';
				}}
				aria-label="Cancel running command or AI query"
			>
				{/* X icon for interrupt */}
				<svg
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			</button>
		);
	}

	return (
		<button
			ref={sendButtonRef}
			type="submit"
			disabled={isSendDisabled}
			style={{
				...buttonBaseStyles,
				padding: '14px',
				background: `linear-gradient(180deg, ${colors.accent} 0%, ${colors.accent}dd 100%)`,
				color: '#ffffff',
				fontSize: '14px',
				fontWeight: 500,
				cursor: isSendDisabled ? 'default' : 'pointer',
				opacity: isSendDisabled ? 0.5 : 1,
			}}
			onTouchStart={(e) => {
				e.currentTarget.style.transform = 'scale(0.96)';
				onTouchStart?.(e);
			}}
			onTouchEnd={(e) => {
				e.currentTarget.style.transform = 'scale(1)';
				onTouchEnd?.(e);
			}}
			onTouchMove={onTouchMove}
			aria-label="Send command (long press for quick actions)"
		>
			{/* Arrow up icon for send */}
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
				<line x1="12" y1="19" x2="12" y2="5" />
				<polyline points="5 12 12 5 19 12" />
			</svg>
		</button>
	);
}

// ============================================================================
// ExpandedModeSendInterruptButton (for mobile expanded AI mode)
// ============================================================================

export interface ExpandedModeSendInterruptButtonProps {
	/** Whether to show the interrupt (cancel) button instead of send */
	isInterruptMode: boolean;
	/** Whether the send button is disabled */
	isSendDisabled: boolean;
	/** Callback when interrupt button is clicked */
	onInterrupt: () => void;
}

/**
 * ExpandedModeSendInterruptButton - Full-width button for mobile expanded mode
 *
 * Similar to SendInterruptButton but renders as a full-width button with text
 * labels ("Stop" or "Send") for the expanded mobile input mode.
 */
export function ExpandedModeSendInterruptButton({
	isInterruptMode,
	isSendDisabled,
	onInterrupt,
}: ExpandedModeSendInterruptButtonProps) {
	const colors = useThemeColors();

	const handleInterrupt = () => {
		triggerHaptic(50);
		onInterrupt();
	};

	const baseExpandedStyles: React.CSSProperties = {
		width: '100%',
		padding: '12px',
		borderRadius: '18px',
		fontSize: '15px',
		fontWeight: 600,
		border: 'none',
		cursor: 'pointer',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '8px',
		transition: 'opacity 150ms ease, background-color 150ms ease',
		WebkitTapHighlightColor: 'transparent',
		boxShadow: '0 10px 24px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
	};

	if (isInterruptMode) {
		return (
			<button
				type="button"
				onClick={handleInterrupt}
				style={{
					...baseExpandedStyles,
					background: 'linear-gradient(180deg, #f87171 0%, #ef4444 100%)',
					color: '#ffffff',
				}}
				onTouchStart={(e) => {
					e.currentTarget.style.backgroundColor = '#dc2626';
				}}
				onTouchEnd={(e) => {
					e.currentTarget.style.backgroundColor = '#ef4444';
				}}
				aria-label="Cancel running AI query"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
				<span>Stop</span>
			</button>
		);
	}

	return (
		<button
			type="submit"
			disabled={isSendDisabled}
			style={{
				...baseExpandedStyles,
				background: `linear-gradient(180deg, ${colors.accent} 0%, ${colors.accent}dd 100%)`,
				color: '#ffffff',
				cursor: isSendDisabled ? 'default' : 'pointer',
				opacity: isSendDisabled ? 0.5 : 1,
			}}
			aria-label="Send message"
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
				<line x1="12" y1="19" x2="12" y2="5" />
				<polyline points="5 12 12 5 19 12" />
			</svg>
			<span>Send</span>
		</button>
	);
}
