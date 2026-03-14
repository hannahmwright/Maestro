import React, { memo } from 'react';
import { GitBranch, Bot, Bookmark, AlertCircle, Loader2 } from 'lucide-react';
import type { Session, Group, Theme } from '../types';
import { ProviderModelIcon, getProviderBrandColor } from './shared/ProviderModelIcon';

function getSidebarRowStyle(
	theme: Theme,
	options?: {
		active?: boolean;
		keyboard?: boolean;
	}
): React.CSSProperties {
	const active = options?.active ?? false;
	const keyboard = options?.keyboard ?? false;

	return {
		borderColor: active
			? `${theme.colors.accent}48`
			: keyboard
				? `${theme.colors.accent}24`
				: 'transparent',
		backgroundColor: active
			? `${theme.colors.accent}12`
			: keyboard
				? `${theme.colors.bgActivity}55`
				: 'transparent',
		boxShadow: active ? `inset 0 1px 0 rgba(255,255,255,0.05)` : undefined,
	};
}

function getSidebarPillStyle(theme: Theme, background: string, color: string): React.CSSProperties {
	return {
		background,
		color,
		border: 'none',
	};
}

function getThreadTitleStyle(theme: Theme, isActive: boolean): React.CSSProperties {
	return {
		color: isActive ? theme.colors.textDim : theme.colors.textDim,
		opacity: isActive ? 0.96 : 0.88,
	};
}

// ============================================================================
// SessionItem - Unified session item component for all list contexts
// ============================================================================

/**
 * Variant determines the context in which the session item is rendered:
 * - 'bookmark': Session in the Bookmarks folder (shows group badge if session belongs to a group)
 * - 'group': Session inside a group folder
 * - 'flat': Session in flat list (when no groups exist)
 * - 'ungrouped': Session in the Ungrouped folder (when groups exist)
 * - 'worktree': Worktree child session nested under parent (shows branch name)
 */
export type SessionItemVariant = 'bookmark' | 'group' | 'flat' | 'ungrouped' | 'worktree';

export interface SessionItemProps {
	session: Session;
	variant: SessionItemVariant;
	theme: Theme;
	displayName?: string;
	providerAgentId?: Session['toolType'];
	workspaceEmoji?: string;
	bookmarkState?: boolean;

	// State
	isActive: boolean;
	isKeyboardSelected: boolean;
	isDragging: boolean;
	isEditing: boolean;
	leftSidebarOpen: boolean;

	// Optional data
	group?: Group; // The group this session belongs to (for bookmark variant to show group badge)
	groupId?: string; // The group ID context for generating editing key
	isInBatch?: boolean;
	jumpNumber?: string | null; // Session jump shortcut number (1-9, 0)

	// Handlers
	onSelect: () => void;
	onDragStart: () => void;
	onDragOver?: (e: React.DragEvent) => void;
	onDrop?: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onFinishRename: (newName: string) => void;
	onStartRename: () => void;
	onToggleBookmark: () => void;
}

/**
 * SessionItem renders a single session in the sidebar list.
 *
 * This component unifies 4 previously separate implementations:
 * 1. Bookmark items - sessions pinned to the Bookmarks folder
 * 2. Group items - sessions inside a group folder
 * 3. Flat items - sessions in a flat list (no groups)
 * 4. Ungrouped items - sessions in the Ungrouped folder
 *
 * Key differences between variants are handled via props:
 * - Bookmark variant shows group badge and always shows filled bookmark icon
 * - Group/Flat/Ungrouped variants show bookmark icon on hover (unless bookmarked)
 * - Flat variant has slightly different styling (mx-3 vs ml-4)
 */
export const SessionItem = memo(function SessionItem({
	session,
	variant,
	theme,
	displayName,
	providerAgentId,
	workspaceEmoji,
	bookmarkState,
	isActive,
	isKeyboardSelected,
	isDragging,
	isEditing,
	leftSidebarOpen,
	group,
	groupId,
	isInBatch = false,
	jumpNumber,
	onSelect,
	onDragStart,
	onDragOver,
	onDrop,
	onContextMenu,
	onFinishRename,
	onStartRename,
	onToggleBookmark,
}: SessionItemProps) {
	const hasUnreadTabs = session.aiTabs?.some((tab) => tab.hasUnread) ?? false;
	const isWorking = session.state === 'busy' || isInBatch;
	const resolvedDisplayName = displayName || session.name;
	const resolvedProviderAgentId = providerAgentId || session.toolType;
	const resolvedBookmarked = bookmarkState ?? session.bookmarked;

	// Determine container styling based on variant
	const getContainerClassName = () => {
		const base = `cursor-move flex items-center justify-between group border-l-2 transition-all hover:bg-opacity-50 ${isDragging ? 'opacity-50' : ''}`;

		if (variant === 'flat') {
			return `mx-3 px-3 py-2 rounded mb-1 ${base}`;
		}
		if (variant === 'worktree') {
			// Worktree children have extra left padding and smaller text
			return `pl-8 pr-4 py-1.5 ${base}`;
		}
		return `px-4 py-2 ${base}`;
	};

	return (
		<div
			key={`${variant}-${groupId || ''}-${session.id}`}
			draggable
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDrop={onDrop}
			onClick={onSelect}
			onContextMenu={onContextMenu}
			className={getContainerClassName()}
			style={getSidebarRowStyle(theme, { active: isActive, keyboard: isKeyboardSelected })}
		>
			{/* Left side: Session name and metadata */}
			<div className="min-w-0 flex-1">
				{isEditing ? (
					<input
						autoFocus
						className="bg-transparent text-sm font-medium outline-none w-full border-b"
						style={{ borderColor: theme.colors.accent }}
						defaultValue={resolvedDisplayName}
						onClick={(e) => e.stopPropagation()}
						onBlur={(e) => onFinishRename(e.target.value)}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === 'Enter') onFinishRename(e.currentTarget.value);
						}}
					/>
				) : (
					<div className="flex items-center gap-1.5" onDoubleClick={onStartRename}>
						{/* Bookmark icon (only in bookmark variant, always filled) */}
						{variant === 'bookmark' && resolvedBookmarked && (
							<Bookmark
								className="w-3 h-3 shrink-0"
								style={{ color: theme.colors.accent }}
								fill={theme.colors.accent}
							/>
						)}
						{/* Branch icon for worktree children */}
						{variant === 'worktree' && (
							<GitBranch className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
						)}
						{variant !== 'worktree' && (
							<div className="shrink-0" title={resolvedProviderAgentId}>
								<ProviderModelIcon
									toolType={resolvedProviderAgentId}
									color={getProviderBrandColor(resolvedProviderAgentId, theme.colors.textDim)}
									size={14}
								/>
							</div>
						)}
						{workspaceEmoji && variant !== 'group' && variant !== 'worktree' && (
							<span className="text-xs shrink-0" title="Workspace">
								{workspaceEmoji}
							</span>
						)}
						<span
							className={`font-medium truncate ${variant === 'worktree' ? 'text-xs' : 'text-sm'}`}
							style={getThreadTitleStyle(theme, isActive)}
						>
							{resolvedDisplayName}
						</span>
					</div>
				)}

				{/* Session metadata row (hidden for compact worktree variant) */}
				{variant !== 'worktree' && (
					<div className="flex items-center gap-2 text-[10px] mt-0.5 opacity-70">
						{jumpNumber && (
							<div
								className="w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold shrink-0"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.bgMain,
								}}
							>
								{jumpNumber}
							</div>
						)}
						{/* Group badge (only in bookmark variant when session belongs to a group) */}
						{variant === 'bookmark' && group && (
							<span
								className="text-[9px] px-1 py-0.5 rounded"
								style={getSidebarPillStyle(theme, 'rgba(255,255,255,0.12)', theme.colors.textDim)}
							>
								{group.name}
							</span>
						)}
					</div>
				)}
			</div>

			{/* Right side: Indicators and actions */}
			<div className="flex items-center gap-2 ml-2">
				{/* AUTO Mode Indicator */}
				{isInBatch && (
					<div
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase animate-pulse"
						style={getSidebarPillStyle(theme, `${theme.colors.warning}30`, theme.colors.warning)}
						title="Auto Run active"
					>
						<Bot className="w-2.5 h-2.5" />
						AUTO
					</div>
				)}

				{/* Agent Error Indicator */}
				{session.agentError && (
					<div
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
						style={getSidebarPillStyle(theme, `${theme.colors.error}30`, theme.colors.error)}
						title={`Error: ${session.agentError.message}`}
					>
						<AlertCircle className="w-2.5 h-2.5" />
						ERR
					</div>
				)}

				{/* Bookmark toggle - hidden for worktree children (they inherit from parent) */}
				{!session.parentSessionId &&
					(variant !== 'bookmark' ? (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onToggleBookmark();
							}}
							className={`p-0.5 rounded hover:bg-white/10 transition-all ${resolvedBookmarked ? '' : 'opacity-0 group-hover:opacity-100'}`}
							title={resolvedBookmarked ? 'Remove bookmark' : 'Add bookmark'}
						>
							<Bookmark
								className="w-3 h-3"
								style={{ color: theme.colors.accent }}
								fill={resolvedBookmarked ? theme.colors.accent : 'none'}
							/>
						</button>
					) : (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onToggleBookmark();
							}}
							className="p-0.5 rounded hover:bg-white/10 transition-colors"
							title="Remove bookmark"
						>
							<Bookmark
								className="w-3 h-3"
								style={{ color: theme.colors.accent }}
								fill={theme.colors.accent}
							/>
						</button>
					))}

				{/* Session activity indicator: spinner while working, dot when awaiting user input */}
				{(isWorking || hasUnreadTabs) && (
					<div className="ml-auto flex items-center">
						{isWorking ? (
							<span
								title={
									session.cliActivity
										? `CLI: Running playbook "${session.cliActivity.playbookName}"`
										: 'Agent is working'
								}
							>
								<Loader2
									className="w-3 h-3 animate-spin"
									style={{ color: isInBatch ? theme.colors.warning : theme.colors.accent }}
								/>
							</span>
						) : (
							<div
								className="w-2 h-2 rounded-full"
								style={{ backgroundColor: theme.colors.accent }}
								title="Awaiting your input"
							/>
						)}
					</div>
				)}
			</div>
		</div>
	);
});

export default SessionItem;
