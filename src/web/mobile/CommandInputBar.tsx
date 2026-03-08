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
import { createPortal } from 'react-dom';
import { FileText, Paperclip, Plus, X } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import { useSwipeUp } from '../hooks/useSwipeUp';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useKeyboardVisibility } from '../hooks/useKeyboardVisibility';
import { useSlashCommandAutocomplete } from '../hooks/useSlashCommandAutocomplete';
import type { WebTextAttachmentInput } from '../../shared/remote-web';
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
const MIN_INPUT_HEIGHT = 56;

/** Line height for text calculations */
const LINE_HEIGHT = 24;

/** Maximum number of lines before scrolling */
const MAX_LINES = 6;

/** Maximum number of lines for the compact mobile composer */
const COMPACT_MOBILE_MAX_LINES = 3;

/** Vertical padding inside textarea (top + bottom) */
const TEXTAREA_VERTICAL_PADDING = 32; // 16px top + 16px bottom

/** Maximum height for textarea based on max lines */
const MAX_TEXTAREA_HEIGHT = LINE_HEIGHT * MAX_LINES + TEXTAREA_VERTICAL_PADDING;

/** Maximum compact composer height on phones */
const COMPACT_MOBILE_MAX_TEXTAREA_HEIGHT =
	LINE_HEIGHT * COMPACT_MOBILE_MAX_LINES + TEXTAREA_VERTICAL_PADDING;

/** Mobile breakpoint - phones only, not tablets */
const MOBILE_MAX_WIDTH = 480;

/** Height of expanded input on mobile */
const MOBILE_EXPANDED_HEIGHT_VH = 30;

const TEXT_ATTACHMENT_MAX_BYTES = 180 * 1024;

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
	'txt',
	'md',
	'markdown',
	'json',
	'yml',
	'yaml',
	'xml',
	'csv',
	'tsv',
	'toml',
	'ini',
	'cfg',
	'conf',
	'env',
	'log',
	'ts',
	'tsx',
	'js',
	'jsx',
	'mjs',
	'cjs',
	'css',
	'scss',
	'html',
	'htm',
	'py',
	'rb',
	'go',
	'java',
	'sh',
	'bash',
	'zsh',
	'sql',
	'php',
	'rs',
	'swift',
	'kt',
]);

function createAttachmentId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
		reader.readAsDataURL(file);
	});
}

function readFileAsText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
		reader.readAsText(file);
	});
}

function supportsTextAttachment(file: File): boolean {
	if (file.type.startsWith('text/')) {
		return true;
	}
	if (
		[
			'application/json',
			'application/xml',
			'application/javascript',
			'application/x-javascript',
			'application/typescript',
			'application/x-sh',
			'application/x-yaml',
			'application/yaml',
			'text/x-typescript',
			'text/x-python',
			'text/x-ruby',
		].includes(file.type)
	) {
		return true;
	}

	const extension = file.name.split('.').pop()?.toLowerCase();
	return !!extension && TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

/**
 * Detect if the device is a mobile phone (not tablet/desktop)
 * Based on screen width and touch capability
 */
function useIsMobilePhone(): boolean {
	const [isMobile, setIsMobile] = useState(false);

	useEffect(() => {
		const checkMobile = () => {
			const isStandalonePreview =
				window.location.hostname === 'localhost' && window.location.port === '5174';
			const isSmallScreen = window.innerWidth <= MOBILE_MAX_WIDTH;
			setIsMobile(isStandalonePreview || isSmallScreen);
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
	/** Reports the rendered composer height so the layout can reserve space */
	onHeightChange?: (height: number) => void;
	/** Staged image attachments for the pending message */
	stagedImages?: string[];
	/** Staged text/code attachments for the pending message */
	stagedTextAttachments?: WebTextAttachmentInput[];
	/** Add attachments selected from the file picker */
	onAddAttachments?: (payload: {
		images?: string[];
		textAttachments?: WebTextAttachmentInput[];
	}) => void;
	/** Remove a staged image by index */
	onRemoveImage?: (index: number) => void;
	/** Remove a staged text attachment by id */
	onRemoveTextAttachment?: (attachmentId: string) => void;
	/** Whether demo capture is enabled for the next send */
	demoCaptureEnabled?: boolean;
	/** Toggle next-send demo capture */
	onToggleDemoCapture?: () => void;
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
	onHeightChange,
	stagedImages = [],
	stagedTextAttachments = [],
	onAddAttachments,
	onRemoveImage,
	onRemoveTextAttachment,
	demoCaptureEnabled = false,
	onToggleDemoCapture,
}: CommandInputBarProps) {
	const colors = useThemeColors();
	const textareaRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null) as React.MutableRefObject<
		HTMLTextAreaElement | HTMLInputElement | null
	>;
	const containerRef = useRef<HTMLDivElement>(null);
	const composerSurfaceRef = useRef<HTMLFormElement>(null);
	const modelMenuRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const actionsMenuRef = useRef<HTMLDivElement>(null);
	const setTextareaElementRef = useCallback((node: HTMLTextAreaElement | null) => {
		textareaRef.current = node;
	}, []);
	const setInputElementRef = useCallback((node: HTMLInputElement | null) => {
		textareaRef.current = node;
	}, []);

	// Mobile phone detection
	const isMobilePhone = useIsMobilePhone();

	// Mobile expanded input state (AI mode only)
	const [isExpanded, setIsExpanded] = useState(false);
	const [isInputFocused, setIsInputFocused] = useState(false);

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
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [stagedPreviewIndex, setStagedPreviewIndex] = useState<number | null>(null);
	const [actionsMenuOpen, setActionsMenuOpen] = useState(false);

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
		stopVoiceInput,
		stopVoiceInputAndSubmit,
		toggleVoiceInput: handleVoiceToggle,
	} = useVoiceInput({
		currentValue: value,
		disabled: isDisabled,
		onTranscriptionChange: handleVoiceTranscription,
		onTranscriptionSubmit: (newValue: string) => {
			const trimmedTranscript = newValue.trim();
			if (!trimmedTranscript) {
				return;
			}

			onSubmit?.(trimmedTranscript);

			if (controlledValue === undefined) {
				setInternalValue('');
			}

			onChange?.('');
			setIsInputFocused(false);
			if (isMobilePhone && inputMode === 'ai') {
				setIsExpanded(false);
			}
		},
		focusRef: textareaRef as React.RefObject<HTMLTextAreaElement | HTMLInputElement>,
	});

	// Separate flag for whether send is blocked (AI thinking)
	// When true, shows X button instead of send button
	const isSendBlocked = inputMode === 'ai' && isSessionBusy;
	const smartTypingEnabled = inputMode === 'ai';
	const trimmedValue = value.trim();
	const hasStagedAttachments = stagedImages.length > 0 || stagedTextAttachments.length > 0;
	const hasDraft = trimmedValue.length > 0 || hasStagedAttachments;
	const hasActiveVoiceControls =
		inputMode === 'ai' &&
		(voiceState === 'recording' || voiceState === 'requesting' || voiceState === 'transcribing');
	const hasActiveStagedPreview = stagedPreviewIndex !== null;
	const isActivelyComposing =
		inputMode === 'ai' && (isInputFocused || hasActiveVoiceControls || hasActiveStagedPreview);
	const isIdleCompactAiComposer = inputMode === 'ai' && isMobilePhone && !isActivelyComposing;
	const compactComposerMinHeight =
		inputMode === 'ai' ? (isActivelyComposing ? 96 : isMobilePhone ? 40 : 40) : MIN_INPUT_HEIGHT;
	const compactMaxTextareaHeight =
		isMobilePhone && inputMode === 'ai' && !isExpanded
			? COMPACT_MOBILE_MAX_TEXTAREA_HEIGHT
			: MAX_TEXTAREA_HEIGHT;
	const composerSurfaceStyle: React.CSSProperties = {
		background: `linear-gradient(180deg, ${colors.bgSidebar}f2 0%, ${colors.bgMain}f4 100%)`,
		backdropFilter: 'blur(22px)',
		WebkitBackdropFilter: 'blur(22px)',
		border: `1px solid ${colors.border}`,
		boxShadow: '0 -10px 28px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
	};
	const canStageAttachments = inputMode === 'ai' && !!onAddAttachments;
	const hasComposerActions = canStageAttachments || (inputMode === 'ai' && !!onToggleDemoCapture);

	// Get placeholder text based on state
	const getPlaceholder = () => {
		if (isOffline) return 'Offline...';
		if (!isConnected) return 'Connecting...';
		if (voiceState === 'requesting') return 'Waiting for microphone...';
		if (voiceState === 'recording') return 'Listening... stop to review or send now';
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
		const input = textareaRef.current;
		if (!input) return;

		if (input instanceof HTMLInputElement) {
			setTextareaHeight(compactComposerMinHeight);
			input.style.height = `${compactComposerMinHeight}px`;
			return;
		}

		// If value is empty, reset to minimum height immediately
		if (!value) {
			setTextareaHeight(compactComposerMinHeight);
			input.style.height = `${compactComposerMinHeight}px`;
			return;
		}

		// Reset height to minimum to get accurate scrollHeight measurement
		input.style.height = `${compactComposerMinHeight}px`;

		// Calculate the new height based on content
		const scrollHeight = input.scrollHeight;

		// Clamp height between minimum and maximum
		const newHeight = Math.min(
			Math.max(scrollHeight, compactComposerMinHeight),
			compactMaxTextareaHeight
		);

		setTextareaHeight(newHeight);
		input.style.height = `${newHeight}px`;
	}, [compactComposerMinHeight, compactMaxTextareaHeight, value]);

	/**
	 * Handle textarea change
	 * Also detects slash commands and shows autocomplete via hook
	 */
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
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

	const focusTextarea = useCallback((preventScroll = false) => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}

		textarea.focus(preventScroll ? { preventScroll: true } : undefined);
	}, []);

	/**
	 * Handle form submission
	 */
	const handleSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			if ((!value.trim() && !hasStagedAttachments) || isDisabled) return;

			// Trigger haptic feedback on successful send
			triggerHaptic(25);

			onSubmit?.(value.trim());

			// Clear input after submit (for uncontrolled mode)
			if (controlledValue === undefined) {
				setInternalValue('');
			}

			// Keep focus on textarea after submit without bouncing the viewport
			focusTextarea(true);
		},
		[value, isDisabled, onSubmit, controlledValue, focusTextarea, hasStagedAttachments]
	);

	/**
	 * Handle key press events
	 * Plain Enter submits in the compact composer.
	 * In expanded AI mode, Enter inserts a newline and the send button submits.
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				if (inputMode === 'ai' && isExpanded) {
					return;
				}
				e.preventDefault();
				handleSubmit(e);
			}
		},
		[handleSubmit, inputMode, isExpanded]
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
				setIsInputFocused(false);
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
			const frameId = window.requestAnimationFrame(() => {
				focusTextarea(true);
			});
			return () => window.cancelAnimationFrame(frameId);
		}
	}, [focusTextarea, inputMode, isExpanded, isMobilePhone]);

	/**
	 * Collapse input when submitting on mobile
	 */
	const handleMobileSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			if ((!value.trim() && !hasStagedAttachments) || isDisabled || isSendBlocked) return;

			// Trigger haptic feedback on successful send
			triggerHaptic(25);

			onSubmit?.(value.trim());

			// Clear input after submit (for uncontrolled mode)
			if (controlledValue === undefined) {
				setInternalValue('');
			}
			setIsInputFocused(false);

			// Collapse on mobile after submit
			if (isMobilePhone && inputMode === 'ai') {
				setIsExpanded(false);
			}

			// Keep focus on textarea after submit (unless mobile where we collapse)
			if (!isMobilePhone) {
				focusTextarea(true);
			}
		},
		[
			value,
			isDisabled,
			isSendBlocked,
			onSubmit,
			controlledValue,
			isMobilePhone,
			inputMode,
			focusTextarea,
			hasStagedAttachments,
		]
	);

	// Calculate textarea height for mobile expanded mode
	const mobileExpandedHeight =
		isMobilePhone && inputMode === 'ai' && isExpanded
			? `${MOBILE_EXPANDED_HEIGHT_VH}vh`
			: undefined;
	const showInlineVoiceAction =
		inputMode === 'ai' && !hasActiveVoiceControls && !isSendBlocked && !hasDraft && voiceSupported;
	const showInlineSendAction =
		inputMode === 'ai' &&
		!hasActiveVoiceControls &&
		(hasDraft || (isSendBlocked && isInputFocused));
	const showVoiceReviewAction =
		inputMode === 'ai' && (voiceState === 'recording' || voiceState === 'requesting');
	const showVoiceSendAction = inputMode === 'ai' && voiceState === 'recording';
	const showInlineModelSelector =
		inputMode === 'ai' &&
		supportsModelSelection &&
		(isActivelyComposing || modelMenuOpen) &&
		!showVoiceReviewAction;

	useEffect(() => {
		if (!attachmentError) {
			return;
		}

		const timer = window.setTimeout(() => {
			setAttachmentError(null);
		}, 3200);

		return () => window.clearTimeout(timer);
	}, [attachmentError]);

	useEffect(() => {
		if (stagedPreviewIndex === null) {
			return;
		}
		if (stagedImages.length === 0) {
			setStagedPreviewIndex(null);
			return;
		}
		if (stagedPreviewIndex >= stagedImages.length) {
			setStagedPreviewIndex(stagedImages.length - 1);
		}
	}, [stagedImages, stagedPreviewIndex]);

	const handleAttachmentPickerOpen = useCallback(() => {
		if (!canStageAttachments || isDisabled) {
			return;
		}
		fileInputRef.current?.click();
	}, [canStageAttachments, isDisabled]);

	const handleComposerActionsToggle = useCallback(() => {
		if (!hasComposerActions || isDisabled) {
			return;
		}
		setActionsMenuOpen((prev) => !prev);
	}, [hasComposerActions, isDisabled]);

	useEffect(() => {
		if (!actionsMenuOpen) {
			return;
		}

		const handlePointerDown = (event: MouseEvent | TouchEvent) => {
			const target = event.target as Node | null;
			if (!target || actionsMenuRef.current?.contains(target)) {
				return;
			}
			setActionsMenuOpen(false);
		};

		document.addEventListener('mousedown', handlePointerDown);
		document.addEventListener('touchstart', handlePointerDown);
		return () => {
			document.removeEventListener('mousedown', handlePointerDown);
			document.removeEventListener('touchstart', handlePointerDown);
		};
	}, [actionsMenuOpen]);

	const processAttachmentFiles = useCallback(
		async (files: File[]) => {
			if (!files.length || !onAddAttachments) {
				return false;
			}
			const nextImages: string[] = [];
			const nextTextAttachments: WebTextAttachmentInput[] = [];
			const rejectedNames: string[] = [];

			for (const file of files) {
				try {
					if (file.type.startsWith('image/')) {
						nextImages.push(await readFileAsDataUrl(file));
						continue;
					}

					if (!supportsTextAttachment(file)) {
						rejectedNames.push(file.name);
						continue;
					}

					if (file.size > TEXT_ATTACHMENT_MAX_BYTES) {
						rejectedNames.push(`${file.name} (too large)`);
						continue;
					}

					nextTextAttachments.push({
						id: createAttachmentId(),
						name: file.name,
						content: await readFileAsText(file),
						mimeType: file.type || undefined,
						size: file.size,
					});
				} catch {
					rejectedNames.push(file.name);
				}
			}

			if (nextImages.length > 0 || nextTextAttachments.length > 0) {
				onAddAttachments({
					images: nextImages.length > 0 ? nextImages : undefined,
					textAttachments: nextTextAttachments.length > 0 ? nextTextAttachments : undefined,
				});
				setIsInputFocused(true);
			}

			if (rejectedNames.length > 0) {
				setAttachmentError(`Couldn't attach: ${rejectedNames.slice(0, 2).join(', ')}`);
			} else {
				setAttachmentError(null);
			}
			return nextImages.length > 0 || nextTextAttachments.length > 0;
		},
		[onAddAttachments]
	);

	const handleAttachmentInputChange = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(e.target.files || []);
			e.target.value = '';
			await processAttachmentFiles(files);
		},
		[processAttachmentFiles]
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
			if (!canStageAttachments || !onAddAttachments) {
				return;
			}

			const clipboardItems = Array.from(e.clipboardData.items || []);
			const clipboardFiles = clipboardItems
				.filter((item) => item.kind === 'file')
				.map((item) => item.getAsFile())
				.filter((file): file is File => !!file);

			const files =
				clipboardFiles.length > 0 ? clipboardFiles : Array.from(e.clipboardData.files || []);
			if (files.length === 0) {
				return;
			}

			e.preventDefault();
			void processAttachmentFiles(files);
		},
		[canStageAttachments, onAddAttachments, processAttachmentFiles]
	);

	const attachmentPreview = (stagedImages.length > 0 || stagedTextAttachments.length > 0) && (
		<div
			style={{
				display: 'flex',
				gap: '8px',
				alignItems: 'flex-start',
				overflowX: 'auto',
				paddingBottom: '4px',
				scrollbarWidth: 'none',
			}}
		>
			{stagedImages.map((image, index) => (
				<div
					key={`image-${index}`}
					onMouseDown={(event) => handleStagedPreviewPress(index, event)}
					onTouchStart={(event) => handleStagedPreviewPress(index, event)}
					style={{
						position: 'relative',
						width: '56px',
						height: '56px',
						borderRadius: '16px',
						flexShrink: 0,
						overflow: 'hidden',
						border: `1px solid ${colors.border}`,
						boxShadow: '0 10px 18px rgba(15, 23, 42, 0.10)',
						cursor: 'zoom-in',
					}}
				>
					<img
						src={image}
						alt={`Attachment ${index + 1}`}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
							display: 'block',
						}}
					/>
					<button
						type="button"
						onMouseDown={(event) => {
							event.preventDefault();
							event.stopPropagation();
						}}
						onTouchStart={(event) => {
							event.preventDefault();
							event.stopPropagation();
						}}
						onClick={(event) => {
							event.stopPropagation();
							onRemoveImage?.(index);
						}}
						aria-label={`Remove image ${index + 1}`}
						style={{
							position: 'absolute',
							top: '4px',
							right: '4px',
							width: '22px',
							height: '22px',
							minWidth: '22px',
							minHeight: '22px',
							maxWidth: '22px',
							maxHeight: '22px',
							padding: 0,
							borderRadius: '999px',
							border: '1px solid rgba(255, 255, 255, 0.18)',
							background: 'rgba(15, 23, 42, 0.88)',
							color: '#fff',
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							flexShrink: 0,
							boxSizing: 'border-box',
							appearance: 'none',
							WebkitAppearance: 'none',
							lineHeight: 1,
							cursor: 'pointer',
							boxShadow: '0 4px 12px rgba(2, 6, 23, 0.22)',
						}}
					>
						<X size={12} />
					</button>
				</div>
			))}
			{stagedTextAttachments.map((attachment) => (
				<div
					key={attachment.id || attachment.name}
					style={{
						position: 'relative',
						display: 'inline-flex',
						alignItems: 'center',
						gap: '10px',
						padding: '10px 34px 10px 12px',
						minHeight: '56px',
						borderRadius: '18px',
						flexShrink: 0,
						background: 'rgba(255, 255, 255, 0.82)',
						border: `1px solid ${colors.border}`,
						boxShadow: '0 10px 18px rgba(15, 23, 42, 0.08)',
						maxWidth: '220px',
					}}
				>
					<div
						style={{
							width: '32px',
							height: '32px',
							borderRadius: '12px',
							background: `${colors.accent}14`,
							color: colors.accent,
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							flexShrink: 0,
						}}
					>
						<FileText size={16} />
					</div>
					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							gap: '2px',
							minWidth: 0,
						}}
					>
						<span
							style={{
								fontSize: '13px',
								fontWeight: 600,
								color: colors.textMain,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{attachment.name}
						</span>
						<span
							style={{
								fontSize: '11px',
								color: colors.textDim,
							}}
						>
							{attachment.size ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : 'File'}
						</span>
					</div>
					<button
						type="button"
						onClick={() => onRemoveTextAttachment?.(attachment.id || attachment.name)}
						aria-label={`Remove ${attachment.name}`}
						style={{
							position: 'absolute',
							top: '6px',
							right: '6px',
							width: '22px',
							height: '22px',
							borderRadius: '999px',
							border: 'none',
							background: 'rgba(148, 163, 184, 0.16)',
							color: colors.textDim,
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							cursor: 'pointer',
						}}
					>
						<X size={12} />
					</button>
				</div>
			))}
		</div>
	);

	const actionsMenu = actionsMenuOpen && (
		<div
			style={{
				position: 'absolute',
				bottom: 'calc(100% + 10px)',
				left: 0,
				minWidth: '196px',
				padding: '8px',
				borderRadius: '20px',
				border: `1px solid ${colors.border}`,
				background: `linear-gradient(180deg, ${colors.bgSidebar}fb 0%, ${colors.bgMain}f6 100%)`,
				boxShadow: '0 18px 32px rgba(15, 23, 42, 0.18)',
				backdropFilter: 'blur(20px)',
				WebkitBackdropFilter: 'blur(20px)',
				zIndex: 20,
			}}
		>
			{canStageAttachments && (
				<button
					type="button"
					onClick={() => {
						setActionsMenuOpen(false);
						handleAttachmentPickerOpen();
					}}
					style={{
						width: '100%',
						display: 'flex',
						alignItems: 'center',
						gap: '10px',
						padding: '11px 12px',
						border: 'none',
						borderRadius: '14px',
						background: 'transparent',
						color: colors.textMain,
						cursor: 'pointer',
						textAlign: 'left',
					}}
				>
					<Paperclip size={15} />
					<span style={{ fontSize: '13px', fontWeight: 600 }}>Attach photos or files</span>
				</button>
			)}
			{inputMode === 'ai' && onToggleDemoCapture && (
				<button
					type="button"
					onClick={() => {
						setActionsMenuOpen(false);
						onToggleDemoCapture();
					}}
					style={{
						width: '100%',
						display: 'flex',
						alignItems: 'center',
						gap: '10px',
						padding: '11px 12px',
						border: 'none',
						borderRadius: '14px',
						background: demoCaptureEnabled ? `${colors.accent}14` : 'transparent',
						color: demoCaptureEnabled ? colors.accent : colors.textMain,
						cursor: 'pointer',
						textAlign: 'left',
					}}
				>
					<FileText size={15} />
					<span style={{ fontSize: '13px', fontWeight: 600 }}>
						{demoCaptureEnabled ? 'Demo requested for next run' : 'Request demo/screenshots'}
					</span>
				</button>
			)}
		</div>
	);

	const closeStagedPreview = useCallback(() => {
		setStagedPreviewIndex(null);
	}, []);

	const handleStagedPreviewPress = useCallback(
		(index: number, event: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
			const target = event.target;
			if (target instanceof Element && target.closest('button')) {
				return;
			}

			event.preventDefault();
			setStagedPreviewIndex(index);
		},
		[]
	);

	const showPrevStagedPreview = useCallback(() => {
		setStagedPreviewIndex((prev) => {
			if (prev === null) {
				return prev;
			}
			return prev > 0 ? prev - 1 : prev;
		});
	}, []);

	const showNextStagedPreview = useCallback(() => {
		setStagedPreviewIndex((prev) => {
			if (prev === null) {
				return prev;
			}
			return prev < stagedImages.length - 1 ? prev + 1 : prev;
		});
	}, [stagedImages.length]);

	const stagedPreviewOverlay =
		stagedPreviewIndex !== null &&
		stagedImages[stagedPreviewIndex] &&
		typeof document !== 'undefined'
			? createPortal(
					<div
						style={{
							position: 'fixed',
							inset: 0,
							zIndex: 220,
							background: 'rgba(2, 6, 23, 0.88)',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding:
								'max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(28px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left))',
							boxSizing: 'border-box',
						}}
						onClick={closeStagedPreview}
					>
						<div
							onClick={(event) => event.stopPropagation()}
							style={{
								position: 'relative',
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								maxWidth: 'min(92vw, 960px)',
								maxHeight: 'calc(100vh - 56px)',
							}}
						>
							{stagedImages.length > 1 && (
								<>
									<button
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											showPrevStagedPreview();
										}}
										disabled={stagedPreviewIndex === 0}
										aria-label="Previous image"
										style={{
											position: 'absolute',
											left: '-10px',
											top: '50%',
											transform: 'translate(-100%, -50%)',
											width: '40px',
											height: '40px',
											borderRadius: '999px',
											border: '1px solid rgba(255, 255, 255, 0.16)',
											background: 'rgba(15, 23, 42, 0.55)',
											color: '#fff',
											fontSize: '22px',
											cursor: stagedPreviewIndex === 0 ? 'default' : 'pointer',
											opacity: stagedPreviewIndex === 0 ? 0.45 : 1,
										}}
									>
										‹
									</button>
									<button
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											showNextStagedPreview();
										}}
										disabled={stagedPreviewIndex >= stagedImages.length - 1}
										aria-label="Next image"
										style={{
											position: 'absolute',
											right: '-10px',
											top: '50%',
											transform: 'translate(100%, -50%)',
											width: '40px',
											height: '40px',
											borderRadius: '999px',
											border: '1px solid rgba(255, 255, 255, 0.16)',
											background: 'rgba(15, 23, 42, 0.55)',
											color: '#fff',
											fontSize: '22px',
											cursor: stagedPreviewIndex >= stagedImages.length - 1 ? 'default' : 'pointer',
											opacity: stagedPreviewIndex >= stagedImages.length - 1 ? 0.45 : 1,
										}}
									>
										›
									</button>
								</>
							)}
							<img
								src={stagedImages[stagedPreviewIndex]}
								alt="Staged attachment preview"
								style={{
									display: 'block',
									maxWidth: 'min(92vw, 960px)',
									maxHeight: 'calc(100vh - 96px)',
									borderRadius: '24px',
									objectFit: 'contain',
									boxShadow: '0 24px 64px rgba(0, 0, 0, 0.38)',
								}}
							/>
							<button
								type="button"
								onClick={closeStagedPreview}
								aria-label="Close image preview"
								style={{
									position: 'absolute',
									top: '10px',
									right: '10px',
									width: '36px',
									height: '36px',
									minWidth: '36px',
									minHeight: '36px',
									maxWidth: '36px',
									maxHeight: '36px',
									padding: 0,
									borderRadius: '999px',
									border: '1px solid rgba(255, 255, 255, 0.22)',
									background: 'rgba(15, 23, 42, 0.78)',
									color: '#fff',
									display: 'inline-flex',
									alignItems: 'center',
									justifyContent: 'center',
									flexShrink: 0,
									boxSizing: 'border-box',
									appearance: 'none',
									WebkitAppearance: 'none',
									lineHeight: 1,
									cursor: 'pointer',
									boxShadow: '0 10px 24px rgba(2, 6, 23, 0.24)',
								}}
							>
								<X size={16} />
							</button>
						</div>
					</div>,
					document.body
				)
			: null;

	useEffect(() => {
		if (!onHeightChange || !containerRef.current || typeof ResizeObserver === 'undefined') {
			return;
		}

		const element = containerRef.current;
		const publishHeight = () => {
			const containerRect = element.getBoundingClientRect();
			const surfaceRect = composerSurfaceRef.current?.getBoundingClientRect();
			if (!surfaceRect) {
				onHeightChange(Math.ceil(containerRect.height));
				return;
			}

			const bottomInset = Math.max(0, containerRect.bottom - surfaceRect.bottom);
			onHeightChange(Math.ceil(surfaceRect.height + bottomInset));
		};

		publishHeight();

		const observer = new ResizeObserver(() => {
			publishHeight();
		});
		observer.observe(element);
		if (composerSurfaceRef.current) {
			observer.observe(composerSurfaceRef.current);
		}

		return () => {
			observer.disconnect();
		};
	}, [
		onHeightChange,
		mobileExpandedHeight,
		voiceStatusText,
		modelMenuOpen,
		slashCommandOpen,
		textareaHeight,
	]);

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
				paddingBottom: isKeyboardVisible
					? '0'
					: 'max(6px, calc(env(safe-area-inset-bottom) - 10px))',
				paddingLeft: 'env(safe-area-inset-left)',
				paddingRight: 'env(safe-area-inset-right)',
				paddingTop: onHistoryOpen ? '4px' : '12px', // Reduced top padding when swipe handle is shown
				background: 'transparent',
				// Smooth transition when keyboard appears/disappears
				transition: isKeyboardVisible ? 'none' : 'bottom 0.15s ease-out, height 200ms ease-out',
				overscrollBehavior: 'none',
				willChange: 'bottom',
				transform: 'translateZ(0)',
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
							alignItems: 'center',
							justifyContent: 'space-between',
							gap: '12px',
							padding: '8px 10px',
							borderRadius: '14px',
							background: `${colors.bgMain}b8`,
							border: `1px solid ${colors.border}`,
						}}
					>
						<span
							style={{
								fontSize: '11px',
								fontWeight: 700,
								letterSpacing: '0.04em',
								textTransform: 'uppercase',
								color: colors.textDim,
							}}
						>
							Current
						</span>
						<span
							style={{
								fontSize: '13px',
								fontWeight: 600,
								color: colors.textMain,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{modelLabel}
						</span>
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

			<input
				ref={fileInputRef}
				type="file"
				multiple
				accept="image/*,.txt,.md,.markdown,.json,.yml,.yaml,.xml,.csv,.tsv,.toml,.ini,.cfg,.conf,.env,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.css,.scss,.html,.htm,.py,.rb,.go,.java,.sh,.bash,.zsh,.sql,.php,.rs,.swift,.kt"
				style={{ display: 'none' }}
				onChange={handleAttachmentInputChange}
			/>

			{/* EXPANDED MOBILE AI MODE - Full width textarea with send button below */}
			{mobileExpandedHeight ? (
				<form
					ref={composerSurfaceRef}
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
					{attachmentPreview}
					{attachmentError && (
						<div
							style={{
								fontSize: '12px',
								fontWeight: 600,
								color: colors.error,
								padding: '0 4px',
							}}
						>
							{attachmentError}
						</div>
					)}

					{hasComposerActions && (
						<div style={{ position: 'relative', alignSelf: 'flex-start' }} ref={actionsMenuRef}>
							<button
								type="button"
								onClick={handleComposerActionsToggle}
								disabled={isDisabled}
								style={{
									alignSelf: 'flex-start',
									display: 'inline-flex',
									alignItems: 'center',
									gap: '8px',
									padding: '10px 14px',
									borderRadius: '999px',
									border: `1px solid ${
										demoCaptureEnabled ? `${colors.accent}66` : colors.border
									}`,
									background: demoCaptureEnabled
										? `${colors.accent}14`
										: `${colors.bgMain}d6`,
									color: demoCaptureEnabled ? colors.accent : colors.textMain,
									cursor: isDisabled ? 'default' : 'pointer',
									opacity: isDisabled ? 0.55 : 1,
								}}
							>
								<Plus size={14} strokeWidth={2.3} />
								<span style={{ fontSize: '13px', fontWeight: 600 }}>Actions</span>
							</button>
							{actionsMenu}
						</div>
					)}

					{/* Full-width textarea */}
					<textarea
						ref={setTextareaElementRef}
						value={value}
						onChange={handleChange}
						onPaste={handlePaste}
						onKeyDown={handleKeyDown}
						placeholder={getPlaceholder()}
						disabled={isDisabled}
						autoComplete="off"
						autoCorrect={smartTypingEnabled ? 'on' : 'off'}
						autoCapitalize={smartTypingEnabled ? 'sentences' : 'off'}
						spellCheck={smartTypingEnabled}
						enterKeyHint="enter"
						rows={1}
						style={{
							flex: 1,
							width: '100%',
							padding: '16px 18px',
							borderRadius: '22px',
							backgroundColor: `${colors.bgMain}f0`,
							border: `1px solid ${colors.accent}33`,
							boxShadow: `0 0 0 3px ${colors.accent}12, inset 0 1px 0 rgba(255, 255, 255, 0.05)`,
							color: colors.textMain,
							fontSize: '17px',
							fontFamily: 'inherit',
							lineHeight: `${LINE_HEIGHT}px`,
							outline: 'none',
							minHeight: '120px',
							WebkitAppearance: 'none',
							appearance: 'none',
							resize: 'none',
							WebkitFontSmoothing: 'antialiased',
							MozOsxFontSmoothing: 'grayscale',
							WebkitTouchCallout: 'default',
							WebkitUserSelect: 'text',
							userSelect: 'text',
							caretColor: colors.accent,
							overflowY: 'auto',
							overflowX: 'hidden',
							wordWrap: 'break-word',
						}}
						onFocus={() => {
							setIsInputFocused(true);
						}}
						onBlur={(_e) => {
							setIsInputFocused(false);
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

					<div
						style={{
							fontSize: '12px',
							color: colors.textDim,
							padding: '0 4px',
						}}
					>
						Enter adds a new line here. Use Send when you are ready.
					</div>

					{/* Full-width send button below textarea */}
					<ExpandedModeSendInterruptButton
						isInterruptMode={inputMode === 'ai' && isSessionBusy}
						isSendDisabled={isDisabled || !hasDraft}
						onInterrupt={handleInterrupt}
					/>
				</form>
			) : (
				/* NORMAL MODE - Original layout with side buttons */
				<form
					ref={composerSurfaceRef}
					onSubmit={handleMobileSubmit}
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '6px',
						alignItems: 'stretch',
						padding: isIdleCompactAiComposer ? '7px 10px 9px' : '8px 10px 10px',
						// Ensure form doesn't overflow screen width
						maxWidth: '100%',
						overflow: 'hidden',
						margin: '0 12px',
						borderRadius: isIdleCompactAiComposer ? '26px' : '22px',
						background:
							'linear-gradient(180deg, rgba(255, 255, 255, 0.86) 0%, rgba(255, 255, 255, 0.78) 100%)',
						border: '1px solid rgba(148, 163, 184, 0.26)',
						boxShadow:
							'0 -12px 28px rgba(15, 23, 42, 0.16), 0 8px 20px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.42)',
						...composerSurfaceStyle,
					}}
				>
					{attachmentPreview}
					{attachmentError && (
						<div
							style={{
								fontSize: '12px',
								fontWeight: 600,
								color: colors.error,
								padding: '0 2px 2px',
							}}
						>
							{attachmentError}
						</div>
					)}

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
							alignItems: 'center',
							maxWidth: '100%',
							overflow: 'hidden',
						}}
					>
						{hasComposerActions && (
							<div style={{ position: 'relative', flexShrink: 0 }} ref={actionsMenuRef}>
								<button
									type="button"
									onClick={handleComposerActionsToggle}
									disabled={isDisabled}
									aria-label="Open composer actions"
									style={{
										width: '34px',
										height: '34px',
										minWidth: '34px',
										minHeight: '34px',
										maxWidth: '34px',
										maxHeight: '34px',
										padding: 0,
										borderRadius: '999px',
										border: `1px solid ${
											demoCaptureEnabled ||
											stagedImages.length > 0 ||
											stagedTextAttachments.length > 0
												? `${colors.accent}66`
												: colors.border
										}`,
										background:
											demoCaptureEnabled ||
											stagedImages.length > 0 ||
											stagedTextAttachments.length > 0
												? `${colors.accent}14`
												: `${colors.bgMain}c8`,
										color:
											demoCaptureEnabled ||
											stagedImages.length > 0 ||
											stagedTextAttachments.length > 0
												? colors.accent
												: colors.textDim,
										display: 'inline-flex',
										alignItems: 'center',
										justifyContent: 'center',
										boxSizing: 'border-box',
										appearance: 'none',
										WebkitAppearance: 'none',
										cursor: isDisabled ? 'default' : 'pointer',
										opacity: isDisabled ? 0.5 : 1,
										boxShadow:
											'0 6px 14px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
										flexShrink: 0,
									}}
								>
									<Plus size={17} strokeWidth={2.3} />
								</button>
								{actionsMenu}
							</div>
						)}
						<div
							style={{
								flex: 1,
								minWidth: 0,
								position: 'relative',
								overflow: 'visible',
								'--maestro-placeholder-color': isInputFocused
									? `${colors.textDim}d9`
									: `${colors.textDim}b8`,
								transition:
									'border-color 150ms ease, box-shadow 150ms ease, background-color 150ms ease',
								padding: isIdleCompactAiComposer ? '0' : '3px',
								borderRadius: '20px',
								border: `1px solid ${isInputFocused ? `${colors.accent}66` : `${colors.border}cc`}`,
								background: isInputFocused
									? 'linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 0.94) 100%)'
									: 'linear-gradient(180deg, rgba(255, 255, 255, 0.95) 0%, rgba(241, 245, 249, 0.88) 100%)',
								boxShadow: isInputFocused
									? `0 0 0 3px ${colors.accent}1f, 0 14px 28px rgba(15, 23, 42, 0.14)`
									: '0 10px 22px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.6)',
							} as React.CSSProperties & Record<'--maestro-placeholder-color', string>}
						>
							{isIdleCompactAiComposer ? (
								<input
									className="maestro-mobile-message-input"
									ref={setInputElementRef}
									type="text"
									value={value}
									onChange={handleChange}
									onPaste={handlePaste}
									onKeyDown={handleKeyDown}
									placeholder={getPlaceholder()}
									disabled={isDisabled || isTranscribing}
									autoComplete="off"
									autoCorrect={smartTypingEnabled ? 'on' : 'off'}
									autoCapitalize={smartTypingEnabled ? 'sentences' : 'off'}
									spellCheck={smartTypingEnabled}
									enterKeyHint="send"
									style={{
										flex: 1,
										width: '100%',
										padding: '0 48px 0 12px',
										borderRadius: '17px',
										backgroundColor: 'transparent',
										border: 'none',
										color: colors.textMain,
										fontSize: '17px',
										fontFamily: 'inherit',
										lineHeight: '40px',
										outline: 'none',
										height: '40px',
										minHeight: '40px',
										maxHeight: '40px',
										WebkitAppearance: 'none',
										appearance: 'none',
										boxSizing: 'border-box',
										WebkitFontSmoothing: 'antialiased',
										MozOsxFontSmoothing: 'grayscale',
										WebkitTouchCallout: 'default',
										WebkitUserSelect: 'text',
										userSelect: 'text',
										caretColor: colors.accent,
									}}
									onFocus={() => {
										setIsInputFocused(true);
										handleMobileAIFocus();
									}}
									onBlur={() => {
										setIsInputFocused(false);
										onInputBlur?.();
									}}
									aria-label="Message input. Type slash commands directly if needed."
								/>
							) : (
								<textarea
									className="maestro-mobile-message-input"
									ref={setTextareaElementRef}
									value={value}
									onChange={handleChange}
									onPaste={handlePaste}
									onKeyDown={handleKeyDown}
									placeholder={getPlaceholder()}
									disabled={isDisabled || isTranscribing}
									autoComplete="off"
									autoCorrect={smartTypingEnabled ? 'on' : 'off'}
									autoCapitalize={smartTypingEnabled ? 'sentences' : 'off'}
									spellCheck={smartTypingEnabled}
									enterKeyHint="send"
									rows={1}
									style={{
										flex: 1,
										width: '100%',
										padding:
											inputMode === 'ai'
												? isMobilePhone
													? isActivelyComposing
														? '16px 64px 16px 14px'
														: '0 46px 0 4px'
													: isActivelyComposing
														? canStageAttachments
															? '16px 66px 16px 52px'
															: '16px 66px 16px 16px'
														: canStageAttachments
															? '6px 66px 6px 52px'
															: '6px 66px 6px 16px'
												: isMobilePhone
													? '11px 14px'
													: '12px 16px',
										borderRadius: '17px',
										backgroundColor: 'transparent',
										border: 'none',
										color: colors.textMain,
										fontSize: isMobilePhone ? '17px' : '16px',
										fontFamily: 'inherit',
										lineHeight: `${LINE_HEIGHT}px`,
										outline: 'none',
										height: `${textareaHeight}px`,
										minHeight: `${inputMode === 'ai' ? compactComposerMinHeight : 44}px`,
										maxHeight: `${compactMaxTextareaHeight}px`,
										WebkitAppearance: 'none',
										appearance: 'none',
										boxSizing: 'border-box',
										resize: 'none',
										transition: 'height 100ms ease-out',
										WebkitFontSmoothing: 'antialiased',
										MozOsxFontSmoothing: 'grayscale',
										WebkitTouchCallout: 'default',
										WebkitUserSelect: 'text',
										userSelect: 'text',
										caretColor: colors.accent,
										overflowY: textareaHeight >= compactMaxTextareaHeight ? 'auto' : 'hidden',
										overflowX: 'hidden',
										wordWrap: 'break-word',
									}}
									onFocus={() => {
										setIsInputFocused(true);
										handleMobileAIFocus();
									}}
									onBlur={() => {
										setIsInputFocused(false);
										onInputBlur?.();
									}}
									aria-label="Message input. Type slash commands directly if needed."
									aria-multiline="true"
								/>
							)}

							{inputMode === 'ai' &&
								(showInlineModelSelector ||
									showInlineVoiceAction ||
									showInlineSendAction ||
									showVoiceReviewAction ||
									showVoiceSendAction) && (
									<div
										style={{
											position: 'absolute',
											right: '8px',
											top: '50%',
											transform: 'translateY(-50%)',
											display: 'flex',
											flexDirection: 'column',
											alignItems: 'center',
											justifyContent: 'center',
											width: showInlineModelSelector ? '34px' : '34px',
											gap: showInlineModelSelector || showVoiceReviewAction ? '6px' : '0',
										}}
									>
										{showVoiceReviewAction ? (
											<SendInterruptButton
												isInterruptMode
												isSendDisabled={false}
												onInterrupt={stopVoiceInput}
												variant="inline"
												interruptAriaLabel="Stop recording and review transcript"
											/>
										) : showInlineModelSelector ? (
											<ModelSelectorButton
												label={modelLabel}
												toolType={modelToolType}
												onClick={() => void handleModelMenuToggle()}
												disabled={isDisabled || !hasActiveSession || isTranscribing}
												isOpen={modelMenuOpen}
												iconOnly
											/>
										) : null}
										{showVoiceSendAction ? (
											<SendInterruptButton
												isInterruptMode={false}
												isSendDisabled={false}
												onInterrupt={handleInterrupt}
												onSend={stopVoiceInputAndSubmit}
												variant="inline"
												sendAriaLabel="Stop recording and send transcript"
											/>
										) : showInlineSendAction ? (
											<SendInterruptButton
												isInterruptMode={isSendBlocked}
												isSendDisabled={isDisabled || isTranscribing || !hasDraft}
												onInterrupt={handleInterrupt}
												variant="inline"
											/>
										) : (
											<VoiceInputButton
												isListening={isListening}
												isRequesting={voiceState === 'requesting'}
												isTranscribing={isTranscribing}
												statusText={voiceStatusText}
												onToggle={handleVoiceToggle}
												disabled={isDisabled || isTranscribing}
												variant="inline"
											/>
										)}
									</div>
								)}
						</div>

						{inputMode !== 'ai' && (
							<SendInterruptButton
								isInterruptMode={false}
								isSendDisabled={isDisabled || isTranscribing || !hasDraft}
								onInterrupt={handleInterrupt}
							/>
						)}
					</div>
				</form>
			)}

			{stagedPreviewOverlay}
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

					.maestro-mobile-message-input::placeholder {
						color: var(--maestro-placeholder-color);
						opacity: 1;
					}
	        `}
			</style>
		</div>
	);
}

export default CommandInputBar;
