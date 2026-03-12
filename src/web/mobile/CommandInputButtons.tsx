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
	/** Visual density for the button */
	variant?: 'default' | 'inline';
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
	variant = 'default',
}: VoiceInputButtonProps) {
	const colors = useThemeColors();
	const isActive = isListening || isRequesting || isTranscribing;
	const showSpinner = isRequesting || isTranscribing;
	const isInline = variant === 'inline';

	return (
		<button
			type="button"
			onClick={onToggle}
			disabled={disabled}
			style={{
				...buttonBaseStyles,
				width: isInline ? '34px' : buttonBaseStyles.width,
				height: isInline ? '34px' : buttonBaseStyles.height,
				minWidth: isInline ? '34px' : undefined,
				minHeight: isInline ? '34px' : undefined,
				maxWidth: isInline ? '34px' : undefined,
				maxHeight: isInline ? '34px' : undefined,
				padding: isInline ? '0' : buttonBaseStyles.padding,
				borderRadius: isInline ? '999px' : buttonBaseStyles.borderRadius,
				aspectRatio: isInline ? '1 / 1' : undefined,
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
				boxShadow: isInline
					? '0 6px 14px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.08)'
					: buttonBaseStyles.boxShadow,
				boxSizing: 'border-box',
				appearance: 'none',
				WebkitAppearance: 'none',
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
						width: isInline ? '14px' : '18px',
						height: isInline ? '14px' : '18px',
						borderRadius: '999px',
						border: `2px solid ${isRequesting || isTranscribing ? `${colors.accent}33` : `${colors.textDim}33`}`,
						borderTopColor: colors.accent,
						animation: 'spin 0.8s linear infinite',
					}}
				/>
			) : (
				<svg
					width={isInline ? 15 : 20}
					height={isInline ? 15 : 20}
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
	iconOnly?: boolean;
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

export function ProviderModelIcon({
	toolType,
	color,
	size = 16,
}: {
	toolType?: string | null;
	color: string;
	size?: number;
}) {
	const effectiveColor = toolType === 'claude-code' ? '#D97757' : color;

	switch (toolType) {
		case 'codex':
			return (
				<svg width={size} height={size} viewBox="0 0 24 24" fill={effectiveColor} aria-hidden="true">
					<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
				</svg>
			);
		case 'claude-code':
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 125 125"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M54.375 118.75L56.125 111L58.125 101L59.75 93L61.25 83.125L62.125 79.875L62 79.625L61.375 79.75L53.875 90L42.5 105.375L33.5 114.875L31.375 115.75L27.625 113.875L28 110.375L30.125 107.375L42.5 91.5L50 81.625L54.875 76L54.75 75.25H54.5L21.5 96.75L15.625 97.5L13 95.125L13.375 91.25L14.625 90L24.5 83.125L49.125 69.375L49.5 68.125L49.125 67.5H47.875L43.75 67.25L29.75 66.875L17.625 66.375L5.75 65.75L2.75 65.125L0 61.375L0.25 59.5L2.75 57.875L6.375 58.125L14.25 58.75L26.125 59.5L34.75 60L47.5 61.375H49.5L49.75 60.5L49.125 60L48.625 59.5L36.25 51.25L23 42.5L16 37.375L12.25 34.75L10.375 32.375L9.625 27.125L13 23.375L17.625 23.75L18.75 24L23.375 27.625L33.25 35.25L46.25 44.875L48.125 46.375L49 45.875V45.5L48.125 44.125L41.125 31.375L33.625 18.375L30.25 13L29.375 9.75C29.0417 8.625 28.875 7.375 28.875 6L32.75 0.750006L34.875 0L40.125 0.750006L42.25 2.625L45.5 10L50.625 21.625L58.75 37.375L61.125 42.125L62.375 46.375L62.875 47.75H63.75V47L64.375 38L65.625 27.125L66.875 13.125L67.25 9.125L69.25 4.375L73.125 1.87501L76.125 3.25L78.625 6.875L78.25 9.125L76.875 18.75L73.875 33.875L72 44.125H73.125L74.375 42.75L79.5 36L88.125 25.25L91.875 21L96.375 16.25L99.25 14H104.625L108.5 19.875L106.75 26L101.25 33L96.625 38.875L90 47.75L86 54.875L86.375 55.375H87.25L102.125 52.125L110.25 50.75L119.75 49.125L124.125 51.125L124.625 53.125L122.875 57.375L112.625 59.875L100.625 62.25L82.75 66.5L82.5 66.625L82.75 67L90.75 67.75L94.25 68H102.75L118.5 69.125L122.625 71.875L125 75.125L124.625 77.75L118.25 80.875L109.75 78.875L89.75 74.125L83 72.5H82V73L87.75 78.625L98.125 88L111.25 100.125L111.875 103.125L110.25 105.625L108.5 105.375L97 96.625L92.5 92.75L82.5 84.375H81.875V85.25L84.125 88.625L96.375 107L97 112.625L96.125 114.375L92.875 115.5L89.5 114.875L82.25 104.875L74.875 93.5L68.875 83.375L68.25 83.875L64.625 121.625L63 123.5L59.25 125L56.125 122.625L54.375 118.75Z"
						fill={effectiveColor}
					/>
				</svg>
			);
		case 'opencode':
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={effectiveColor}
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
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={effectiveColor}
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M4.5 19.5V11h6l2-3.5h7v12Z" />
					<path d="M9 11V7.5h2.2" />
					<circle cx="9" cy="19" r="1.5" fill={effectiveColor} stroke="none" />
					<circle cx="17" cy="19" r="1.5" fill={effectiveColor} stroke="none" />
				</svg>
			);
		case 'terminal':
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={effectiveColor}
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

function GenericModelIcon({ color }: { color: string }) {
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
			<path d="M8 7h8" />
			<path d="M6 12h12" />
			<path d="M10 17h4" />
		</svg>
	);
}

export function ModelSelectorButton({
	label,
	toolType,
	onClick,
	disabled,
	isOpen,
	iconOnly = false,
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
				width: iconOnly ? '34px' : 'auto',
				height: iconOnly ? '34px' : buttonBaseStyles.height,
				minWidth: iconOnly ? '34px' : '70px',
				maxWidth: iconOnly ? '34px' : '120px',
				padding: iconOnly ? '0' : '0 12px',
				borderRadius: iconOnly ? '999px' : buttonBaseStyles.borderRadius,
				aspectRatio: iconOnly ? '1 / 1' : undefined,
				gap: iconOnly ? '0' : '6px',
				backgroundColor: isOpen ? `${colors.accent}20` : `${colors.bgMain}c8`,
				border: `1px solid ${isOpen ? `${colors.accent}66` : colors.border}`,
				color: isOpen ? colors.accent : colors.textMain,
				opacity: disabled ? 0.5 : 1,
				boxShadow: iconOnly
					? '0 8px 18px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.06)'
					: buttonBaseStyles.boxShadow,
				boxSizing: 'border-box',
				appearance: 'none',
				WebkitAppearance: 'none',
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
			title={label}
		>
			{showProviderIcon ? (
				<span
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: iconOnly ? '15px' : '16px',
						height: iconOnly ? '15px' : '16px',
						flexShrink: 0,
					}}
				>
					<ProviderModelIcon toolType={toolType} color={iconColor} />
				</span>
			) : (
				<GenericModelIcon color={iconColor} />
			)}
			{!iconOnly && (
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
			)}
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
	/** Visual density for the button */
	variant?: 'default' | 'inline';
	/** Optional click handler for send mode instead of form submit */
	onSend?: () => void;
	/** Optional custom aria-label for interrupt mode */
	interruptAriaLabel?: string;
	/** Optional custom aria-label for send mode */
	sendAriaLabel?: string;
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
	variant = 'default',
	onSend,
	interruptAriaLabel,
	sendAriaLabel,
}: SendInterruptButtonProps) {
	const colors = useThemeColors();
	const isInline = variant === 'inline';

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
					width: isInline ? '34px' : buttonBaseStyles.width,
					height: isInline ? '34px' : buttonBaseStyles.height,
					minWidth: isInline ? '34px' : undefined,
					minHeight: isInline ? '34px' : undefined,
					maxWidth: isInline ? '34px' : undefined,
					maxHeight: isInline ? '34px' : undefined,
					padding: isInline ? '0' : '14px',
					borderRadius: isInline ? '999px' : buttonBaseStyles.borderRadius,
					aspectRatio: isInline ? '1 / 1' : undefined,
					background: 'linear-gradient(180deg, #f87171 0%, #ef4444 100%)',
					color: '#ffffff',
					fontSize: '14px',
					fontWeight: 500,
					boxShadow: isInline
						? '0 8px 18px rgba(239, 68, 68, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.08)'
						: buttonBaseStyles.boxShadow,
					boxSizing: 'border-box',
					appearance: 'none',
					WebkitAppearance: 'none',
				}}
				onTouchStart={(e) => {
					e.currentTarget.style.transform = 'scale(0.95)';
					e.currentTarget.style.backgroundColor = '#dc2626';
				}}
				onTouchEnd={(e) => {
					e.currentTarget.style.transform = 'scale(1)';
					e.currentTarget.style.backgroundColor = '#ef4444';
				}}
				aria-label={interruptAriaLabel || 'Cancel running command or AI query'}
			>
				{/* X icon for interrupt */}
				<svg
					width={isInline ? 15 : 24}
					height={isInline ? 15 : 24}
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
			type={onSend ? 'button' : 'submit'}
			onClick={onSend}
			disabled={isSendDisabled}
			style={{
				...buttonBaseStyles,
				width: isInline ? '34px' : buttonBaseStyles.width,
				height: isInline ? '34px' : buttonBaseStyles.height,
				minWidth: isInline ? '34px' : undefined,
				minHeight: isInline ? '34px' : undefined,
				maxWidth: isInline ? '34px' : undefined,
				maxHeight: isInline ? '34px' : undefined,
				padding: isInline ? '0' : '14px',
				borderRadius: isInline ? '999px' : buttonBaseStyles.borderRadius,
				aspectRatio: isInline ? '1 / 1' : undefined,
				background: `linear-gradient(180deg, ${colors.accent} 0%, ${colors.accent}dd 100%)`,
				color: '#ffffff',
				fontSize: '14px',
				fontWeight: 500,
				cursor: isSendDisabled ? 'default' : 'pointer',
				opacity: isSendDisabled ? 0.5 : 1,
				boxShadow: isInline
					? '0 8px 18px rgba(99, 102, 241, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.10)'
					: buttonBaseStyles.boxShadow,
				boxSizing: 'border-box',
				appearance: 'none',
				WebkitAppearance: 'none',
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
			aria-label={sendAriaLabel || 'Send command (long press for quick actions)'}
		>
			{/* Arrow up icon for send */}
			<svg
				width={isInline ? 15 : 24}
				height={isInline ? 15 : 24}
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
