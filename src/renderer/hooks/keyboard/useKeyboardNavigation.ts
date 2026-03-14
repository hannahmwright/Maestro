import { useCallback, useEffect, useRef } from 'react';
import type { Group, FocusArea, SidebarNavTarget } from '../../types';

/**
 * Dependencies for useKeyboardNavigation hook
 *
 * Note: editingSessionId/editingGroupId are checked in useMainKeyboardHandler.ts
 * before any navigation handlers are called, so they are not needed here.
 */
export interface UseKeyboardNavigationDeps {
	/** Visible sidebar targets in visual order */
	sidebarNavTargets: SidebarNavTarget[];
	/** Current selected sidebar index */
	selectedSidebarIndex: number;
	/** Setter for selected sidebar index */
	setSelectedSidebarIndex: React.Dispatch<React.SetStateAction<number>>;
	/** Active selectable sidebar target ID, when one exists */
	activeSidebarNavTargetId: string | null;
	/** Open the selected sidebar target */
	openSidebarNavTarget: (target: SidebarNavTarget) => void;
	/** Current focus area */
	activeFocus: FocusArea;
	/** Setter for focus area */
	setActiveFocus: React.Dispatch<React.SetStateAction<FocusArea>>;
	/** Session groups */
	groups: Group[];
	/** Setter for groups (for collapse/expand) */
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	/** Input ref for focus management */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Terminal output ref for escape handling */
	terminalOutputRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Return type for useKeyboardNavigation hook
 */
export interface UseKeyboardNavigationReturn {
	/** Handle sidebar navigation keyboard events. Returns true if event was handled. */
	handleSidebarNavigation: (e: KeyboardEvent) => boolean;
	/** Handle Tab navigation between panels. Returns true if event was handled. */
	handleTabNavigation: (e: KeyboardEvent) => boolean;
	/** Handle Enter to activate selected session. Returns true if event was handled. */
	handleEnterToActivate: (e: KeyboardEvent) => boolean;
	/** Handle Escape in main area. Returns true if event was handled. */
	handleEscapeInMain: (e: KeyboardEvent) => boolean;
}

/**
 * Keyboard navigation utilities for sidebar and panel focus management.
 *
 * Provides handlers for:
 * - Arrow key navigation through sessions (with group collapse/expand)
 * - Tab navigation between panels (sidebar, main, right)
 * - Enter to activate selected session
 * - Escape to blur input and focus terminal output
 *
 * @param deps - Hook dependencies containing state and setters
 * @returns Navigation handlers for the main keyboard event handler
 */
export function useKeyboardNavigation(
	deps: UseKeyboardNavigationDeps
): UseKeyboardNavigationReturn {
	const {
		sidebarNavTargets,
		selectedSidebarIndex,
		setSelectedSidebarIndex,
		activeSidebarNavTargetId,
		openSidebarNavTarget,
		activeFocus,
		setActiveFocus,
		groups,
		setGroups,
		inputRef,
		terminalOutputRef,
	} = deps;

	// Use refs for values that change frequently to avoid stale closures
	const sidebarNavTargetsRef = useRef(sidebarNavTargets);
	sidebarNavTargetsRef.current = sidebarNavTargets;

	const selectedSidebarIndexRef = useRef(selectedSidebarIndex);
	selectedSidebarIndexRef.current = selectedSidebarIndex;

	const groupsRef = useRef(groups);
	groupsRef.current = groups;

	const activeFocusRef = useRef(activeFocus);
	activeFocusRef.current = activeFocus;

	/**
	 * Handle sidebar navigation with arrow keys.
	 * Navigates the currently visible thread rows and supports collapsing workspaces.
	 * Returns true if the event was handled.
	 */
	const handleSidebarNavigation = useCallback(
		(e: KeyboardEvent): boolean => {
			const navTargets = sidebarNavTargetsRef.current;
			const currentGroups = groupsRef.current;
			const currentIndex = selectedSidebarIndexRef.current;
			const focus = activeFocusRef.current;

			// Only handle when sidebar has focus
			if (focus !== 'sidebar') return false;

			// Skip if event originated from an input element (text areas, inputs)
			const target = e.target as HTMLElement | null;
			if (
				target?.tagName === 'INPUT' ||
				target?.tagName === 'TEXTAREA' ||
				target?.isContentEditable
			) {
				return false;
			}

			// Skip if Alt+Cmd+Arrow is pressed (layout toggle shortcut)
			const isToggleLayoutShortcut =
				e.altKey && (e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
			if (isToggleLayoutShortcut) return false;

			// Only handle arrow keys and space
			if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
				return false;
			}

			e.preventDefault();
			if (navTargets.length === 0) return true;

			const currentTarget =
				navTargets[
					Math.min(Math.max(currentIndex, 0), Math.max(navTargets.length - 1, 0))
				];

			// ArrowLeft / Space: collapse the current workspace when possible
			if ((e.key === 'ArrowLeft' || e.key === ' ') && currentTarget) {
				const workspaceId =
					currentTarget.type === 'workspace'
						? currentTarget.workspace.workspaceId
						: currentTarget.thread.workspaceId;
				const currentGroup = currentGroups.find((g) => g.id === workspaceId);
				if (currentGroup && !currentGroup.collapsed) {
					setGroups((prev) =>
						prev.map((g) => (g.id === currentGroup.id ? { ...g, collapsed: true } : g))
					);
					if (currentIndex > 0) {
						setSelectedSidebarIndex(currentIndex - 1);
					}
				}
				return true;
			}

			// ArrowRight: keep reserved for future workspace header expansion behavior
			if (e.key === 'ArrowRight') {
				if (currentTarget) {
					const workspaceId =
						currentTarget.type === 'workspace'
							? currentTarget.workspace.workspaceId
							: currentTarget.thread.workspaceId;
					const currentGroup = currentGroups.find((g) => g.id === workspaceId);
					if (currentGroup && currentGroup.collapsed) {
						setGroups((prev) =>
							prev.map((g) => (g.id === currentGroup.id ? { ...g, collapsed: false } : g))
						);
					}
				}
				return true;
			}

			// ArrowUp/ArrowDown: navigate through visible thread rows
			if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				const totalTargets = navTargets.length;
				const normalizedIndex =
					currentIndex >= 0 && currentIndex < totalTargets ? currentIndex : 0;
				const nextIndex =
					e.key === 'ArrowDown'
						? (normalizedIndex + 1) % totalTargets
						: (normalizedIndex - 1 + totalTargets) % totalTargets;
				setSelectedSidebarIndex(nextIndex);
				return true;
			}

			return false;
		},
		[setSelectedSidebarIndex, setGroups]
	);

	/**
	 * Handle Tab navigation between panels.
	 * Returns true if the event was handled.
	 */
	const handleTabNavigation = useCallback(
		(e: KeyboardEvent): boolean => {
			if (e.key !== 'Tab') return false;

			// Skip global Tab handling when input is focused - let input handler handle it
			if (document.activeElement === inputRef.current) {
				return false;
			}

			e.preventDefault();
			const focus = activeFocusRef.current;

			if (focus === 'sidebar' && !e.shiftKey) {
				// Tab from sidebar goes to main input
				setActiveFocus('main');
				setTimeout(() => inputRef.current?.focus(), 0);
				return true;
			}

			const order: FocusArea[] = ['sidebar', 'main', 'right'];
			const currentIdx = order.indexOf(focus);
			if (e.shiftKey) {
				const next = currentIdx === 0 ? order.length - 1 : currentIdx - 1;
				setActiveFocus(order[next]);
			} else {
				const next = currentIdx === order.length - 1 ? 0 : currentIdx + 1;
				setActiveFocus(order[next]);
			}
			return true;
		},
		[setActiveFocus, inputRef]
	);

	/**
	 * Handle Enter to load selected session from sidebar.
	 * Returns true if the event was handled.
	 * Only triggers on plain Enter (no modifiers) to avoid interfering with Cmd+Enter.
	 */
	const handleEnterToActivate = useCallback(
		(e: KeyboardEvent): boolean => {
			const focus = activeFocusRef.current;
			// Only handle plain Enter, not Cmd+Enter or other modifier combinations
			if (focus !== 'sidebar' || e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey)
				return false;

			// Skip if event originated from an input element (text areas, inputs)
			const target = e.target as HTMLElement | null;
			if (
				target?.tagName === 'INPUT' ||
				target?.tagName === 'TEXTAREA' ||
				target?.isContentEditable
			) {
				return false;
			}

			e.preventDefault();
			const navTargets = sidebarNavTargetsRef.current;
			const currentIndex = selectedSidebarIndexRef.current;

			if (navTargets[currentIndex]) {
				openSidebarNavTarget(navTargets[currentIndex]);
			}
			return true;
		},
		[openSidebarNavTarget]
	);

	/**
	 * Handle Escape in main area to blur input and focus terminal.
	 * Returns true if the event was handled.
	 */
	const handleEscapeInMain = useCallback(
		(e: KeyboardEvent): boolean => {
			const focus = activeFocusRef.current;
			if (focus !== 'main' || e.key !== 'Escape') return false;
			if (document.activeElement !== inputRef.current) return false;

			e.preventDefault();
			inputRef.current?.blur();
			terminalOutputRef.current?.focus();
			return true;
		},
		[inputRef, terminalOutputRef]
	);

	// Sync selectedSidebarIndex with the active visible thread row.
	useEffect(() => {
		const currentIndex = sidebarNavTargets.findIndex(
			(target) => target.id === activeSidebarNavTargetId
		);
		if (currentIndex !== -1) {
			setSelectedSidebarIndex(currentIndex);
		}
	}, [activeSidebarNavTargetId, sidebarNavTargets, setSelectedSidebarIndex]);

	return {
		handleSidebarNavigation,
		handleTabNavigation,
		handleEnterToActivate,
		handleEscapeInMain,
	};
}
