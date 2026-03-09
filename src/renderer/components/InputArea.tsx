import React, { useEffect, useMemo, useRef, useState, startTransition } from 'react';
import {
	Terminal,
	Cpu,
	Keyboard,
	ImageIcon,
	X,
	ArrowUp,
	Eye,
	History,
	File,
	Folder,
	GitBranch,
	Tag,
	PenLine,
	Brain,
	Wand2,
	Pin,
	Sparkles,
	FileEdit,
	Bot,
	ConciergeBell,
	ChevronDown,
	Zap,
} from 'lucide-react';
import type {
	Session,
	Theme,
	BatchRunState,
	Shortcut,
	ThinkingMode,
	ThinkingItem,
	ReasoningEffort,
	AgentExecutionMode,
} from '../types';
import {
	formatShortcutKeys,
	formatEnterToSend,
	formatEnterToSendTooltip,
} from '../utils/shortcutFormatter';
import type { TabCompletionSuggestion, TabCompletionFilter } from '../hooks';
import type {
	SummarizeProgress,
	SummarizeResult,
	GroomingProgress,
	MergeResult,
} from '../types/contextMerge';
import { ThinkingStatusPill } from './ThinkingStatusPill';
import { MergeProgressOverlay } from './MergeProgressOverlay';
import { ExecutionQueueIndicator } from './ExecutionQueueIndicator';
import { ContextWarningSash } from './ContextWarningSash';
import { SummarizeProgressOverlay } from './SummarizeProgressOverlay';
import { WizardInputPanel } from './InlineWizard';
import { useAgentCapabilities, useScrollIntoView } from '../hooks';
import { getProviderDisplayName } from '../utils/sessionValidation';
import { useSessionStore } from '../stores/sessionStore';

interface SlashCommand {
	command: string;
	description: string;
	terminalOnly?: boolean;
	aiOnly?: boolean;
}

interface InputAreaProps {
	session: Session;
	theme: Theme;
	inputValue: string;
	setInputValue: (value: string) => void;
	enterToSend: boolean;
	setEnterToSend: (value: boolean) => void;
	stagedImages: string[];
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	commandHistoryOpen: boolean;
	setCommandHistoryOpen: (open: boolean) => void;
	commandHistoryFilter: string;
	setCommandHistoryFilter: (filter: string) => void;
	commandHistorySelectedIndex: number;
	setCommandHistorySelectedIndex: (index: number) => void;
	slashCommandOpen: boolean;
	setSlashCommandOpen: (open: boolean) => void;
	slashCommands: SlashCommand[];
	selectedSlashCommandIndex: number;
	setSelectedSlashCommandIndex: (index: number) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
	toggleInputMode: () => void;
	processInput: () => void;
	handleInterrupt: () => void;
	onInputFocus: () => void;
	onInputBlur?: () => void;
	// Auto mode props
	isAutoModeActive?: boolean;
	// Tab completion props
	tabCompletionOpen?: boolean;
	setTabCompletionOpen?: (open: boolean) => void;
	tabCompletionSuggestions?: TabCompletionSuggestion[];
	selectedTabCompletionIndex?: number;
	setSelectedTabCompletionIndex?: (index: number) => void;
	tabCompletionFilter?: TabCompletionFilter;
	setTabCompletionFilter?: (filter: TabCompletionFilter) => void;
	// @ mention completion props (AI mode only)
	atMentionOpen?: boolean;
	setAtMentionOpen?: (open: boolean) => void;
	atMentionFilter?: string;
	setAtMentionFilter?: (filter: string) => void;
	atMentionStartIndex?: number;
	setAtMentionStartIndex?: (index: number) => void;
	atMentionSuggestions?: Array<{
		value: string;
		type: 'file' | 'folder';
		displayText: string;
		fullPath: string;
		source?: 'project' | 'autorun';
	}>;
	selectedAtMentionIndex?: number;
	setSelectedAtMentionIndex?: (index: number) => void;
	// ThinkingStatusPill props - PERF: receive pre-filtered thinkingItems instead of full sessions
	// This prevents re-renders when unrelated session updates occur (e.g., terminal output)
	thinkingItems?: ThinkingItem[];
	namedSessions?: Record<string, string>;
	onSessionClick?: (sessionId: string, tabId?: string) => void;
	autoRunState?: BatchRunState;
	onStopAutoRun?: () => void;
	// ExecutionQueueIndicator props
	onOpenQueueBrowser?: () => void;
	// Read-only mode toggle (per-tab)
	tabReadOnlyMode?: boolean;
	onToggleTabReadOnlyMode?: () => void;
	tabExecutionMode?: AgentExecutionMode;
	onSetTabExecutionMode?: (mode: AgentExecutionMode) => void;
	// Prompt composer modal
	onOpenPromptComposer?: () => void;
	// Shortcuts for displaying keyboard hints
	shortcuts?: Record<string, Shortcut>;
	// Flash notification callback
	showFlashNotification?: (message: string) => void;
	// Reasoning view toggle (per-tab) - three states: 'off' | 'on' | 'sticky'
	tabShowThinking?: ThinkingMode;
	onToggleTabShowThinking?: () => void;
	supportsThinking?: boolean; // From agent capabilities
	tabReasoningEffort?: ReasoningEffort;
	onSetTabReasoningEffort?: (effort: ReasoningEffort) => void;
	supportsReasoningEffort?: boolean;
	// Context warning sash props (Phase 6)
	contextUsage?: number; // 0-100 percentage
	contextWarningsEnabled?: boolean;
	contextWarningYellowThreshold?: number;
	contextWarningRedThreshold?: number;
	onSummarizeAndContinue?: () => void;
	// Summarization progress props (non-blocking, per-tab)
	summarizeProgress?: SummarizeProgress | null;
	summarizeResult?: SummarizeResult | null;
	summarizeStartTime?: number;
	isSummarizing?: boolean;
	onCancelSummarize?: () => void;
	// Merge progress props (non-blocking, per-tab)
	mergeProgress?: GroomingProgress | null;
	mergeResult?: MergeResult | null;
	mergeStartTime?: number;
	isMerging?: boolean;
	mergeSourceName?: string;
	mergeTargetName?: string;
	onCancelMerge?: () => void;
	// Inline wizard mode props
	onExitWizard?: () => void;
	// Wizard thinking toggle
	wizardShowThinking?: boolean;
	onToggleWizardShowThinking?: () => void;
}

function normalizeModelLabel(model: string | null | undefined): string | null {
	const normalized = model?.trim();
	if (!normalized) return null;
	if (normalized.toLowerCase() === 'default') return null;
	return normalized;
}

function hasSupportedProviderIcon(toolType?: Session['toolType'] | null): boolean {
	return (
		toolType === 'codex' ||
		toolType === 'claude-code' ||
		toolType === 'opencode' ||
		toolType === 'factory-droid' ||
		toolType === 'terminal'
	);
}

function ProviderModelIcon({
	toolType,
	color,
}: {
	toolType?: Session['toolType'] | null;
	color: string;
}) {
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

function ModelSelectorButton({
	label,
	toolType,
	theme,
	onClick,
	disabled,
	isOpen,
}: {
	label: string;
	toolType?: Session['toolType'] | null;
	theme: Theme;
	onClick: () => void;
	disabled: boolean;
	isOpen: boolean;
}) {
	const iconColor = isOpen ? theme.colors.accent : theme.colors.textMain;
	const showProviderIcon = hasSupportedProviderIcon(toolType);

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			style={{
				padding: '0 10px',
				borderRadius: '9999px',
				cursor: disabled ? 'default' : 'pointer',
				width: 'auto',
				minWidth: '56px',
				maxWidth: '110px',
				height: '28px',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				gap: '5px',
				transition: 'all 150ms ease',
				flexShrink: 0,
				WebkitTapHighlightColor: 'transparent',
				backgroundColor: isOpen ? `${theme.colors.accent}12` : 'transparent',
				border: `1px solid ${isOpen ? `${theme.colors.accent}55` : theme.colors.border}`,
				color: isOpen ? theme.colors.accent : theme.colors.textMain,
				opacity: disabled ? 0.5 : 1,
			}}
			title={`Model: ${label}`}
			aria-label={`Choose model. Current model: ${label}`}
			aria-expanded={isOpen}
		>
			{showProviderIcon && (
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
			)}
			<span
				style={{
					fontSize: '10px',
					fontWeight: 600,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
					lineHeight: 1,
				}}
			>
				{label}
			</span>
		</button>
	);
}

const inlineToolbarPillBaseStyle: React.CSSProperties = {
	height: '28px',
	padding: '0 10px',
	borderRadius: '9999px',
	display: 'inline-flex',
	alignItems: 'center',
	flexShrink: 0,
};

export const InputArea = React.memo(function InputArea(props: InputAreaProps) {
	const {
		session,
		theme,
		inputValue,
		setInputValue,
		enterToSend,
		setEnterToSend,
		stagedImages,
		setStagedImages,
		setLightboxImage,
		commandHistoryOpen,
		setCommandHistoryOpen,
		commandHistoryFilter,
		setCommandHistoryFilter,
		commandHistorySelectedIndex,
		setCommandHistorySelectedIndex,
		slashCommandOpen,
		setSlashCommandOpen,
		slashCommands,
		selectedSlashCommandIndex,
		setSelectedSlashCommandIndex,
		inputRef,
		handleInputKeyDown,
		handlePaste,
		handleDrop,
		toggleInputMode,
		processInput,
		handleInterrupt,
		onInputFocus,
		onInputBlur,
		isAutoModeActive = false,
		tabCompletionOpen = false,
		setTabCompletionOpen,
		tabCompletionSuggestions = [],
		selectedTabCompletionIndex = 0,
		setSelectedTabCompletionIndex,
		tabCompletionFilter = 'all',
		setTabCompletionFilter,
		atMentionOpen = false,
		setAtMentionOpen,
		atMentionFilter = '',
		setAtMentionFilter,
		atMentionStartIndex = -1,
		setAtMentionStartIndex,
		atMentionSuggestions = [],
		selectedAtMentionIndex = 0,
		setSelectedAtMentionIndex,
		thinkingItems = [],
		namedSessions,
		onSessionClick,
		autoRunState,
		onStopAutoRun,
		onOpenQueueBrowser,
		tabReadOnlyMode = false,
		onToggleTabReadOnlyMode,
		tabExecutionMode,
		onSetTabExecutionMode,
		onOpenPromptComposer,
		shortcuts,
		showFlashNotification,
		tabShowThinking = 'off',
		onToggleTabShowThinking,
		supportsThinking = false,
		tabReasoningEffort = 'default',
		onSetTabReasoningEffort,
		supportsReasoningEffort = false,
		// Context warning sash props (Phase 6)
		contextUsage = 0,
		contextWarningsEnabled = false,
		contextWarningYellowThreshold = 60,
		contextWarningRedThreshold = 80,
		onSummarizeAndContinue,
		// Summarization progress props
		summarizeProgress,
		summarizeResult,
		summarizeStartTime = 0,
		isSummarizing = false,
		onCancelSummarize,
		// Merge progress props
		mergeProgress,
		mergeResult,
		mergeStartTime = 0,
		isMerging = false,
		mergeSourceName,
		mergeTargetName,
		onCancelMerge,
		// Inline wizard mode props
		onExitWizard,
		// Wizard thinking toggle
		wizardShowThinking = false,
		onToggleWizardShowThinking,
	} = props;

	// Keep "Effort" display concrete (no "default" label in UI).
	// When no tab override exists, show the inherited baseline as High.
	const effectiveReasoningEffortForDisplay = useMemo<Exclude<ReasoningEffort, 'default'>>(() => {
		if (
			tabReasoningEffort === 'low' ||
			tabReasoningEffort === 'medium' ||
			tabReasoningEffort === 'high' ||
			tabReasoningEffort === 'xhigh'
		) {
			return tabReasoningEffort;
		}
		return 'high';
	}, [tabReasoningEffort]);

	const setCommandHistoryFilterRef = React.useCallback((el: HTMLInputElement | null) => {
		if (el) {
			el.focus();
		}
	}, []);

	// Get agent capabilities for conditional feature rendering
	const { hasCapability } = useAgentCapabilities(session.toolType);

	type InteractionMode = 'plan' | 'ask' | 'agent';
	const supportsInteractionModes =
		session.inputMode === 'ai' && hasCapability('supportsReadOnlyMode') && !!onSetTabExecutionMode;
	const activeTab = useMemo(
		() => session.aiTabs?.find((tab) => tab.id === session.activeTabId),
		[session.aiTabs, session.activeTabId]
	);
	const interactionMode = useMemo<InteractionMode>(() => {
		if (tabExecutionMode === 'ask' || tabExecutionMode === 'plan' || tabExecutionMode === 'agent') {
			return tabExecutionMode;
		}
		if (!tabReadOnlyMode) return 'agent';
		return 'ask';
	}, [tabExecutionMode, tabReadOnlyMode]);
	const setInteractionMode = React.useCallback(
		(mode: InteractionMode) => {
			if (!supportsInteractionModes) return;
			onSetTabExecutionMode?.(mode);
		},
		[supportsInteractionModes, onSetTabExecutionMode]
	);
	const [modeMenuOpen, setModeMenuOpen] = useState(false);
	const [effortMenuOpen, setEffortMenuOpen] = useState(false);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const modeMenuRef = useRef<HTMLDivElement | null>(null);
	const effortMenuRef = useRef<HTMLDivElement | null>(null);
	const modelMenuRef = useRef<HTMLDivElement | null>(null);
	const updateSession = useSessionStore((state) => state.updateSession);
	const demoCaptureRequested =
		session.inputMode === 'ai' && activeTab?.demoCaptureRequested === true;
	const toggleDemoCapture = React.useCallback(() => {
		if (session.inputMode !== 'ai' || !activeTab) return;
		updateSession(session.id, {
			aiTabs: session.aiTabs.map((tab) =>
				tab.id === activeTab.id ? { ...tab, demoCaptureRequested: !tab.demoCaptureRequested } : tab
			),
		});
	}, [activeTab, session.aiTabs, session.id, session.inputMode, updateSession]);

	const modeOptions = useMemo(
		() => [
			{
				id: 'plan' as const,
				label: 'Plan',
				icon: FileEdit,
				description: 'Read-only. Produces a documented execution plan.',
			},
			{
				id: 'ask' as const,
				label: 'Ask',
				icon: ConciergeBell,
				description: 'Read-only Q&A. Does not change files.',
			},
			{
				id: 'agent' as const,
				label: 'Agent',
				icon: Bot,
				description: 'Full editing mode. Can modify files.',
			},
		],
		[]
	);
	const selectedModeOption = useMemo(
		() => modeOptions.find((option) => option.id === interactionMode) ?? modeOptions[2],
		[modeOptions, interactionMode]
	);
	const effortOptions = useMemo(
		() => [
			{
				id: 'low' as const,
				label: 'Low',
				icon: Brain,
			},
			{
				id: 'medium' as const,
				label: 'Medium',
				icon: Cpu,
			},
			{
				id: 'high' as const,
				label: 'High',
				icon: Zap,
			},
			{
				id: 'xhigh' as const,
				label: 'Extra High',
				icon: Sparkles,
			},
		],
		[]
	);
	const selectedEffortOption = useMemo(
		() =>
			effortOptions.find((option) => option.id === effectiveReasoningEffortForDisplay) ??
			effortOptions[2],
		[effortOptions, effectiveReasoningEffortForDisplay]
	);
	const supportsModelSelection =
		session.inputMode === 'ai' && hasCapability('supportsModelSelection');
	const effectiveSshRemoteId = useMemo(
		() =>
			session.sshRemoteId ||
			(session.sessionSshRemoteConfig?.enabled
				? session.sessionSshRemoteConfig.remoteId || undefined
				: undefined),
		[
			session.sshRemoteId,
			session.sessionSshRemoteConfig?.enabled,
			session.sessionSshRemoteConfig?.remoteId,
		]
	);
	const effectiveModelLabel = useMemo(() => {
		return (
			normalizeModelLabel(activeTab?.currentModel) ||
			normalizeModelLabel(session.customModel) ||
			'Model'
		);
	}, [activeTab?.currentModel, session.customModel]);
	const loadModels = React.useCallback(
		async (forceRefresh = false) => {
			if (!supportsModelSelection) return;
			setLoadingModels(true);
			try {
				const models = await window.maestro.agents.getModels(
					session.toolType,
					forceRefresh,
					effectiveSshRemoteId
				);
				setAvailableModels(models || []);
			} catch (error) {
				console.error('Failed to load models:', error);
				setAvailableModels([]);
			} finally {
				setLoadingModels(false);
			}
		},
		[effectiveSshRemoteId, session.toolType, supportsModelSelection]
	);
	const applyModelSelection = React.useCallback(
		(value: string | null) => {
			const trimmedValue = value?.trim() ?? '';
			updateSession(session.id, { customModel: trimmedValue || undefined });
			setModelMenuOpen(false);
		},
		[session.id, updateSession]
	);
	const selectableModels = useMemo(() => {
		const normalizedCurrentModel = effectiveModelLabel.trim();
		const models = [...availableModels];
		if (
			normalizedCurrentModel &&
			normalizedCurrentModel !== 'Model' &&
			!models.includes(normalizedCurrentModel)
		) {
			models.unshift(normalizedCurrentModel);
		}
		return models;
	}, [availableModels, effectiveModelLabel]);
	const handleModelMenuToggle = React.useCallback(async () => {
		if (!supportsModelSelection) {
			return;
		}

		const nextOpen = !modelMenuOpen;
		setModelMenuOpen(nextOpen);
		if (!nextOpen) {
			return;
		}

		await loadModels(false);
	}, [loadModels, modelMenuOpen, supportsModelSelection]);
	const handleRefreshModels = React.useCallback(async () => {
		await loadModels(true);
	}, [loadModels]);

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			if (modeMenuRef.current && !modeMenuRef.current.contains(target)) {
				setModeMenuOpen(false);
			}
			if (effortMenuRef.current && !effortMenuRef.current.contains(target)) {
				setEffortMenuOpen(false);
			}
			if (modelMenuRef.current && !modelMenuRef.current.contains(target)) {
				setModelMenuOpen(false);
			}
		};

		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, []);

	// Get wizardState from active tab (not session level - wizard state is per-tab)
	const wizardState = activeTab?.wizardState;

	// PERF: Memoize derived state to avoid recalculation on every render
	const isResumingSession = !!activeTab?.agentSessionId;
	const canAttachImages = useMemo(() => {
		// Check if images are supported - depends on whether we're resuming an existing session
		// If the active tab has an agentSessionId, we're resuming and need to check supportsImageInputOnResume
		return isResumingSession
			? hasCapability('supportsImageInputOnResume')
			: hasCapability('supportsImageInput');
	}, [isResumingSession, hasCapability]);

	// PERF: Memoize mode-related derived state
	const isReadOnlyMode = useMemo(() => {
		// Check if we're in read-only mode (manual toggle only - Claude will be in plan mode)
		return !!tabReadOnlyMode && session.inputMode === 'ai';
	}, [tabReadOnlyMode, session.inputMode]);

	// Filter slash commands based on input and current mode
	const isTerminalMode = session.inputMode === 'terminal';

	// thinkingItems is now passed directly from App.tsx (pre-filtered) for better performance

	// Get the appropriate command history based on current mode
	// Fall back to legacy commandHistory for sessions created before the split
	const legacyHistory: string[] = (session as any).commandHistory || [];
	const shellHistory: string[] = session.shellCommandHistory || [];
	const aiHistory: string[] = session.aiCommandHistory || [];
	const currentCommandHistory: string[] = isTerminalMode
		? shellHistory.length > 0
			? shellHistory
			: legacyHistory
		: aiHistory.length > 0
			? aiHistory
			: legacyHistory;

	// Use the slash commands passed from App.tsx (already includes custom + Claude commands)
	// PERF: Memoize both the lowercase conversion and filtered results to avoid
	// recalculating on every render - inputValue changes on every keystroke
	const inputValueLower = useMemo(() => inputValue.toLowerCase(), [inputValue]);
	const filteredSlashCommands = useMemo(() => {
		return slashCommands.filter((cmd) => {
			// Check if command is only available in terminal mode
			if (cmd.terminalOnly && !isTerminalMode) return false;
			// Check if command is only available in AI mode
			if (cmd.aiOnly && isTerminalMode) return false;
			// Check if command matches input
			return cmd.command.toLowerCase().startsWith(inputValueLower);
		});
	}, [slashCommands, isTerminalMode, inputValueLower]);

	// Ensure selectedSlashCommandIndex is valid for the filtered list
	const safeSelectedIndex = Math.min(
		Math.max(0, selectedSlashCommandIndex),
		Math.max(0, filteredSlashCommands.length - 1)
	);

	// Use scroll-into-view hooks for all dropdown lists
	const slashCommandItemRefs = useScrollIntoView<HTMLButtonElement>(
		slashCommandOpen,
		safeSelectedIndex,
		filteredSlashCommands.length
	);
	const tabCompletionItemRefs = useScrollIntoView<HTMLButtonElement>(
		tabCompletionOpen,
		selectedTabCompletionIndex,
		tabCompletionSuggestions.length
	);
	const atMentionItemRefs = useScrollIntoView<HTMLButtonElement>(
		atMentionOpen,
		selectedAtMentionIndex,
		atMentionSuggestions.length
	);

	// Memoize command history filtering to avoid expensive Set operations on every keystroke
	const commandHistoryFilterLower = commandHistoryFilter.toLowerCase();
	const filteredCommandHistory = useMemo(() => {
		const uniqueHistory = Array.from(new Set(currentCommandHistory));
		return uniqueHistory
			.filter((cmd) => cmd.toLowerCase().includes(commandHistoryFilterLower))
			.reverse()
			.slice(0, 10);
	}, [currentCommandHistory, commandHistoryFilterLower]);

	// Auto-resize textarea to match content height.
	// Fires on tab switch AND inputValue changes (handles external updates like session restore,
	// paste-from-history, programmatic sets). The onChange handler also resizes via rAF for
	// keystroke responsiveness, but this effect catches all non-keystroke inputValue mutations
	// that would otherwise leave the textarea at the wrong height.
	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.style.height = 'auto';
			inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 112)}px`;
		}
	}, [session.activeTabId, inputValue, inputRef]);

	// Show summarization progress overlay when active for this tab
	if (isSummarizing && session.inputMode === 'ai' && onCancelSummarize) {
		return (
			<SummarizeProgressOverlay
				theme={theme}
				progress={summarizeProgress || null}
				result={summarizeResult || null}
				onCancel={onCancelSummarize}
				startTime={summarizeStartTime}
			/>
		);
	}

	// Show merge progress overlay when active for this tab
	if (isMerging && session.inputMode === 'ai' && onCancelMerge) {
		return (
			<MergeProgressOverlay
				theme={theme}
				progress={mergeProgress || null}
				result={mergeResult || null}
				sourceName={mergeSourceName}
				targetName={mergeTargetName}
				onCancel={onCancelMerge}
				startTime={mergeStartTime}
			/>
		);
	}

	// Show WizardInputPanel when wizard is active AND in AI mode (wizardState is per-tab)
	// When in terminal mode, show the normal terminal input even if wizard is active
	if (wizardState?.isActive && onExitWizard && session.inputMode === 'ai') {
		return (
			<WizardInputPanel
				session={session}
				theme={theme}
				inputValue={inputValue}
				setInputValue={setInputValue}
				inputRef={inputRef}
				handleInputKeyDown={handleInputKeyDown}
				handlePaste={handlePaste}
				processInput={processInput}
				stagedImages={stagedImages}
				setStagedImages={setStagedImages}
				onOpenPromptComposer={onOpenPromptComposer}
				toggleInputMode={toggleInputMode}
				confidence={wizardState.confidence}
				canAttachImages={canAttachImages}
				isBusy={wizardState.isWaiting || session.state === 'busy'}
				onExitWizard={onExitWizard}
				enterToSend={enterToSend}
				setEnterToSend={setEnterToSend}
				onInputFocus={onInputFocus}
				onInputBlur={onInputBlur}
				showFlashNotification={showFlashNotification}
				setLightboxImage={setLightboxImage}
				showThinking={wizardShowThinking}
				onToggleShowThinking={onToggleWizardShowThinking}
			/>
		);
	}

	return (
		<div
			className="relative p-4 border-t"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			{/* ThinkingStatusPill - only show in AI mode when there are thinking items or AutoRun */}
			{session.inputMode === 'ai' && (thinkingItems.length > 0 || autoRunState?.isRunning) && (
				<ThinkingStatusPill
					thinkingItems={thinkingItems}
					theme={theme}
					onSessionClick={onSessionClick}
					namedSessions={namedSessions}
					autoRunState={autoRunState}
					activeSessionId={session.id}
					onStopAutoRun={onStopAutoRun}
					onInterrupt={handleInterrupt}
				/>
			)}

			{/* ExecutionQueueIndicator - show when items are queued in AI mode */}
			{session.inputMode === 'ai' && onOpenQueueBrowser && (
				<ExecutionQueueIndicator session={session} theme={theme} onClick={onOpenQueueBrowser} />
			)}

			{/* Only show staged images in AI mode */}
			{session.inputMode === 'ai' && stagedImages.length > 0 && (
				<div className="flex gap-2 mb-3 pb-2 overflow-x-auto overflow-y-visible scrollbar-thin">
					{stagedImages.map((img, idx) => (
						<div key={img} className="relative group shrink-0">
							<button
								type="button"
								className="p-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
								onClick={() => setLightboxImage(img, stagedImages, 'staged')}
							>
								<img
									src={img}
									alt={`Staged image ${idx + 1}`}
									className="h-16 rounded border cursor-pointer hover:opacity-80 transition-opacity block"
									style={{
										borderColor: theme.colors.border,
										objectFit: 'contain',
										maxWidth: '200px',
									}}
								/>
							</button>
							<button
								onClick={(e) => {
									e.stopPropagation();
									setStagedImages((p) => p.filter((x) => x !== img));
								}}
								className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors opacity-90 hover:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-white"
							>
								<X className="w-3 h-3" />
							</button>
						</div>
					))}
				</div>
			)}

			{/* Slash Command Autocomplete - shows built-in and custom commands for all agents */}
			{slashCommandOpen && filteredSlashCommands.length > 0 && (
				<div
					className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl overflow-hidden"
					style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
				>
					<div
						className="overflow-y-auto max-h-64 scrollbar-thin"
						style={{ overscrollBehavior: 'contain' }}
					>
						{filteredSlashCommands.map((cmd, idx) => (
							<button
								type="button"
								key={cmd.command}
								ref={(el) => (slashCommandItemRefs.current[idx] = el)}
								className={`w-full px-4 py-3 text-left transition-colors ${
									idx === safeSelectedIndex ? 'font-semibold' : ''
								}`}
								style={{
									backgroundColor: idx === safeSelectedIndex ? theme.colors.accent : 'transparent',
									color: idx === safeSelectedIndex ? theme.colors.bgMain : theme.colors.textMain,
								}}
								onClick={() => {
									// Single click just selects the item
									setSelectedSlashCommandIndex(idx);
								}}
								onDoubleClick={() => {
									// Double click fills in the command text
									setInputValue(cmd.command);
									setSlashCommandOpen(false);
									inputRef.current?.focus();
								}}
								onMouseEnter={() => setSelectedSlashCommandIndex(idx)}
							>
								<div className="font-mono text-sm">{cmd.command}</div>
								<div className="text-xs opacity-70 mt-0.5">{cmd.description}</div>
							</button>
						))}
					</div>
				</div>
			)}

			{/* Command History Modal */}
			{commandHistoryOpen && (
				<div
					className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
					style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
				>
					<div className="p-2">
						<input
							ref={setCommandHistoryFilterRef}
							tabIndex={0}
							type="text"
							className="w-full bg-transparent outline-none text-sm p-2 border-b"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							placeholder={isTerminalMode ? 'Filter commands...' : 'Filter messages...'}
							value={commandHistoryFilter}
							onChange={(e) => {
								setCommandHistoryFilter(e.target.value);
								setCommandHistorySelectedIndex(0);
							}}
							onKeyDown={(e) => {
								// Use memoized filteredCommandHistory instead of recalculating
								if (e.key === 'ArrowDown') {
									e.preventDefault();
									setCommandHistorySelectedIndex(
										Math.min(commandHistorySelectedIndex + 1, filteredCommandHistory.length - 1)
									);
								} else if (e.key === 'ArrowUp') {
									e.preventDefault();
									setCommandHistorySelectedIndex(Math.max(commandHistorySelectedIndex - 1, 0));
								} else if (e.key === 'Enter') {
									e.preventDefault();
									if (filteredCommandHistory[commandHistorySelectedIndex]) {
										setInputValue(filteredCommandHistory[commandHistorySelectedIndex]);
										setCommandHistoryOpen(false);
										setCommandHistoryFilter('');
										setTimeout(() => inputRef.current?.focus(), 0);
									}
								} else if (e.key === 'Escape') {
									e.preventDefault();
									e.stopPropagation();
									setCommandHistoryOpen(false);
									setCommandHistoryFilter('');
									setTimeout(() => inputRef.current?.focus(), 0);
								}
							}}
						/>
					</div>
					<div className="max-h-48 overflow-y-auto scrollbar-thin">
						{filteredCommandHistory.slice(0, 5).map((cmd, idx) => {
							const isSelected = idx === commandHistorySelectedIndex;
							const isMostRecent = idx === 0;

							return (
								<button
									type="button"
									key={cmd}
									className={`w-full px-3 py-2 text-left text-sm font-mono ${isSelected ? 'ring-1 ring-inset' : ''} ${isMostRecent ? 'font-semibold' : ''}`}
									style={
										{
											backgroundColor: isSelected
												? theme.colors.bgActivity
												: isMostRecent
													? theme.colors.accent + '15'
													: 'transparent',
											'--tw-ring-color': theme.colors.accent,
											color: theme.colors.textMain,
											borderLeft: isMostRecent ? `2px solid ${theme.colors.accent}` : 'none',
										} as React.CSSProperties
									}
									onClick={() => {
										setInputValue(cmd);
										setCommandHistoryOpen(false);
										setCommandHistoryFilter('');
										inputRef.current?.focus();
									}}
									onMouseEnter={() => setCommandHistorySelectedIndex(idx)}
								>
									{cmd}
								</button>
							);
						})}
						{filteredCommandHistory.length === 0 && (
							<div className="px-3 py-4 text-center text-sm opacity-50">
								{isTerminalMode ? 'No matching commands' : 'No matching messages'}
							</div>
						)}
					</div>
				</div>
			)}

			{/* Tab Completion Dropdown - Terminal mode only */}
			{tabCompletionOpen && isTerminalMode && (
				<div
					className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
					style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
				>
					<div
						className="px-3 py-2 border-b flex items-center justify-between"
						style={{ borderColor: theme.colors.border }}
					>
						<span className="text-xs opacity-60" style={{ color: theme.colors.textDim }}>
							Tab Completion
						</span>
						{/* Filter buttons - only show in git repos */}
						{session.isGitRepo && setTabCompletionFilter && (
							<div className="flex gap-1">
								{(['all', 'history', 'branch', 'tag', 'file'] as const).map((filterType) => {
									const isActive = tabCompletionFilter === filterType;
									const Icon =
										filterType === 'history'
											? History
											: filterType === 'branch'
												? GitBranch
												: filterType === 'tag'
													? Tag
													: filterType === 'file'
														? File
														: null;
									const label =
										filterType === 'all'
											? 'All'
											: filterType === 'history'
												? 'History'
												: filterType === 'branch'
													? 'Branches'
													: filterType === 'tag'
														? 'Tags'
														: 'Files';
									return (
										<button
											key={filterType}
											onClick={(e) => {
												e.stopPropagation();
												setTabCompletionFilter(filterType);
												setSelectedTabCompletionIndex?.(0);
											}}
											className={`px-2 py-0.5 text-[10px] rounded flex items-center gap-1 transition-colors ${
												isActive ? 'font-medium' : 'opacity-60 hover:opacity-100'
											}`}
											style={{
												backgroundColor: isActive ? theme.colors.accent + '30' : 'transparent',
												color: isActive ? theme.colors.accent : theme.colors.textDim,
												border: isActive
													? `1px solid ${theme.colors.accent}50`
													: '1px solid transparent',
											}}
										>
											{Icon && <Icon className="w-3 h-3" />}
											{label}
										</button>
									);
								})}
							</div>
						)}
					</div>
					<div className="overflow-y-auto max-h-56 scrollbar-thin">
						{tabCompletionSuggestions.length > 0 ? (
							tabCompletionSuggestions.map((suggestion, idx) => {
								const isSelected = idx === selectedTabCompletionIndex;
								const IconComponent =
									suggestion.type === 'history'
										? History
										: suggestion.type === 'branch'
											? GitBranch
											: suggestion.type === 'tag'
												? Tag
												: suggestion.type === 'folder'
													? Folder
													: File;
								const typeLabel = suggestion.type;

								return (
									<button
										type="button"
										key={`${suggestion.type}-${suggestion.value}`}
										ref={(el) => (tabCompletionItemRefs.current[idx] = el)}
										className={`w-full px-3 py-2 text-left text-sm font-mono flex items-center gap-2 ${isSelected ? 'ring-1 ring-inset' : ''}`}
										style={
											{
												backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
												'--tw-ring-color': theme.colors.accent,
												color: theme.colors.textMain,
											} as React.CSSProperties
										}
										onClick={() => {
											setInputValue(suggestion.value);
											setTabCompletionOpen?.(false);
											inputRef.current?.focus();
										}}
										onMouseEnter={() => setSelectedTabCompletionIndex?.(idx)}
									>
										<IconComponent
											className="w-3.5 h-3.5 flex-shrink-0"
											style={{
												color:
													suggestion.type === 'history'
														? theme.colors.accent
														: suggestion.type === 'branch'
															? theme.colors.success
															: suggestion.type === 'tag'
																? theme.colors.accentText
																: suggestion.type === 'folder'
																	? theme.colors.warning
																	: theme.colors.textDim,
											}}
										/>
										<span className="flex-1 truncate">{suggestion.displayText}</span>
										<span className="text-[10px] opacity-40 flex-shrink-0">{typeLabel}</span>
									</button>
								);
							})
						) : (
							<div
								className="px-3 py-4 text-center text-sm opacity-50"
								style={{ color: theme.colors.textDim }}
							>
								No matching{' '}
								{tabCompletionFilter === 'all'
									? 'suggestions'
									: tabCompletionFilter === 'history'
										? 'history'
										: tabCompletionFilter === 'branch'
											? 'branches'
											: tabCompletionFilter === 'tag'
												? 'tags'
												: 'files'}
							</div>
						)}
					</div>
				</div>
			)}

			{/* @ Mention Dropdown (AI mode file picker) */}
			{atMentionOpen && !isTerminalMode && atMentionSuggestions.length > 0 && (
				<div
					className="absolute bottom-full left-4 right-4 mb-1 rounded-lg border shadow-lg overflow-hidden z-50"
					style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
				>
					<div
						className="px-3 py-2 border-b text-xs font-medium"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						Files{' '}
						{atMentionFilter && <span className="opacity-50">matching "{atMentionFilter}"</span>}
					</div>
					<div className="overflow-y-auto max-h-56 scrollbar-thin">
						{atMentionSuggestions.map((suggestion, idx) => {
							const isSelected = idx === selectedAtMentionIndex;
							const IconComponent = suggestion.type === 'folder' ? Folder : File;

							return (
								<button
									type="button"
									key={`${suggestion.type}-${suggestion.value}`}
									ref={(el) => (atMentionItemRefs.current[idx] = el)}
									className={`w-full px-3 py-2 text-left text-sm font-mono flex items-center gap-2 ${isSelected ? 'ring-1 ring-inset' : ''}`}
									style={
										{
											backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
											'--tw-ring-color': theme.colors.accent,
											color: theme.colors.textMain,
										} as React.CSSProperties
									}
									onClick={() => {
										// Replace @filter with @path
										const beforeAt = inputValue.substring(0, atMentionStartIndex);
										const afterFilter = inputValue.substring(
											atMentionStartIndex + 1 + atMentionFilter.length
										);
										setInputValue(beforeAt + '@' + suggestion.value + ' ' + afterFilter);
										setAtMentionOpen?.(false);
										setAtMentionFilter?.('');
										setAtMentionStartIndex?.(-1);
										inputRef.current?.focus();
									}}
									onMouseEnter={() => setSelectedAtMentionIndex?.(idx)}
								>
									<IconComponent
										className="w-3.5 h-3.5 flex-shrink-0"
										style={{
											color:
												suggestion.type === 'folder' ? theme.colors.warning : theme.colors.textDim,
										}}
									/>
									<span className="flex-1 truncate">{suggestion.fullPath}</span>
									{suggestion.source === 'autorun' && (
										<span
											className="text-[9px] px-1 py-0.5 rounded flex-shrink-0"
											style={{
												backgroundColor: `${theme.colors.accent}30`,
												color: theme.colors.accent,
											}}
										>
											Auto Run
										</span>
									)}
									<span className="text-[10px] opacity-40 flex-shrink-0">{suggestion.type}</span>
								</button>
							);
						})}
					</div>
				</div>
			)}

			<div className="flex gap-3">
				<div className="flex-1 flex flex-col">
					<div
						className="flex-1 relative border rounded-lg bg-opacity-50 flex flex-col"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<div className="flex items-start">
							{/* Terminal mode prefix */}
							{isTerminalMode && (
								<span
									className="text-sm font-mono font-bold select-none pl-3 pt-3"
									style={{ color: theme.colors.accent }}
								>
									$
								</span>
							)}
							<textarea
								ref={inputRef}
								className={`flex-1 bg-transparent text-sm outline-none ${isTerminalMode ? 'pl-1.5' : 'pl-3'} pt-3 pr-3 resize-none min-h-[3.5rem] scrollbar-thin`}
								style={{ color: theme.colors.textMain, maxHeight: '11rem' }}
								placeholder={
									isTerminalMode
										? 'Run shell command...'
										: `Talking to ${session.name} powered by ${getProviderDisplayName(session.toolType)}`
								}
								value={inputValue}
								onFocus={onInputFocus}
								onBlur={onInputBlur}
								onChange={(e) => {
									const value = e.target.value;
									const cursorPosition = e.target.selectionStart || 0;

									// CRITICAL: Update input value immediately for responsive typing
									setInputValue(value);

									// PERFORMANCE: Use startTransition for non-urgent UI updates
									// This allows React to interrupt these updates if more keystrokes come in
									startTransition(() => {
										// Show slash command autocomplete when typing /
										// Close when there's a space or newline (user is adding arguments or multiline content)
										if (value.startsWith('/') && !value.includes(' ') && !value.includes('\n')) {
											if (!slashCommandOpen) {
												setSelectedSlashCommandIndex(0);
											}
											setSlashCommandOpen(true);
										} else {
											setSlashCommandOpen(false);
										}

										// @ mention file completion (AI mode only)
										if (
											!isTerminalMode &&
											setAtMentionOpen &&
											setAtMentionFilter &&
											setAtMentionStartIndex &&
											setSelectedAtMentionIndex
										) {
											const textBeforeCursor = value.substring(0, cursorPosition);
											const lastAtPos = textBeforeCursor.lastIndexOf('@');

											if (lastAtPos === -1) {
												setAtMentionOpen(false);
											} else {
												const isValidTrigger = lastAtPos === 0 || /\s/.test(value[lastAtPos - 1]);
												const textAfterAt = value.substring(lastAtPos + 1, cursorPosition);
												const hasSpaceAfterAt = textAfterAt.includes(' ');

												if (isValidTrigger && !hasSpaceAfterAt) {
													setAtMentionOpen(true);
													setAtMentionFilter(textAfterAt);
													setAtMentionStartIndex(lastAtPos);
													setSelectedAtMentionIndex(0);
												} else {
													setAtMentionOpen(false);
												}
											}
										}
									});

									// PERFORMANCE: Auto-grow logic deferred to next animation frame
									// This prevents layout thrashing from blocking the keystroke handling
									const textarea = e.target;
									requestAnimationFrame(() => {
										textarea.style.height = 'auto';
										textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`;
									});
								}}
								onKeyDown={handleInputKeyDown}
								onPaste={handlePaste}
								onDrop={(e) => {
									e.stopPropagation();
									handleDrop(e);
								}}
								onDragOver={(e) => e.preventDefault()}
								rows={2}
							/>
						</div>

						<div className="flex justify-between items-center px-2 pb-2 pt-1">
							<div className="flex gap-1 items-center">
								{session.inputMode === 'terminal' && (
									<div
										className="text-xs font-mono opacity-60 px-2"
										style={{ color: theme.colors.textDim }}
									>
										{/* For SSH sessions, show hostname:remoteCwd; for local sessions, show shellCwd */}
										{(() => {
											const isRemote = !!(
												session.sshRemoteId || session.sessionSshRemoteConfig?.enabled
											);
											const path = isRemote
												? session.remoteCwd ||
													session.sessionSshRemoteConfig?.workingDirOverride ||
													session.cwd
												: session.shellCwd || session.cwd;
											const displayPath =
												path?.replace(/^\/Users\/[^\/]+/, '~').replace(/^\/home\/[^\/]+/, '~') ||
												'~';
											// For SSH sessions, prefix with hostname (uppercase)
											if (isRemote && session.sshRemote?.name) {
												return `${session.sshRemote.name.toUpperCase()}:${displayPath}`;
											}
											return displayPath;
										})()}
									</div>
								)}
								{session.inputMode === 'ai' && onOpenPromptComposer && (
									<button
										onClick={onOpenPromptComposer}
										className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
										title={`Open Prompt Composer${shortcuts?.openPromptComposer ? ` (${formatShortcutKeys(shortcuts.openPromptComposer.keys)})` : ''}`}
									>
										<PenLine className="w-4 h-4" />
									</button>
								)}
								{session.inputMode === 'ai' && canAttachImages && (
									<button
										onClick={() => document.getElementById('image-file-input')?.click()}
										className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
										title="Attach Image"
									>
										<ImageIcon className="w-4 h-4" />
									</button>
								)}
								<input
									id="image-file-input"
									type="file"
									accept="image/*"
									multiple
									className="hidden"
									onChange={(e) => {
										const files = Array.from(e.target.files || []);
										files.forEach((file) => {
											const reader = new FileReader();
											reader.onload = (event) => {
												if (event.target?.result) {
													const imageData = event.target!.result as string;
													setStagedImages((prev) => {
														if (prev.includes(imageData)) {
															showFlashNotification?.('Duplicate image ignored');
															return prev;
														}
														return [...prev, imageData];
													});
												}
											};
											reader.readAsDataURL(file);
										});
										e.target.value = '';
									}}
								/>
							</div>

							<div className="flex items-center gap-2">
								{session.inputMode === 'ai' && (
									<button
										type="button"
										onClick={toggleDemoCapture}
										className="flex items-center gap-1.5 text-[10px] transition-all hover:opacity-90"
										style={{
											...inlineToolbarPillBaseStyle,
											border: `1px solid ${
												demoCaptureRequested ? `${theme.colors.accent}70` : `${theme.colors.border}`
											}`,
											backgroundColor: demoCaptureRequested
												? `${theme.colors.accent}18`
												: 'transparent',
											color: demoCaptureRequested ? theme.colors.accent : theme.colors.textDim,
										}}
										title="Capture a demo for the next agent run"
									>
										<Sparkles className="w-3.5 h-3.5" />
										<span>Demo</span>
									</button>
								)}
								{supportsModelSelection && (
									<div className="relative" ref={modelMenuRef}>
										<ModelSelectorButton
											label={effectiveModelLabel}
											toolType={session.toolType}
											theme={theme}
											onClick={() => void handleModelMenuToggle()}
											disabled={false}
											isOpen={modelMenuOpen}
										/>
										{modelMenuOpen && (
											<div
												className="absolute bottom-full right-0 mb-2 z-50 w-80"
												style={{
													borderRadius: '20px',
													border: `1px solid ${theme.colors.border}`,
													background: `linear-gradient(180deg, ${theme.colors.bgSidebar}fa 0%, ${theme.colors.bgMain}fa 100%)`,
													backdropFilter: 'blur(22px)',
													WebkitBackdropFilter: 'blur(22px)',
													boxShadow: '0 18px 36px rgba(15, 23, 42, 0.22)',
													padding: '12px',
												}}
											>
												<div
													className="flex items-center justify-between gap-3"
													style={{ marginBottom: '10px' }}
												>
													<div
														style={{
															fontSize: '12px',
															fontWeight: 700,
															color: theme.colors.textMain,
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
															color: theme.colors.accent,
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
													{selectableModels.length > 0 ? (
														<div
															style={{
																display: 'flex',
																flexDirection: 'column',
																gap: '6px',
															}}
														>
															{selectableModels.map((model) => {
																const isActive = model === effectiveModelLabel;
																return (
																	<button
																		key={model}
																		type="button"
																		onClick={() => applyModelSelection(model)}
																		style={{
																			padding: '12px 14px',
																			borderRadius: '14px',
																			border: `1px solid ${theme.colors.border}`,
																			backgroundColor: isActive
																				? `${theme.colors.accent}18`
																				: `${theme.colors.bgMain}cc`,
																			color: isActive ? theme.colors.accent : theme.colors.textMain,
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
														</div>
													) : (
														<div
															style={{
																padding: '12px 14px',
																borderRadius: '14px',
																border: `1px solid ${theme.colors.border}`,
																backgroundColor: `${theme.colors.bgMain}cc`,
																color: theme.colors.textDim,
																fontSize: '13px',
															}}
														>
															No models available
														</div>
													)}
												</div>
											</div>
										)}
									</div>
								)}
								{/* Modes selector (Cursor-style) */}
								{supportsInteractionModes && (
									<div className="relative" ref={modeMenuRef}>
										<button
											onClick={() => setModeMenuOpen((prev) => !prev)}
											className="flex items-center gap-1.5 text-[10px] border transition-all hover:opacity-90"
											style={{
												...inlineToolbarPillBaseStyle,
												borderColor: theme.colors.border,
												color: theme.colors.accent,
												backgroundColor: `${theme.colors.accent}12`,
											}}
											title={`Mode: ${selectedModeOption.label}`}
										>
											<selectedModeOption.icon className="w-3.5 h-3.5" />
											<ChevronDown className="w-3 h-3 opacity-70" />
										</button>
										{modeMenuOpen && (
											<div
												className="absolute bottom-full right-0 mb-2 rounded-lg border shadow-xl p-1 z-50 min-w-[210px]"
												style={{
													backgroundColor: theme.colors.bgSidebar,
													borderColor: theme.colors.border,
												}}
											>
												{modeOptions.map((option) => {
													const active = interactionMode === option.id;
													const Icon = option.icon;
													return (
														<button
															key={option.id}
															onClick={() => {
																setInteractionMode(option.id);
																setModeMenuOpen(false);
															}}
															className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-all"
															style={{
																backgroundColor: active
																	? `${theme.colors.accent}25`
																	: 'transparent',
																color: active ? theme.colors.accent : theme.colors.textMain,
															}}
															title={option.description}
														>
															<Icon className="w-3.5 h-3.5" />
															<span className="text-xs">{option.label}</span>
														</button>
													);
												})}
											</div>
										)}
									</div>
								)}
								{/* Read-only toggle fallback for agents without interaction modes */}
								{session.inputMode === 'ai' &&
									!supportsInteractionModes &&
									onToggleTabReadOnlyMode &&
									hasCapability('supportsReadOnlyMode') && (
										<button
											onClick={onToggleTabReadOnlyMode}
											className={`flex items-center gap-1.5 text-[10px] cursor-pointer transition-all ${
												isReadOnlyMode ? '' : 'opacity-40 hover:opacity-70'
											}`}
											style={{
												...inlineToolbarPillBaseStyle,
												backgroundColor: isReadOnlyMode
													? `${theme.colors.warning}25`
													: 'transparent',
												color: isReadOnlyMode ? theme.colors.warning : theme.colors.textDim,
												border: isReadOnlyMode
													? `1px solid ${theme.colors.warning}50`
													: `1px solid ${theme.colors.border}`,
											}}
											title="Toggle read-only mode (agent won't modify files)"
										>
											<Eye className="w-3 h-3" />
											<span>Read-only</span>
										</button>
									)}
								{session.inputMode === 'ai' &&
									supportsReasoningEffort &&
									onSetTabReasoningEffort && (
										<div className="relative" ref={effortMenuRef}>
											<button
												onClick={() => setEffortMenuOpen((prev) => !prev)}
												className="flex items-center gap-1.5 text-[10px] border transition-all hover:opacity-90"
												style={{
													...inlineToolbarPillBaseStyle,
													borderColor: theme.colors.border,
													color: theme.colors.accentText,
													backgroundColor: `${theme.colors.accentText}12`,
												}}
												title={`Reasoning effort: ${selectedEffortOption.label}`}
											>
												<Brain className="w-3.5 h-3.5" />
												<ChevronDown className="w-3 h-3 opacity-70" />
											</button>
											{effortMenuOpen && (
												<div
													className="absolute bottom-full right-0 mb-2 rounded-lg border shadow-xl p-1 z-50 min-w-[150px]"
													style={{
														backgroundColor: theme.colors.bgSidebar,
														borderColor: theme.colors.border,
													}}
												>
													{effortOptions.map((option) => {
														const active = option.id === effectiveReasoningEffortForDisplay;
														const Icon = option.icon;
														return (
															<button
																key={option.id}
																onClick={() => {
																	onSetTabReasoningEffort(option.id);
																	setEffortMenuOpen(false);
																}}
																className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-all"
																style={{
																	backgroundColor: active
																		? `${theme.colors.accentText}25`
																		: 'transparent',
																	color: active ? theme.colors.accentText : theme.colors.textMain,
																}}
															>
																<Icon className="w-3.5 h-3.5" />
																<span className="text-xs">{option.label}</span>
															</button>
														);
													})}
												</div>
											)}
										</div>
									)}
								<button
									onClick={() => setEnterToSend(!enterToSend)}
									className="flex items-center gap-1.5 text-[10px] opacity-50 hover:opacity-100 transition-all"
									style={{
										...inlineToolbarPillBaseStyle,
										border: `1px solid ${theme.colors.border}`,
										backgroundColor: 'transparent',
									}}
									title={formatEnterToSendTooltip(enterToSend)}
								>
									<Keyboard className="w-3 h-3" />
									{formatEnterToSend(enterToSend)}
								</button>
							</div>
						</div>
					</div>
					{/* Context Warning Sash - AI mode only, appears below input when context usage is high */}
					{session.inputMode === 'ai' && contextWarningsEnabled && onSummarizeAndContinue && (
						<ContextWarningSash
							theme={theme}
							contextUsage={contextUsage}
							yellowThreshold={contextWarningYellowThreshold}
							redThreshold={contextWarningRedThreshold}
							enabled={contextWarningsEnabled}
							onSummarizeClick={onSummarizeAndContinue}
							tabId={session.activeTabId}
						/>
					)}
				</div>

				{/* Mode Toggle & Send/Interrupt Button - Right Side */}
				<div className="flex flex-col gap-2">
					<button
						type="button"
						onClick={toggleInputMode}
						className="p-2 rounded-lg border transition-all"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
						}}
						title={`Toggle Mode (${formatShortcutKeys(['Meta', 'j'])})`}
					>
						{session.inputMode === 'terminal' ? (
							<Terminal className="w-4 h-4" />
						) : wizardState?.isActive ? (
							<Wand2 className="w-4 h-4" style={{ color: theme.colors.accent }} />
						) : (
							<Cpu className="w-4 h-4" />
						)}
					</button>
					{/* Send button - always visible. Stop button is now in ThinkingStatusPill */}
					<button
						type="button"
						onClick={() => processInput()}
						className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
						title={session.inputMode === 'terminal' ? 'Run command (Enter)' : 'Send message'}
					>
						<ArrowUp className="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>
	);
});
