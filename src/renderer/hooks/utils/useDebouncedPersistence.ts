/**
 * useDebouncedPersistence.ts
 *
 * A hook that debounces session persistence to reduce disk writes.
 * During AI streaming, sessions can change 100+ times per second.
 * This hook batches those changes and writes at most once every 2 seconds.
 *
 * Features:
 * - Configurable debounce delay (default 2 seconds)
 * - Flush-on-unmount to prevent data loss
 * - isPending state for UI feedback
 * - flushNow() for immediate persistence at critical moments
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Session, Thread } from '../../types';
import {
	compactConductorHelperSession,
	isConductorHelperSession,
} from '../../services/conductorSessionLogPolicy';

// Maximum persisted logs per AI tab (matches session persistence limit)
const MAX_PERSISTED_LOGS_PER_TAB = 100;
const MAX_PERSISTED_SESSION_LOGS = 100;
const MAX_PERSISTED_WORK_LOG_ITEMS = 50;
const EMPTY_THREADS: Thread[] = [];

const capTail = <T>(items: T[], maxItems: number): T[] =>
	items.length > maxItems ? items.slice(-maxItems) : items;

/**
 * Prepare a session for persistence by:
 * 1. Filtering out tabs with active wizard state (incomplete wizards should not persist)
 * 2. Truncating logs in each AI tab to MAX_PERSISTED_LOGS_PER_TAB entries
 * 3. Resetting runtime-only state (busy state, thinking time, etc.)
 * 4. Excluding runtime-only fields (closedTabHistory, agentError, etc.)
 *
 * This ensures sessions don't get stuck in busy state after app restart,
 * since underlying processes are gone after restart.
 *
 * Incomplete wizard tabs are discarded because:
 * - They represent temporary wizard sessions that haven't completed
 * - Completed wizards have their wizardState cleared and tab converted to regular sessions
 * - Restoring incomplete wizard state would leave the user in a broken state
 *
 * This is a local copy to avoid circular imports in session persistence logic.
 */
const prepareSessionForPersistence = (session: Session): Session => {
	// If no aiTabs, return as-is (shouldn't happen after migration)
	if (!session.aiTabs || session.aiTabs.length === 0) {
		return session;
	}

	const isConductorHelper = isConductorHelperSession(session);

	// Filter out tabs with active wizard state - incomplete wizards should not persist
	// When a wizard completes, wizardState is cleared (set to undefined) and the tab
	// becomes a regular session that should persist.
	const nonWizardTabs = session.aiTabs.filter((tab) => !tab.wizardState?.isActive);

	// If all tabs were wizard tabs, create a fresh empty tab to avoid empty session
	const tabsToProcess =
		nonWizardTabs.length > 0
			? nonWizardTabs
			: [
					{
						id: session.aiTabs[0].id, // Keep the first tab's ID for consistency
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle' as const,
					},
				];

	// Truncate logs and reset runtime state in each tab
	const truncatedTabs = tabsToProcess.map((tab) => ({
		...tab,
		logs: isConductorHelper ? [] : capTail(tab.logs, MAX_PERSISTED_LOGS_PER_TAB),
		inputValue: isConductorHelper ? '' : tab.inputValue,
		stagedImages: isConductorHelper ? [] : tab.stagedImages,
		// Reset runtime-only tab state - processes don't survive app restart
		state: 'idle' as const,
		thinkingStartTime: undefined,
		agentError: undefined,
		// Clear wizard state entirely from persistence (even inactive wizard state)
		wizardState: undefined,
	}));

	// Return session without runtime-only fields

	const {
		closedTabHistory: _closedTabHistory,
		unifiedClosedTabHistory: _unifiedClosedTabHistory,
		agentError: _agentError,
		agentErrorPaused: _agentErrorPaused,
		agentErrorTabId: _agentErrorTabId,
		sshConnectionFailed: _sshConnectionFailed,
		filePreviewHistory: _filePreviewHistory,
		...sessionWithoutRuntimeFields
	} = session;

	// Ensure activeTabId points to a valid tab (it might have been a wizard tab that got filtered)
	const activeTabExists = truncatedTabs.some((tab) => tab.id === session.activeTabId);
	const newActiveTabId = activeTabExists ? session.activeTabId : truncatedTabs[0]?.id;

	return compactConductorHelperSession({
		...sessionWithoutRuntimeFields,
		aiLogs: capTail(session.aiLogs, MAX_PERSISTED_SESSION_LOGS),
		shellLogs: capTail(session.shellLogs, MAX_PERSISTED_SESSION_LOGS),
		workLog: capTail(session.workLog, MAX_PERSISTED_WORK_LOG_ITEMS),
		aiTabs: truncatedTabs,
		activeTabId: newActiveTabId,
		// Reset runtime-only session state - processes don't survive app restart
		state: 'idle',
		busySource: undefined,
		thinkingStartTime: undefined,
		currentCycleTokens: undefined,
		currentCycleBytes: undefined,
		statusMessage: undefined,
		// Queued work should not survive restart because the backing processes are gone
		// and queued payloads can contain large message/image blobs.
		executionQueue: [],
		// Clear runtime SSH state - these are populated from process:ssh-remote event after each spawn
		// They represent the state of the LAST spawn, not configuration. On app restart,
		// they'll be repopulated based on sessionSshRemoteConfig when the agent next spawns.
		// Persisting them could cause stale SSH state to leak across restarts.
		sshRemote: undefined,
		sshRemoteId: undefined,
		remoteCwd: undefined,
		// Don't persist file tree — it's ephemeral cache data, not state.
		// Trees re-scan automatically on session activation via useFileTreeManagement.
		// For users with large working directories (100K+ files), persisting the tree
		// caused sessions.json to balloon to 300MB+.
		fileTree: [],
		fileTreeStats: undefined,
		fileTreeTruncated: undefined,
		fileTreeLoading: undefined,
		fileTreeLoadingProgress: undefined,
		fileTreeLastScanTime: undefined,
		// Don't persist file preview history — stores full file content that can be
		// re-read from disk on demand. Another major contributor to session file bloat.
		filePreviewHistory: undefined,
		filePreviewHistoryIndex: undefined,
		// Type assertion: this function deliberately strips runtime-only and cache
		// fields from Session for persistence. The resulting object is a valid
		// persisted session but missing non-persisted fields.
	} as unknown as Session);
};

export interface UseDebouncedPersistenceReturn {
	/** True if there are pending changes that haven't been persisted yet */
	isPending: boolean;
	/** Force immediate persistence of pending changes */
	flushNow: (force?: boolean) => void;
}

/** Default debounce delay in milliseconds */
export const DEFAULT_DEBOUNCE_DELAY = 2000;

type InitialLoadCompleteRef = React.MutableRefObject<boolean>;

/**
 * Hook that debounces session persistence to reduce disk writes.
 *
 * @param sessions - Array of sessions to persist
 * @param threads - Threads to persist alongside sessions
 * @param initialLoadComplete - Ref indicating if initial load is done (prevents persisting on mount)
 * @param delay - Debounce delay in milliseconds (default 2000)
 * @returns Object with isPending state and flushNow function
 */
export function useDebouncedPersistence(
	sessions: Session[],
	initialLoadComplete: InitialLoadCompleteRef,
	delay?: number
): UseDebouncedPersistenceReturn;

export function useDebouncedPersistence(
	sessions: Session[],
	threads: Thread[],
	initialLoadComplete: InitialLoadCompleteRef,
	delay?: number
): UseDebouncedPersistenceReturn;

export function useDebouncedPersistence(
	sessions: Session[],
	threadsOrInitialLoadComplete: Thread[] | InitialLoadCompleteRef,
	initialLoadCompleteOrDelay?: InitialLoadCompleteRef | number,
	delay: number = DEFAULT_DEBOUNCE_DELAY
): UseDebouncedPersistenceReturn {
	const threads = Array.isArray(threadsOrInitialLoadComplete)
		? threadsOrInitialLoadComplete
		: EMPTY_THREADS;
	const initialLoadComplete = Array.isArray(threadsOrInitialLoadComplete)
		? (initialLoadCompleteOrDelay as InitialLoadCompleteRef | undefined)
		: threadsOrInitialLoadComplete;
	const resolvedDelay =
		typeof initialLoadCompleteOrDelay === 'number' ? initialLoadCompleteOrDelay : delay;

	if (!initialLoadComplete) {
		throw new Error('useDebouncedPersistence requires an initialLoadComplete ref');
	}

	// Track if there are pending changes
	const [isPending, setIsPending] = useState(false);

	// Store the latest sessions in a ref for access in flush callbacks
	const sessionsRef = useRef<Session[]>(sessions);
	sessionsRef.current = sessions;
	const threadsRef = useRef<Thread[]>(threads);
	threadsRef.current = threads;

	// Store the timer ID for cleanup
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Track if flush is in progress to prevent double-flushing
	const flushingRef = useRef(false);

	/**
	 * Internal function to persist sessions immediately.
	 * Called by both the debounce timer and flushNow.
	 */
	const persistSessions = useCallback(() => {
		if (flushingRef.current) return;

		flushingRef.current = true;
		try {
			const sessionsForPersistence = sessionsRef.current.map(prepareSessionForPersistence);
			window.maestro.sessions.setAll(sessionsForPersistence);
			window.maestro.threads?.setAll?.(threadsRef.current);
			setIsPending(false);
		} finally {
			flushingRef.current = false;
		}
	}, []);

	/**
	 * Force immediate persistence of pending changes.
	 * Use this for critical moments like:
	 * - Session deletion/rename
	 * - App quit/visibility change
	 * - Tab switching
	 */
	const flushNow = useCallback(
		(force: boolean = false) => {
			// Clear any pending timer
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}

			// Only flush if there are pending changes
			if (force || isPending) {
				persistSessions();
			}
		},
		[isPending, persistSessions]
	);

	// Debounced persistence effect
	useEffect(() => {
		// Skip persistence during initial load
		if (!initialLoadComplete.current) {
			return;
		}

		// Mark as pending
		setIsPending(true);

		// Clear existing timer
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}

		// Set new debounce timer
		timerRef.current = setTimeout(() => {
			persistSessions();
			timerRef.current = null;
		}, resolvedDelay);

		// Cleanup on unmount or when sessions change
		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		};
	}, [sessions, threads, resolvedDelay, initialLoadComplete, persistSessions]);

	// Flush on unmount to prevent data loss
	useEffect(() => {
		return () => {
			// On unmount, if there are pending changes, persist immediately
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			// Only flush if initial load is complete - otherwise we might save an empty array
			// before sessions have been loaded, wiping out the user's data
			if (initialLoadComplete.current) {
				const sessionsForPersistence = sessionsRef.current.map(prepareSessionForPersistence);
				window.maestro.sessions.setAll(sessionsForPersistence);
				window.maestro.threads?.setAll?.(threadsRef.current);
			}
		};
	}, []);

	// Flush on visibility change (user switching away from app)
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.hidden && isPending) {
				flushNow();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [isPending, flushNow]);

	// Flush on beforeunload (app closing)
	useEffect(() => {
		const handleBeforeUnload = () => {
			if (isPending) {
				// Synchronous flush for beforeunload
				const sessionsForPersistence = sessionsRef.current.map(prepareSessionForPersistence);
				window.maestro.sessions.setAll(sessionsForPersistence);
				window.maestro.threads?.setAll?.(threadsRef.current);
			}
		};

		window.addEventListener('beforeunload', handleBeforeUnload);

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload);
		};
	}, [isPending]);

	return { isPending, flushNow };
}
