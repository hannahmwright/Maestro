import { useMemo } from 'react';
import type { Session, Group } from '../../types';
import { stripLeadingEmojis, compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';

// Re-export for backwards compatibility with existing imports
export { stripLeadingEmojis, compareNamesIgnoringEmojis };

/**
 * Dependencies for the useSortedSessions hook.
 */
export interface UseSortedSessionsDeps {
	/** All sessions */
	sessions: Session[];
	/** All groups */
	groups: Group[];
	/** Whether the bookmarks folder is collapsed */
	bookmarksCollapsed: boolean;
}

/**
 * Return type for useSortedSessions hook.
 */
export interface UseSortedSessionsReturn {
	/** All sessions sorted by group then alphabetically (ignoring leading emojis) */
	sortedSessions: Session[];
}

/**
 * Hook for computing sorted and visible session lists.
 *
 * This hook handles:
 * 1. sortedSessions - All sessions sorted by group membership, then alphabetically
 *    (ignoring leading emojis for proper alphabetization)
 * @param deps - Hook dependencies containing sessions, groups, and collapse state
 * @returns Sorted session array
 */
export function useSortedSessions(deps: UseSortedSessionsDeps): UseSortedSessionsReturn {
	const { sessions, groups, bookmarksCollapsed } = deps;

	// Memoize worktree children lookup for O(1) access instead of O(n) per parent
	// This reduces complexity from O(n²) to O(n) when building sorted sessions
	const worktreeChildrenByParent = useMemo(() => {
		const map = new Map<string, Session[]>();
		for (const s of sessions) {
			if (s.parentSessionId) {
				const existing = map.get(s.parentSessionId);
				if (existing) {
					existing.push(s);
				} else {
					map.set(s.parentSessionId, [s]);
				}
			}
		}
		// Sort each group once
		for (const [, children] of map) {
			children.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		}
		return map;
	}, [sessions]);

	// Create sorted sessions array that matches visual display order (includes ALL sessions)
	// Note: sorting ignores leading emojis for proper alphabetization
	// Worktree children are inserted after their parent when the parent's worktrees are expanded
	const sortedSessions = useMemo(() => {
		const sorted: Session[] = [];

		// Helper to add session with its worktree children - now O(1) lookup
		const addSessionWithWorktrees = (session: Session) => {
			// Skip worktree children - they're added with their parent
			if (session.parentSessionId) return;

			sorted.push(session);

			// Add worktree children if expanded
			if (session.worktreesExpanded !== false) {
				const children = worktreeChildrenByParent.get(session.id);
				if (children) {
					sorted.push(...children);
				}
			}
		};

		// First, add sessions from sorted groups (ignoring leading emojis)
		const sortedGroups = [...groups]
			.filter((group) => !group.archived)
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		sortedGroups.forEach((group) => {
			const groupSessions = sessions
				.filter((s) => s.groupId === group.id && !s.parentSessionId)
				.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
			groupSessions.forEach(addSessionWithWorktrees);
		});

		// Then, add ungrouped sessions (sorted alphabetically, ignoring leading emojis)
		const ungroupedSessions = sessions
			.filter((s) => !s.groupId && !s.parentSessionId)
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		ungroupedSessions.forEach(addSessionWithWorktrees);

		return sorted;
	}, [sessions, groups, worktreeChildrenByParent]);

	return {
		sortedSessions,
	};
}
