/**
 * CallbackRegistry - Manages callback functions for the WebServer
 *
 * Centralizes all callback storage and provides typed getter/setter methods.
 * This separates callback management from the core WebServer logic.
 */

import { logger } from '../../utils/logger';
import type { ToolType } from '../../../shared/types';
import type {
	GetSessionsCallback,
	GetSessionDetailCallback,
	GetSessionModelsCallback,
	GetSessionModelCatalogCallback,
	GetSessionProviderUsageCallback,
	GetConductorSnapshotCallback,
	GetSessionDemosCallback,
	GetDemoDetailCallback,
	GetArtifactContentCallback,
	GetSessionLocalFileCallback,
	GetVoiceTranscriptionStatusCallback,
	PrewarmVoiceTranscriptionCallback,
	TranscribeAudioCallback,
	WriteToSessionCallback,
	ExecuteCommandCallback,
	InterruptSessionCallback,
	SetSessionModelCallback,
	SwitchModeCallback,
	SelectSessionCallback,
	SelectTabCallback,
	NewTabCallback,
	NewThreadCallback,
	ForkThreadCallback,
	DeleteSessionCallback,
	CloseTabCallback,
	RenameTabCallback,
	StarTabCallback,
	ReorderTabCallback,
	ToggleBookmarkCallback,
	CreateConductorTaskCallback,
	UpdateConductorTaskCallback,
	DeleteConductorTaskCallback,
	OpenConductorWorkspaceCallback,
	GetThemeCallback,
	GetCustomCommandsCallback,
	GetHistoryCallback,
} from '../types';

const LOG_CONTEXT = 'CallbackRegistry';

/**
 * All callback types supported by the WebServer
 */
export interface WebServerCallbacks {
	getSessions: GetSessionsCallback | null;
	getSessionDetail: GetSessionDetailCallback | null;
	getSessionModels: GetSessionModelsCallback | null;
	getSessionModelCatalog: GetSessionModelCatalogCallback | null;
	getSessionProviderUsage: GetSessionProviderUsageCallback | null;
	getConductorSnapshot: GetConductorSnapshotCallback | null;
	getSessionDemos: GetSessionDemosCallback | null;
	getDemoDetail: GetDemoDetailCallback | null;
	getArtifactContent: GetArtifactContentCallback | null;
	getSessionLocalFile: GetSessionLocalFileCallback | null;
	getTheme: GetThemeCallback | null;
	getCustomCommands: GetCustomCommandsCallback | null;
	transcribeAudio: TranscribeAudioCallback | null;
	getVoiceTranscriptionStatus: GetVoiceTranscriptionStatusCallback | null;
	prewarmVoiceTranscription: PrewarmVoiceTranscriptionCallback | null;
	writeToSession: WriteToSessionCallback | null;
	executeCommand: ExecuteCommandCallback | null;
	interruptSession: InterruptSessionCallback | null;
	setSessionModel: SetSessionModelCallback | null;
	switchMode: SwitchModeCallback | null;
	selectSession: SelectSessionCallback | null;
	selectTab: SelectTabCallback | null;
	newTab: NewTabCallback | null;
	newThread: NewThreadCallback | null;
	forkThread: ForkThreadCallback | null;
	deleteSession: DeleteSessionCallback | null;
	closeTab: CloseTabCallback | null;
	renameTab: RenameTabCallback | null;
	starTab: StarTabCallback | null;
	reorderTab: ReorderTabCallback | null;
	toggleBookmark: ToggleBookmarkCallback | null;
	createConductorTask: CreateConductorTaskCallback | null;
	updateConductorTask: UpdateConductorTaskCallback | null;
	deleteConductorTask: DeleteConductorTaskCallback | null;
	openConductorWorkspace: OpenConductorWorkspaceCallback | null;
	getHistory: GetHistoryCallback | null;
}

export class CallbackRegistry {
	private callbacks: WebServerCallbacks = {
		getSessions: null,
		getSessionDetail: null,
		getSessionModels: null,
		getSessionModelCatalog: null,
		getSessionProviderUsage: null,
		getConductorSnapshot: null,
		getSessionDemos: null,
		getDemoDetail: null,
		getArtifactContent: null,
		getSessionLocalFile: null,
		getTheme: null,
		getCustomCommands: null,
		transcribeAudio: null,
		getVoiceTranscriptionStatus: null,
		prewarmVoiceTranscription: null,
		writeToSession: null,
		executeCommand: null,
		interruptSession: null,
		setSessionModel: null,
		switchMode: null,
		selectSession: null,
		selectTab: null,
		newTab: null,
		newThread: null,
		forkThread: null,
		deleteSession: null,
		closeTab: null,
		renameTab: null,
		starTab: null,
		reorderTab: null,
		toggleBookmark: null,
		createConductorTask: null,
		updateConductorTask: null,
		deleteConductorTask: null,
		openConductorWorkspace: null,
		getHistory: null,
	};

	// ============ Getter Methods ============

	async getSessions(): Promise<Awaited<ReturnType<GetSessionsCallback>> | []> {
		return (await this.callbacks.getSessions?.()) ?? [];
	}

	getSessionDetail(sessionId: string, tabId?: string): ReturnType<GetSessionDetailCallback> | null {
		return this.callbacks.getSessionDetail?.(sessionId, tabId) ?? null;
	}

	async getSessionModels(
		sessionId: string,
		forceRefresh?: boolean
	): Promise<Awaited<ReturnType<GetSessionModelsCallback>> | []> {
		return (await this.callbacks.getSessionModels?.(sessionId, forceRefresh)) ?? [];
	}

	async getSessionModelCatalog(
		sessionId: string,
		forceRefresh?: boolean
	): Promise<Awaited<ReturnType<GetSessionModelCatalogCallback>> | []> {
		return (await this.callbacks.getSessionModelCatalog?.(sessionId, forceRefresh)) ?? [];
	}

	async getSessionProviderUsage(
		sessionId: string,
		forceRefresh?: boolean
	): Promise<Awaited<ReturnType<GetSessionProviderUsageCallback>> | null> {
		return (await this.callbacks.getSessionProviderUsage?.(sessionId, forceRefresh)) ?? null;
	}

	async getConductorSnapshot(): Promise<Awaited<ReturnType<GetConductorSnapshotCallback>> | null> {
		return (await this.callbacks.getConductorSnapshot?.()) ?? null;
	}

	async getSessionDemos(sessionId: string, tabId?: string | null) {
		return (await this.callbacks.getSessionDemos?.(sessionId, tabId)) ?? [];
	}

	async getDemoDetail(demoId: string) {
		return (await this.callbacks.getDemoDetail?.(demoId)) ?? null;
	}

	async getArtifactContent(artifactId: string) {
		return (await this.callbacks.getArtifactContent?.(artifactId)) ?? null;
	}

	async getSessionLocalFile(sessionId: string, requestedPath: string) {
		return (
			(await this.callbacks.getSessionLocalFile?.(sessionId, requestedPath)) ?? {
				errorCode: 503,
				message: 'Local file streaming is not configured.',
			}
		);
	}

	getTheme(): ReturnType<GetThemeCallback> | null {
		return this.callbacks.getTheme?.() ?? null;
	}

	getCustomCommands(): ReturnType<GetCustomCommandsCallback> | [] {
		return this.callbacks.getCustomCommands?.() ?? [];
	}

	async transcribeAudio(
		request: Parameters<TranscribeAudioCallback>[0]
	): Promise<Awaited<ReturnType<TranscribeAudioCallback>> | null> {
		if (!this.callbacks.transcribeAudio) return null;
		return this.callbacks.transcribeAudio(request);
	}

	async getVoiceTranscriptionStatus(): Promise<Awaited<
		ReturnType<GetVoiceTranscriptionStatusCallback>
	> | null> {
		if (!this.callbacks.getVoiceTranscriptionStatus) return null;
		return this.callbacks.getVoiceTranscriptionStatus();
	}

	async prewarmVoiceTranscription(): Promise<Awaited<
		ReturnType<PrewarmVoiceTranscriptionCallback>
	> | null> {
		if (!this.callbacks.prewarmVoiceTranscription) return null;
		return this.callbacks.prewarmVoiceTranscription();
	}

	writeToSession(sessionId: string, data: string): boolean {
		return this.callbacks.writeToSession?.(sessionId, data) ?? false;
	}

	async executeCommand(
		sessionId: string,
		command: string,
		inputMode?: 'ai' | 'terminal',
		commandAction?: 'default' | 'queue',
		images?: string[],
		textAttachments?: Array<{
			id?: string;
			name: string;
			content: string;
			mimeType?: string;
			size?: number;
		}>,
		attachments?: Array<{
			id?: string;
			kind: 'image' | 'file';
			name: string;
			mimeType?: string;
			size?: number;
		}>,
		demoCapture?: import('../../../shared/demo-artifacts').DemoCaptureRequest
	): Promise<boolean> {
		if (!this.callbacks.executeCommand) return false;
		return this.callbacks.executeCommand(
			sessionId,
			command,
			inputMode,
			commandAction,
			images,
			textAttachments,
			attachments,
			demoCapture
		);
	}

	async interruptSession(sessionId: string): Promise<boolean> {
		return this.callbacks.interruptSession?.(sessionId) ?? false;
	}

	async setSessionModel(sessionId: string, model: string | null): Promise<boolean> {
		if (!this.callbacks.setSessionModel) return false;
		return this.callbacks.setSessionModel(sessionId, model);
	}

	async switchMode(sessionId: string, mode: 'ai' | 'terminal'): Promise<boolean> {
		if (!this.callbacks.switchMode) return false;
		return this.callbacks.switchMode(sessionId, mode);
	}

	async selectSession(sessionId: string, tabId?: string): Promise<boolean> {
		if (!this.callbacks.selectSession) return false;
		return this.callbacks.selectSession(sessionId, tabId);
	}

	async selectTab(sessionId: string, tabId: string): Promise<boolean> {
		if (!this.callbacks.selectTab) return false;
		return this.callbacks.selectTab(sessionId, tabId);
	}

	async newTab(sessionId: string): Promise<{ tabId: string } | null> {
		if (!this.callbacks.newTab) return null;
		return this.callbacks.newTab(sessionId);
	}

	async newThread(sessionId: string): Promise<boolean> {
		if (!this.callbacks.newThread) return false;
		return this.callbacks.newThread(sessionId);
	}

	async forkThread(
		sessionId: string,
		options?: {
			toolType?: ToolType;
			model?: string | null;
		}
	): Promise<{ success: boolean; sessionId?: string | null }> {
		if (!this.callbacks.forkThread) return { success: false };
		return this.callbacks.forkThread(sessionId, options);
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		if (!this.callbacks.deleteSession) return false;
		return this.callbacks.deleteSession(sessionId);
	}

	async closeTab(sessionId: string, tabId: string): Promise<boolean> {
		if (!this.callbacks.closeTab) return false;
		return this.callbacks.closeTab(sessionId, tabId);
	}

	async renameTab(sessionId: string, tabId: string, newName: string): Promise<boolean> {
		if (!this.callbacks.renameTab) return false;
		return this.callbacks.renameTab(sessionId, tabId, newName);
	}

	async starTab(sessionId: string, tabId: string, starred: boolean): Promise<boolean> {
		if (!this.callbacks.starTab) return false;
		return this.callbacks.starTab(sessionId, tabId, starred);
	}

	async reorderTab(sessionId: string, fromIndex: number, toIndex: number): Promise<boolean> {
		if (!this.callbacks.reorderTab) return false;
		return this.callbacks.reorderTab(sessionId, fromIndex, toIndex);
	}

	async toggleBookmark(sessionId: string): Promise<boolean> {
		if (!this.callbacks.toggleBookmark) return false;
		return this.callbacks.toggleBookmark(sessionId);
	}

	async createConductorTask(input: Parameters<CreateConductorTaskCallback>[0]): Promise<boolean> {
		if (!this.callbacks.createConductorTask) return false;
		return this.callbacks.createConductorTask(input);
	}

	async updateConductorTask(
		taskId: string,
		updates: Parameters<UpdateConductorTaskCallback>[1]
	): Promise<boolean> {
		if (!this.callbacks.updateConductorTask) return false;
		return this.callbacks.updateConductorTask(taskId, updates);
	}

	async deleteConductorTask(taskId: string): Promise<boolean> {
		if (!this.callbacks.deleteConductorTask) return false;
		return this.callbacks.deleteConductorTask(taskId);
	}

	async openConductorWorkspace(groupId: string): Promise<boolean> {
		if (!this.callbacks.openConductorWorkspace) return false;
		return this.callbacks.openConductorWorkspace(groupId);
	}

	getHistory(projectPath?: string, sessionId?: string): ReturnType<GetHistoryCallback> | [] {
		return this.callbacks.getHistory?.(projectPath, sessionId) ?? [];
	}

	// ============ Setter Methods ============

	setGetSessionsCallback(callback: GetSessionsCallback): void {
		this.callbacks.getSessions = callback;
	}

	setGetSessionDetailCallback(callback: GetSessionDetailCallback): void {
		this.callbacks.getSessionDetail = callback;
	}

	setGetSessionModelsCallback(callback: GetSessionModelsCallback): void {
		this.callbacks.getSessionModels = callback;
	}

	setGetSessionModelCatalogCallback(callback: GetSessionModelCatalogCallback): void {
		this.callbacks.getSessionModelCatalog = callback;
	}

	setGetSessionProviderUsageCallback(callback: GetSessionProviderUsageCallback): void {
		this.callbacks.getSessionProviderUsage = callback;
	}

	setGetConductorSnapshotCallback(callback: GetConductorSnapshotCallback): void {
		this.callbacks.getConductorSnapshot = callback;
	}

	setGetSessionDemosCallback(callback: GetSessionDemosCallback): void {
		this.callbacks.getSessionDemos = callback;
	}

	setGetDemoDetailCallback(callback: GetDemoDetailCallback): void {
		this.callbacks.getDemoDetail = callback;
	}

	setGetArtifactContentCallback(callback: GetArtifactContentCallback): void {
		this.callbacks.getArtifactContent = callback;
	}

	setGetSessionLocalFileCallback(callback: GetSessionLocalFileCallback): void {
		this.callbacks.getSessionLocalFile = callback;
	}

	setGetThemeCallback(callback: GetThemeCallback): void {
		this.callbacks.getTheme = callback;
	}

	setGetCustomCommandsCallback(callback: GetCustomCommandsCallback): void {
		this.callbacks.getCustomCommands = callback;
	}

	setTranscribeAudioCallback(callback: TranscribeAudioCallback): void {
		this.callbacks.transcribeAudio = callback;
	}

	setGetVoiceTranscriptionStatusCallback(callback: GetVoiceTranscriptionStatusCallback): void {
		this.callbacks.getVoiceTranscriptionStatus = callback;
	}

	setPrewarmVoiceTranscriptionCallback(callback: PrewarmVoiceTranscriptionCallback): void {
		this.callbacks.prewarmVoiceTranscription = callback;
	}

	setWriteToSessionCallback(callback: WriteToSessionCallback): void {
		this.callbacks.writeToSession = callback;
	}

	setExecuteCommandCallback(callback: ExecuteCommandCallback): void {
		this.callbacks.executeCommand = callback;
	}

	setInterruptSessionCallback(callback: InterruptSessionCallback): void {
		this.callbacks.interruptSession = callback;
	}

	setSetSessionModelCallback(callback: SetSessionModelCallback): void {
		this.callbacks.setSessionModel = callback;
	}

	setSwitchModeCallback(callback: SwitchModeCallback): void {
		logger.info('[CallbackRegistry] setSwitchModeCallback called', LOG_CONTEXT);
		this.callbacks.switchMode = callback;
	}

	setSelectSessionCallback(callback: SelectSessionCallback): void {
		logger.info('[CallbackRegistry] setSelectSessionCallback called', LOG_CONTEXT);
		this.callbacks.selectSession = callback;
	}

	setSelectTabCallback(callback: SelectTabCallback): void {
		logger.info('[CallbackRegistry] setSelectTabCallback called', LOG_CONTEXT);
		this.callbacks.selectTab = callback;
	}

	setNewTabCallback(callback: NewTabCallback): void {
		logger.info('[CallbackRegistry] setNewTabCallback called', LOG_CONTEXT);
		this.callbacks.newTab = callback;
	}

	setNewThreadCallback(callback: NewThreadCallback): void {
		logger.info('[CallbackRegistry] setNewThreadCallback called', LOG_CONTEXT);
		this.callbacks.newThread = callback;
	}

	setForkThreadCallback(callback: ForkThreadCallback): void {
		this.callbacks.forkThread = callback;
	}

	setDeleteSessionCallback(callback: DeleteSessionCallback): void {
		this.callbacks.deleteSession = callback;
	}

	setCloseTabCallback(callback: CloseTabCallback): void {
		logger.info('[CallbackRegistry] setCloseTabCallback called', LOG_CONTEXT);
		this.callbacks.closeTab = callback;
	}

	setRenameTabCallback(callback: RenameTabCallback): void {
		logger.info('[CallbackRegistry] setRenameTabCallback called', LOG_CONTEXT);
		this.callbacks.renameTab = callback;
	}

	setStarTabCallback(callback: StarTabCallback): void {
		this.callbacks.starTab = callback;
	}

	setReorderTabCallback(callback: ReorderTabCallback): void {
		this.callbacks.reorderTab = callback;
	}

	setToggleBookmarkCallback(callback: ToggleBookmarkCallback): void {
		this.callbacks.toggleBookmark = callback;
	}

	setCreateConductorTaskCallback(callback: CreateConductorTaskCallback): void {
		this.callbacks.createConductorTask = callback;
	}

	setUpdateConductorTaskCallback(callback: UpdateConductorTaskCallback): void {
		this.callbacks.updateConductorTask = callback;
	}

	setDeleteConductorTaskCallback(callback: DeleteConductorTaskCallback): void {
		this.callbacks.deleteConductorTask = callback;
	}

	setOpenConductorWorkspaceCallback(callback: OpenConductorWorkspaceCallback): void {
		this.callbacks.openConductorWorkspace = callback;
	}

	setGetHistoryCallback(callback: GetHistoryCallback): void {
		this.callbacks.getHistory = callback;
	}

	// ============ Check Methods ============

	hasCallback(name: keyof WebServerCallbacks): boolean {
		return this.callbacks[name] !== null;
	}
}
