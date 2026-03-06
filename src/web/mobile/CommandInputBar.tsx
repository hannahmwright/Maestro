/**
 * CommandInputBar - Sticky bottom input bar for mobile web interface
 *
 * A touch-friendly command input component that stays fixed at the bottom
 * of the viewport and properly handles mobile keyboard appearance.
 *
 * Features:
 * - Always visible at bottom of screen
 * - Adjusts position when mobile keyboard appears (using visualViewport API)
 * - Supports safe area insets for notched devices
 * - Disabled state when disconnected or offline
 * - Large touch-friendly textarea for easy mobile input
 * - Auto-expanding textarea for multi-line commands (up to 4 lines)
 * - Minimum 44px touch targets per Apple HIG guidelines
 * - Mode toggle button (AI / Terminal) with visual indicator
 * - Voice input button for in-browser recording with desktop transcription
 * - Interrupt button (red X) REPLACES send button when session is busy
 *   (saves horizontal space - only one action button visible at a time)
 * - Recent command chips for quick access to recently sent commands
 * - Slash command autocomplete popup when typing `/`
 * - Haptic feedback on send (if device supports vibration)
 * - Quick actions menu on long-press of send button
 * - Flex layout with minWidth: 0 ensures text input shrinks to fit screen
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { useSwipeUp } from '../hooks/useSwipeUp';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useKeyboardVisibility } from '../hooks/useKeyboardVisibility';
import { useSlashCommandAutocomplete } from '../hooks/useSlashCommandAutocomplete';
import { RecentCommandChips } from './RecentCommandChips';
import {
	SlashCommandAutocomplete,
	type SlashCommand,
	DEFAULT_SLASH_COMMANDS,
} from './SlashCommandAutocomplete';
import { triggerHaptic } from './constants';
import {
	ModelSelectorButton,
	VoiceInputButton,
	SendInterruptButton,
	ExpandedModeSendInterruptButton,
} from './CommandInputButtons';
import type { CommandHistoryEntry } from '../hooks/useCommandHistory';

/** Default minimum height for the text input area */
const MIN_INPUT_HEIGHT = 48;

/** Line height for text calculations */
const LINE_HEIGHT = 22;

/** Maximum number of lines before scrolling */
const MAX_LINES = 4;

/** Vertical padding inside textarea (top + bottom) */
const TEXTAREA_VERTICAL_PADDING = 28; // 14px top + 14px bottom

/** Maximum height for textarea based on max lines */
const MAX_TEXTAREA_HEIGHT = LINE_HEIGHT * MAX_LINES + TEXTAREA_VERTICAL_PADDING;

/** Mobile breakpoint - phones only, not tablets */
const MOBILE_MAX_WIDTH = 480;

/** Height of expanded input on mobile (50% of viewport) */
const MOBILE_EXPANDED_HEIGHT_VH = 50;

/**
 * Detect if the device is a mobile phone (not tablet/desktop)
 * Based on screen width and touch capability
 */
function useIsMobilePhone(): boolean {
	const [isMobile, setIsMobile] = useState(false);

	useEffect(() => {
		const checkMobile = () => {
			const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
			const isSmallScreen = window.innerWidth <= MOBILE_MAX_WIDTH;
			setIsMobile(isTouchDevice && isSmallScreen);
		};

		checkMobile();
		window.addEventListener('resize', checkMobile);
		return () => window.removeEventListener('resize', checkMobile);
	}, []);

	return isMobile;
}

/** Input mode type - AI assistant or terminal */
export type InputMode = 'ai' | 'terminal';

export interface CommandInputBarProps {
	/** Whether the device is offline */
	isOffline: boolean;
	/** Whether connected to the server */
	isConnected: boolean;
	/** Placeholder text for the input */
	placeholder?: string;
	/** Callback when command is submitted */
	onSubmit?: (command: string) => void;
	/** Callback when input value changes */
	onChange?: (value: string) => void;
	/** Current input value (controlled) */
	value?: string;
	/** Whether the input is disabled */
	disabled?: boolean;
	/** Current input mode (AI or terminal) */
	inputMode?: InputMode;
	/** Whether the active session is busy (AI thinking) */
	isSessionBusy?: boolean;
	/** Callback when interrupt button is pressed */
	onInterrupt?: () => void;
	/** Callback when history drawer should open (swipe up) */
	onHistoryOpen?: () => void;
	/** Recent unique commands for quick-tap chips */
	recentCommands?: CommandHistoryEntry[];
	/** Callback when a recent command chip is tapped */
	onSelectRecentCommand?: (command: string) => void;
	/** Available slash commands (uses defaults if not provided) */
	slashCommands?: SlashCommand[];
	/** Whether a session is currently active (for quick actions menu) */
	hasActiveSession?: boolean;
	/** Whether the active session supports model selection */
	supportsModelSelection?: boolean;
	/** Current display label for the selected/runtime model */
	modelLabel?: string;
	/** Active provider tool type for selector branding */
	modelToolType?: string | null;
	/** Load available models for the current session */
	loadModels?: (forceRefresh?: boolean) => Promise<string[]>;
	/** Apply a selected model to the current session */
	onSelectModel?: (model: string | null) => Promise<void> | void;
	/** Callback when input receives focus */
	onInputFocus?: () => void;
	/** Callback when input loses focus */
	onInputBlur?: () => void;
	/** Whether to show recent command chips (defaults to true) */
	showRecentCommands?: boolean;
}

/**
 * CommandInputBar component
 *
 * Provides a sticky bottom input bar optimized for mobile devices.
 * Uses the Visual Viewport API to stay above the keyboard.
 */
export function CommandInputBar({
	isOffline,
	isConnected,
	placeholder,
	onSubmit,
	onChange,
	value: controlledValue,
	disabled: externalDisabled,
	inputMode = 'ai',
	isSessionBusy = false,
	onInterrupt,
	onHistoryOpen,
	recentCommands,
	onSelectRecentCommand,
	slashCommands = DEFAULT_SLASH_COMMANDS,
	hasActiveSession = false,
	supportsModelSelection = false,
	modelLabel = 'Model',
	modelToolType,
	loadModels,
	onSelectModel,
	onInputFocus,
	onInputBlur,
	showRecentCommands = true,
}: CommandInputBarProps) {
	const colors = useThemeColors();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const modelMenuRef = useRef<HTMLDivElement>(null);

	// Mobile phone detection
	const isMobilePhone = useIsMobilePhone();

	// Mobile expanded input state (AI mode only)
	const [isExpanded, setIsExpanded] = useState(false);

	// Swipe up gesture detection for opening history drawer
	const { handlers: swipeUpHandlers } = useSwipeUp({
		onSwipeUp: () => onHistoryOpen?.(),
		enabled: !!onHistoryOpen,
	});

	// Track keyboard visibility for positioning (using Visual Viewport API)
	const { keyboardOffset, isKeyboardVisible } = useKeyboardVisibility();

	// Track textarea height for auto-expansion
	const [textareaHeight, setTextareaHeight] = useState(MIN_INPUT_HEIGHT);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);

	// Internal state for uncontrolled mode
	const [internalValue, setInternalValue] = useState('');
	const value = controlledValue !== undefined ? controlledValue : internalValue;

	// Determine if input should be disabled (must be before hooks that use it)
	// In AI mode: NEVER disable the input - user can always prep next message
	// The send button will show X (interrupt) when AI is busy
	// For terminal mode: do NOT disable when session is busy - terminal commands use a different pathway
	const isDisabled = externalDisabled || isOffline || !isConnected;

	// Slash command autocomplete hook
	const {
		isOpen: slashCommandOpen,
		selectedIndex: selectedSlashCommandIndex,
		setSelectedIndex: setSelectedSlashCommandIndex,
		openAutocomplete: openSlashCommandAutocomplete,
		handleInputChange: handleSlashCommandInputChange,
		handleSelectCommand: handleSelectSlashCommand,
		handleClose: handleCloseSlashCommand,
	} = useSlashCommandAutocomplete({
		inputValue: value,
		isControlled: controlledValue !== undefined,
		onChange: (newValue: string) => {
			if (controlledValue === undefined) {
				setInternalValue(newValue);
			}
			onChange?.(newValue);
		},
		onSubmit,
		inputRef: textareaRef as React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
	});

	// Voice input hook - handles local recording and desktop transcription
	const handleVoiceTranscription = useCallback(
		(newText: string) => {
			if (controlledValue === undefined) {
				setInternalValue(newText);
			}
			onChange?.(newText);
		},
		[controlledValue, onChange]
	);

	const {
		isListening,
		isTranscribing,
		voiceState,
		voiceStatusText,
		voiceSupported,
		toggleVoiceInput: handleVoiceToggle,
	} = useVoiceInput({
		currentValue: value,
		disabled: isDisabled,
		onTranscriptionChange: handleVoiceTranscription,
		focusRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
	});

	// Separate flag for whether send is blocked (AI thinking)
	// When true, shows X button instead of send button
	const isSendBlocked = inputMode === 'ai' && isSessionBusy;
	const composerSurfaceStyle: React.CSSProperties = {
		background: `linear-gradient(180deg, ${colors.bgSidebar}f2 0%, ${colors.bgMain}f4 100%)`,
		backdropFilter: 'blur(22px)',
		WebkitBackdropFilter: 'blur(22px)',
		border: `1px solid ${colors.border}`,
		boxShadow: '0 -10px 28px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
	};

	// Get placeholder text based on state
	const getPlaceholder = () => {
		if (isOffline) return 'Offline...';
		if (!isConnected) return 'Connecting...';
		if (voiceState === 'requesting') return 'Waiting for microphone...';
		if (voiceState === 'recording') return 'Listening... tap the mic again to stop';
		if (voiceState === 'transcribing') return 'Transcribing voice note...';
		// In AI mode when busy, show helpful hint that user can still type
		if (inputMode === 'ai' && isSessionBusy) return 'AI thinking... (type your next message)';
		return placeholder || 'Message agent...';
	};

	/**
	 * Auto-resize textarea based on content
	 * Expands up to MAX_LINES (4 lines) then enables scrolling
	 */
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;

		// If value is empty, reset to minimum height immediately
		if (!value) {
			setTextareaHeight(MIN_INPUT_HEIGHT);
			textarea.style.height = `${MIN_INPUT_HEIGHT}px`;
			return;
		}

		// Reset height to minimum to get accurate scrollHeight measurement
		textarea.style.height = `${MIN_INPUT_HEIGHT}px`;

		// Calculate the new height based on content
		const scrollHeight = textarea.scrollHeight;

		// Clamp height between minimum and maximum
		const newHeight = Math.min(Math.max(scrollHeight, MIN_INPUT_HEIGHT), MAX_TEXTAREA_HEIGHT);

		setTextareaHeight(newHeight);
		textarea.style.height = `${newHeight}px`;
	}, [value]);

	/**
	 * Handle textarea change
	 * Also detects slash commands and shows autocomplete via hook
	 */
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const newValue = e.target.value;
			if (controlledValue === undefined) {
				setInternalValue(newValue);
			}
			onChange?.(newValue);

			// Delegate slash command detection to the hook
			handleSlashCommandInputChange(newValue);
		},
		[controlledValue, onChange, handleSlashCommandInputChange]
	);

	/**
	 * Handle form submission
	 */
	const handleSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			if (!value.trim() || isDisabled) return;

			// Trigger haptic feedback on successful send
			triggerHaptic(25);

			onSubmit?.(value.trim());

			// Clear input after submit (for uncontrolled mode)
			if (controlledValue === undefined) {
				setInternalValue('');
			}

			// Keep focus on textarea after submit
			textareaRef.current?.focus();
		},
		[value, isDisabled, onSubmit, controlledValue]
	);

	/**
	 * Handle key press events
	 * Plain Enter submits in the compact mobile composer.
	 * Shift+Enter still inserts a newline for longer prompts.
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				handleSubmit(e);
			}
		},
		[handleSubmit]
	);

	/**
	 * Handle interrupt button press
	 */
	const handleInterrupt = useCallback(() => {
		onInterrupt?.();
	}, [onInterrupt]);

	/**
	 * Handle click outside to collapse expanded input on mobile
	 */
	useEffect(() => {
		if (!isExpanded || !isMobilePhone || inputMode !== 'ai') return;

		const handleClickOutside = (e: MouseEvent | TouchEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setIsExpanded(false);
				textareaRef.current?.blur();
			}
		};

		// Use touchstart for immediate response on mobile
		document.addEventListener('touchstart', handleClickOutside);
		document.addEventListener('mousedown', handleClickOutside);

		return () => {
			document.removeEventListener('touchstart', handleClickOutside);
			document.removeEventListener('mousedown', handleClickOutside);
		};
	}, [isExpanded, isMobilePhone, inputMode]);

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent | TouchEvent) => {
			const target = event.target as Node;
			if (modelMenuRef.current && !modelMenuRef.current.contains(target)) {
				setModelMenuOpen(false);
			}
		};

		document.addEventListener('mousedown', handleClickOutside);
		document.addEventListener('touchstart', handleClickOutside);
		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
			document.removeEventListener('touchstart', handleClickOutside);
		};
	}, []);

	useEffect(() => {
		if (!supportsModelSelection) {
			setModelMenuOpen(false);
		}
	}, [supportsModelSelection]);

	const handleModelMenuToggle = useCallback(async () => {
		if (!supportsModelSelection || !loadModels) {
			return;
		}

		const nextOpen = !modelMenuOpen;
		setModelMenuOpen(nextOpen);
		if (!nextOpen) {
			return;
		}

		setLoadingModels(true);
		try {
			const models = await loadModels(false);
			setAvailableModels(models);
		} finally {
			setLoadingModels(false);
		}
	}, [loadModels, modelMenuOpen, supportsModelSelection]);

	const handleRefreshModels = useCallback(async () => {
		if (!loadModels) return;
		setLoadingModels(true);
		try {
			const models = await loadModels(true);
			setAvailableModels(models);
		} finally {
			setLoadingModels(false);
		}
	}, [loadModels]);

	const handleSelectModelInternal = useCallback(
		async (model: string | null) => {
			if (!onSelectModel) return;
			await onSelectModel(model);
			setModelMenuOpen(false);
		},
		[onSelectModel]
	);
	const selectableModels = React.useMemo(() => {
		const normalizedCurrentModel = modelLabel.trim();
		const models = [...availableModels];
		if (
			normalizedCurrentModel &&
			normalizedCurrentModel !== 'Model' &&
			!models.includes(normalizedCurrentModel)
		) {
			models.unshift(normalizedCurrentModel);
		}
		return models;
	}, [availableModels, modelLabel]);

	/**
	 * Handle focus to expand input on mobile in AI mode
	 */
	const handleMobileAIFocus = useCallback(() => {
		if (isMobilePhone && inputMode === 'ai') {
			setIsExpanded(true);
		}
		onInputFocus?.();
	}, [isMobilePhone, inputMode, onInputFocus]);

	/**
	 * Auto-focus the textarea when expanded mode is activated
	 */
	useEffect(() => {
		if (isExpanded && isMobilePhone && inputMode === 'ai' && textareaRef.current) {
			// Small delay to ensure DOM has updated
			const timer = setTimeout(() => {
				textareaRef.current?.focus();
			}, 50);
			return () => clearTimeout(timer);
		}
	}, [isExpanded, isMobilePhone, inputMode]);

	/**
	 * Collapse input when submitting on mobile
	 */
	const handleMobileSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			if (!value.trim() || isDisabled || isSendBlocked) return;

			// Trigger haptic feedback on successful send
			triggerHaptic(25);

			onSubmit?.(value.trim());

			// Clear input after submit (for uncontrolled mode)
			if (controlledValue === undefined) {
				setInternalValue('');
			}

			// Collapse on mobile after submit
			if (isMobilePhone && inputMode === 'ai') {
				setIsExpanded(false);
			}

			// Keep focus on textarea after submit (unless mobile where we collapse)
			if (!isMobilePhone) {
				textareaRef.current?.focus();
			}
		},
		[value, isDisabled, isSendBlocked, onSubmit, controlledValue, isMobilePhone, inputMode]
	);

	// Calculate textarea height for mobile expanded mode
	const mobileExpandedHeight =
		isMobilePhone && inputMode === 'ai' && isExpanded
			? `${MOBILE_EXPANDED_HEIGHT_VH}vh`
			: undefined;

	return (
		<div
			ref={containerRef}
			{...swipeUpHandlers}
			style={{
				position: 'fixed',
				left: 0,
				right: 0,
				bottom: keyboardOffset,
				zIndex: 100,
				// Safe area padding for notched devices
				paddingBottom: isKeyboardVisible ? '0' : 'max(12px, env(safe-area-inset-bottom))',
				paddingLeft: 'env(safe-area-inset-left)',
				paddingRight: 'env(safe-area-inset-right)',
				paddingTop: onHistoryOpen ? '4px' : '12px', // Reduced top padding when swipe handle is shown
				background: 'linear-gradient(180deg, rgba(15, 23, 42, 0) 0%, rgba(15, 23, 42, 0.08) 100%)',
				// Smooth transition when keyboard appears/disappears
				transition: isKeyboardVisible ? 'none' : 'bottom 0.15s ease-out, height 200ms ease-out',
				// On mobile when expanded, use flexbox for proper layout
				...(mobileExpandedHeight && {
					display: 'flex',
					flexDirection: 'column',
					height: `calc(${MOBILE_EXPANDED_HEIGHT_VH}vh + 60px)`, // Textarea height + buttons/padding
				}),
			}}
		>
			{/* Swipe up handle indicator - visual hint for opening history */}
			{onHistoryOpen && (
				<div
					style={{
						display: 'flex',
						justifyContent: 'center',
						paddingBottom: '8px',
						cursor: 'pointer',
					}}
					onClick={onHistoryOpen}
					aria-label="Open command history"
				>
					<div
						style={{
							width: '36px',
							height: '4px',
							backgroundColor: colors.border,
							borderRadius: '2px',
							opacity: 0.6,
						}}
					/>
				</div>
			)}

			{/* Recent command chips - quick-tap to reuse commands */}
			{/* On mobile, can be hidden when input is not focused to save space */}
			{showRecentCommands &&
				recentCommands &&
				recentCommands.length > 0 &&
				onSelectRecentCommand && (
					<RecentCommandChips
						commands={recentCommands}
						onSelectCommand={onSelectRecentCommand}
						disabled={isDisabled}
					/>
				)}

			{/* Slash command autocomplete popup */}
			<SlashCommandAutocomplete
				isOpen={slashCommandOpen}
				inputValue={value}
				inputMode={inputMode}
				commands={slashCommands}
				onSelectCommand={handleSelectSlashCommand}
				onClose={handleCloseSlashCommand}
				selectedIndex={selectedSlashCommandIndex}
				onSelectedIndexChange={setSelectedSlashCommandIndex}
				isInputExpanded={isExpanded}
			/>

			{supportsModelSelection && modelMenuOpen && (
				<div
					ref={modelMenuRef}
					style={{
						position: 'absolute',
						left: '12px',
						right: '12px',
						bottom: mobileExpandedHeight ? `calc(${MOBILE_EXPANDED_HEIGHT_VH}vh + 78px)` : '84px',
						zIndex: 110,
						borderRadius: '20px',
						border: `1px solid ${colors.border}`,
						background: `linear-gradient(180deg, ${colors.bgSidebar}fa 0%, ${colors.bgMain}fa 100%)`,
						backdropFilter: 'blur(22px)',
						WebkitBackdropFilter: 'blur(22px)',
						boxShadow: '0 18px 36px rgba(15, 23, 42, 0.22)',
						padding: '12px',
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
							gap: '12px',
						}}
					>
						<div
							style={{
								fontSize: '12px',
								fontWeight: 700,
								color: colors.textMain,
								letterSpacing: '0.04em',
								textTransform: 'uppercase',
							}}
						>
							Model
						</div>
						<button
							type="button"
							onClick={() => void handleRefreshModels()}
							style={{
								border: 'none',
								background: 'transparent',
								color: colors.accent,
								fontSize: '12px',
								fontWeight: 600,
								cursor: 'pointer',
							}}
						>
							{loadingModels ? 'Loading...' : 'Refresh'}
						</button>
					</div>
					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							gap: '6px',
							maxHeight: '220px',
							overflowY: 'auto',
						}}
					>
						{selectableModels.map((model) => {
							const isSelected = model === modelLabel;
							return (
								<button
									key={model}
									type="button"
									onClick={() => void handleSelectModelInternal(model)}
									style={{
										padding: '12px 14px',
										borderRadius: '14px',
										border: `1px solid ${colors.border}`,
										backgroundColor: isSelected ? `${colors.accent}18` : `${colors.bgMain}cc`,
										color: isSelected ? colors.accent : colors.textMain,
										fontSize: '13px',
										fontWeight: 500,
										textAlign: 'left',
										cursor: 'pointer',
										overflow: 'hidden',
										textOverflow: 'ellipsis',
										whiteSpace: 'nowrap',
									}}
								>
									{model}
								</button>
							);
						})}
						{!loadingModels && selectableModels.length === 0 && (
							<div
								style={{
									padding: '12px 14px',
									borderRadius: '14px',
									border: `1px solid ${colors.border}`,
									backgroundColor: `${colors.bgMain}cc`,
									color: colors.textDim,
									fontSize: '13px',
								}}
							>
								No models available
							</div>
						)}
					</div>
				</div>
			)}

			{/* EXPANDED MOBILE AI MODE - Full width textarea with send button below */}
			{mobileExpandedHeight ? (
				<form
					onSubmit={handleMobileSubmit}
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '8px',
						padding: '14px 14px 12px',
						flex: 1,
						maxWidth: '100%',
						overflow: 'hidden',
						borderRadius: '26px 26px 0 0',
						...composerSurfaceStyle,
					}}
				>
					{/* Full-width textarea */}
					<textarea
						ref={textareaRef}
						value={value}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						placeholder={getPlaceholder()}
						disabled={isDisabled}
						autoComplete="off"
						autoCorrect="off"
						autoCapitalize="off"
						spellCheck={false}
						enterKeyHint="enter"
						rows={1}
						style={{
							flex: 1,
							width: '100%',
							padding: '14px 18px',
							borderRadius: '20px',
							backgroundColor: `${colors.bgMain}d9`,
							border: `1px solid ${colors.border}`,
							boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
							color: colors.textMain,
							fontSize: '16px',
							fontFamily: 'inherit',
							lineHeight: `${LINE_HEIGHT}px`,
							outline: 'none',
							minHeight: '150px',
							WebkitAppearance: 'none',
							appearance: 'none',
							resize: 'none',
							WebkitFontSmoothing: 'antialiased',
							MozOsxFontSmoothing: 'grayscale',
							overflowY: 'auto',
							overflowX: 'hidden',
							wordWrap: 'break-word',
						}}
						onBlur={(_e) => {
							// Delay collapse to allow click on send button
							setTimeout(() => {
								if (!containerRef.current?.contains(document.activeElement)) {
									setIsExpanded(false);
								}
							}, 150);
							onInputBlur?.();
						}}
						aria-label="AI message input. Press the send button to submit."
						aria-multiline="true"
					/>

					{/* Full-width send button below textarea */}
					<ExpandedModeSendInterruptButton
						isInterruptMode={inputMode === 'ai' && isSessionBusy}
						isSendDisabled={isDisabled || !value.trim()}
						onInterrupt={handleInterrupt}
					/>
				</form>
			) : (
				/* NORMAL MODE - Original layout with side buttons */
				<form
					onSubmit={handleMobileSubmit}
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '8px',
						alignItems: 'stretch',
						padding: '10px 12px',
						// Ensure form doesn't overflow screen width
						maxWidth: '100%',
						overflow: 'hidden',
						margin: '0 12px',
						borderRadius: '24px',
						...composerSurfaceStyle,
					}}
				>
					{voiceStatusText && (
						<div
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								gap: '8px',
								alignSelf: 'flex-start',
								padding: '8px 12px',
								borderRadius: '999px',
								border: `1px solid ${voiceState === 'recording' ? '#ef444455' : `${colors.accent}33`}`,
								backgroundColor: voiceState === 'recording' ? '#ef444414' : `${colors.bgMain}cc`,
								color: voiceState === 'recording' ? '#ef4444' : colors.textDim,
								fontSize: '12px',
								fontWeight: 600,
								boxShadow: '0 8px 18px rgba(15, 23, 42, 0.08)',
							}}
						>
							<span
								style={{
									width: '8px',
									height: '8px',
									borderRadius: '999px',
									backgroundColor: voiceState === 'recording' ? '#ef4444' : colors.accent,
									opacity: 0.95,
									animation:
										voiceState === 'recording'
											? 'pulseDot 1.2s ease-in-out infinite'
											: voiceState === 'transcribing' || voiceState === 'requesting'
												? 'pulseDot 1.2s ease-in-out infinite'
												: 'none',
									flexShrink: 0,
								}}
							/>
							<span>{voiceStatusText}</span>
						</div>
					)}

					<div
						style={{
							display: 'flex',
							gap: '8px',
							alignItems: 'flex-end',
							maxWidth: '100%',
							overflow: 'hidden',
						}}
					>
						{/* Voice input button - only shown if local recording is supported */}
						{voiceSupported && (
							<VoiceInputButton
								isListening={isListening}
								isRequesting={voiceState === 'requesting'}
								isTranscribing={isTranscribing}
								statusText={voiceStatusText}
								onToggle={handleVoiceToggle}
								disabled={isDisabled || isTranscribing}
							/>
						)}

						{supportsModelSelection && (
							<ModelSelectorButton
								label={modelLabel}
								toolType={modelToolType}
								onClick={() => void handleModelMenuToggle()}
								disabled={isDisabled || !hasActiveSession || isTranscribing}
								isOpen={modelMenuOpen}
							/>
						)}

						<textarea
							ref={textareaRef}
							value={value}
							onChange={handleChange}
							onKeyDown={handleKeyDown}
							placeholder={getPlaceholder()}
							disabled={isDisabled || isTranscribing}
							autoComplete="off"
							autoCorrect="off"
							autoCapitalize="off"
							spellCheck={false}
							enterKeyHint="send"
							rows={1}
							style={{
								flex: 1,
								minWidth: 0,
								padding: isMobilePhone ? '12px 14px' : '14px 18px',
								borderRadius: '18px',
								backgroundColor: `${colors.bgMain}c4`,
								border: '1px solid transparent',
								color: colors.textMain,
								fontSize: '16px',
								fontFamily: 'inherit',
								lineHeight: `${LINE_HEIGHT}px`,
								outline: 'none',
								height: isMobilePhone ? `${MIN_INPUT_HEIGHT}px` : `${textareaHeight}px`,
								minHeight: `${MIN_INPUT_HEIGHT}px`,
								maxHeight: isMobilePhone ? `${MIN_INPUT_HEIGHT}px` : `${MAX_TEXTAREA_HEIGHT}px`,
								WebkitAppearance: 'none',
								appearance: 'none',
								resize: 'none',
								transition:
									'height 100ms ease-out, border-color 150ms ease, box-shadow 150ms ease, background-color 150ms ease',
								WebkitFontSmoothing: 'antialiased',
								MozOsxFontSmoothing: 'grayscale',
								overflowY: isMobilePhone
									? 'hidden'
									: textareaHeight >= MAX_TEXTAREA_HEIGHT
										? 'auto'
										: 'hidden',
								overflowX: 'hidden',
								wordWrap: 'break-word',
							}}
							onFocus={(e) => {
								e.currentTarget.style.borderColor = `${colors.accent}55`;
								e.currentTarget.style.backgroundColor = `${colors.bgMain}ee`;
								e.currentTarget.style.boxShadow = `0 0 0 3px ${colors.accent}22`;
								handleMobileAIFocus();
							}}
							onBlur={(e) => {
								e.currentTarget.style.borderColor = 'transparent';
								e.currentTarget.style.backgroundColor = `${colors.bgMain}c4`;
								e.currentTarget.style.boxShadow = 'none';
								onInputBlur?.();
							}}
							aria-label="Message input. Type slash commands directly if needed."
							aria-multiline="true"
						/>

						<SendInterruptButton
							isInterruptMode={inputMode === 'ai' && isSessionBusy}
							isSendDisabled={isDisabled || isTranscribing || !value.trim()}
							onInterrupt={handleInterrupt}
						/>
					</div>
				</form>
			)}

			{/* Inline CSS for animations */}
			<style>
				{`
          @keyframes pulse {
            0%, 100% {
              box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
            }
            50% {
              box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
            }
          }

					@keyframes pulseDot {
						0%, 100% { opacity: 0.5; transform: scale(0.9); }
						50% { opacity: 1; transform: scale(1.1); }
					}

					@keyframes spin {
						from { transform: rotate(0deg); }
						to { transform: rotate(360deg); }
					}
        `}
			</style>
		</div>
	);
}

export default CommandInputBar;
