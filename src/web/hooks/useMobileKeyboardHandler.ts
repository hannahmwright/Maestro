/**
 * useMobileKeyboardHandler - Mobile keyboard shortcuts handler hook
 *
 * Handles keyboard shortcuts for the mobile web interface:
 * - Cmd+[ / Ctrl+[: Switch to previous tab
 * - Cmd+] / Ctrl+]: Switch to next tab
 *
 * Extracted from mobile App.tsx for code organization.
 *
 * @example
 * ```tsx
 * useMobileKeyboardHandler({
 *   activeSessionId,
 *   activeSession,
 *   handleSelectTab,
 * });
 * ```
 */

import { useEffect } from 'react';
import type { AITabData } from './useWebSocket';

/**
 * Session type for the mobile keyboard handler
 * Only includes fields needed for keyboard handling
 * Kept minimal to accept any object with these optional fields
 */
export type MobileKeyboardSession = {
	/** Current input mode */
	inputMode?: string;
	/** Array of AI tabs */
	aiTabs?: AITabData[];
	/** Currently active tab ID */
	activeTabId?: string;
};

/**
 * Dependencies for useMobileKeyboardHandler
 */
export interface UseMobileKeyboardHandlerDeps {
	/** ID of the currently active session */
	activeSessionId: string | null;
	/** The currently active session object */
	activeSession: MobileKeyboardSession | null | undefined;
	/** Handler to select a tab */
	handleSelectTab: (tabId: string) => void;
}

/**
 * Hook for handling keyboard shortcuts in the mobile web interface
 *
 * Registers event listeners for keyboard shortcuts and invokes the
 * appropriate handlers when shortcuts are pressed.
 *
 * @param deps - Dependencies including session state and handlers
 */
export function useMobileKeyboardHandler(deps: UseMobileKeyboardHandlerDeps): void {
	const { activeSessionId, activeSession, handleSelectTab } = deps;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Cmd+[ or Ctrl+[ - Previous tab
			if ((e.metaKey || e.ctrlKey) && e.key === '[') {
				e.preventDefault();
				if (!activeSession?.aiTabs || activeSession.aiTabs.length < 2) return;

				const currentIndex = activeSession.aiTabs.findIndex(
					(t) => t.id === activeSession.activeTabId
				);
				if (currentIndex === -1) return;

				// Wrap around to last tab if at beginning
				const prevIndex =
					(currentIndex - 1 + activeSession.aiTabs.length) % activeSession.aiTabs.length;
				const prevTab = activeSession.aiTabs[prevIndex];
				handleSelectTab(prevTab.id);
				return;
			}

			// Cmd+] or Ctrl+] - Next tab
			if ((e.metaKey || e.ctrlKey) && e.key === ']') {
				e.preventDefault();
				if (!activeSession?.aiTabs || activeSession.aiTabs.length < 2) return;

				const currentIndex = activeSession.aiTabs.findIndex(
					(t) => t.id === activeSession.activeTabId
				);
				if (currentIndex === -1) return;

				// Wrap around to first tab if at end
				const nextIndex = (currentIndex + 1) % activeSession.aiTabs.length;
				const nextTab = activeSession.aiTabs[nextIndex];
				handleSelectTab(nextTab.id);
				return;
			}
		};

		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [activeSessionId, activeSession, handleSelectTab]);
}

export default useMobileKeyboardHandler;
