/**
 * useSessionListProps Hook
 *
 * Assembles handler props for the SessionList component.
 * Data/state props are now read directly from Zustand stores inside SessionList.
 * This hook only passes computed values that aren't raw store fields, plus
 * domain-logic handlers.
 */

import { useMemo } from 'react';
import type { Session, Theme } from '../../types';

/**
 * Dependencies for computing SessionList props.
 * Only computed values and domain handlers remain — stores are read directly inside the component.
 */
export interface UseSessionListPropsDeps {
	// Theme (computed from settingsStore by App.tsx — not a raw store value)
	theme: Theme;

	// Computed values (not raw store fields)
	isLiveMode: boolean;
	webInterfaceUrl: string | null;
	showSessionJumpNumbers: boolean;

	// Ref
	sidebarContainerRef: React.RefObject<HTMLDivElement>;

	// Domain handlers
	toggleGlobalLive: () => Promise<void>;
	restartWebServer: () => Promise<string | null>;
	toggleGroup: (groupId: string) => void;
	handleDragStart: (sessionId: string) => void;
	finishRenamingGroup: (groupId: string, newName: string) => void;
	startRenamingGroup: (groupId: string) => void;
	startRenamingSession: (sessId: string) => void;
	createNewGroup: () => void;
	addNewSession: () => void;
	createNewSession: (
		agentId: string,
		workingDir: string,
		name: string,
		nudgeMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		customProviderPath?: string,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		},
		workspaceId?: string
	) => Promise<void>;
	deleteSession: (id: string) => void;
	deleteWorktreeGroup: (groupId: string) => void;
	handleEditAgent: (session: Session) => void;
	handleOpenCreatePRSession: (session: Session) => void;
	handleQuickCreateWorktree: (session: Session) => void;
	handleOpenWorktreeConfigSession: (session: Session) => void;
	handleDeleteWorktreeSession: (session: Session) => void;
	openWizardModal: () => void;
	handleStartTour: () => void;
	handleOpenConductor: (groupId: string) => void;
	handleOpenConductorHome: () => void;

	// Group Chat handlers
	handleOpenGroupChat: (id: string) => void;
	handleNewGroupChat: () => void;
	handleEditGroupChat: (id: string) => void;
	handleOpenRenameGroupChatModal: (id: string) => void;
	handleOpenDeleteGroupChatModal: (id: string) => void;
	handleArchiveGroupChat: (id: string, archived: boolean) => void;
}

/**
 * Hook to compute and memoize SessionList props.
 *
 * @param deps - Handler functions and externally-computed values
 * @returns Memoized props object for SessionList
 */
export function useSessionListProps(deps: UseSessionListPropsDeps) {
	return useMemo(
		() => ({
			// Theme & computed values
			theme: deps.theme,
			isLiveMode: deps.isLiveMode,
			webInterfaceUrl: deps.webInterfaceUrl,
			showSessionJumpNumbers: deps.showSessionJumpNumbers,

			// Ref
			sidebarContainerRef: deps.sidebarContainerRef,

			// Domain handlers
			toggleGlobalLive: deps.toggleGlobalLive,
			restartWebServer: deps.restartWebServer,
			toggleGroup: deps.toggleGroup,
			handleDragStart: deps.handleDragStart,
			finishRenamingGroup: deps.finishRenamingGroup,
			startRenamingGroup: deps.startRenamingGroup,
			startRenamingSession: deps.startRenamingSession,
			createNewGroup: deps.createNewGroup,
			addNewSession: deps.addNewSession,
			onCreateSession: deps.createNewSession,
			onDeleteSession: deps.deleteSession,
			onDeleteWorktreeGroup: deps.deleteWorktreeGroup,
			onEditAgent: deps.handleEditAgent,
			onNewAgentSession: deps.addNewSession,
			onOpenCreatePR: deps.handleOpenCreatePRSession,
			onQuickCreateWorktree: deps.handleQuickCreateWorktree,
			onOpenWorktreeConfig: deps.handleOpenWorktreeConfigSession,
			onDeleteWorktree: deps.handleDeleteWorktreeSession,
			openWizard: deps.openWizardModal,
			startTour: deps.handleStartTour,
			onOpenConductor: deps.handleOpenConductor,
			onOpenConductorHome: deps.handleOpenConductorHome,

			// Group Chat handlers
			onOpenGroupChat: deps.handleOpenGroupChat,
			onNewGroupChat: deps.handleNewGroupChat,
			onEditGroupChat: deps.handleEditGroupChat,
			onRenameGroupChat: deps.handleOpenRenameGroupChatModal,
			onDeleteGroupChat: deps.handleOpenDeleteGroupChatModal,
			onArchiveGroupChat: deps.handleArchiveGroupChat,
		}),
		[
			deps.theme,
			deps.isLiveMode,
			deps.webInterfaceUrl,
			deps.showSessionJumpNumbers,
			deps.sidebarContainerRef,
			// Stable callbacks
			deps.toggleGlobalLive,
			deps.restartWebServer,
			deps.toggleGroup,
			deps.handleDragStart,
			deps.finishRenamingGroup,
			deps.startRenamingGroup,
			deps.startRenamingSession,
			deps.createNewGroup,
			deps.addNewSession,
			deps.createNewSession,
			deps.deleteSession,
			deps.deleteWorktreeGroup,
			deps.handleEditAgent,
			deps.handleOpenCreatePRSession,
			deps.handleQuickCreateWorktree,
			deps.handleOpenWorktreeConfigSession,
			deps.handleDeleteWorktreeSession,
			deps.openWizardModal,
			deps.handleStartTour,
			deps.handleOpenConductor,
			deps.handleOpenConductorHome,
			deps.handleOpenGroupChat,
			deps.handleNewGroupChat,
			deps.handleEditGroupChat,
			deps.handleOpenRenameGroupChatModal,
			deps.handleOpenDeleteGroupChatModal,
			deps.handleArchiveGroupChat,
		]
	);
}
