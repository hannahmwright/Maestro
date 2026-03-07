/**
 * CallbackRegistry - Manages callback functions for the WebServer
 *
 * Centralizes all callback storage and provides typed getter/setter methods.
 * This separates callback management from the core WebServer logic.
 */

import { logger } from '../../utils/logger';
import type {
	GetSessionsCallback,
	GetSessionDetailCallback,
	GetSessionModelsCallback,
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
	DeleteSessionCallback,
	CloseTabCallback,
	RenameTabCallback,
	StarTabCallback,
	ReorderTabCallback,
	ToggleBookmarkCallback,
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
	deleteSession: DeleteSessionCallback | null;
	closeTab: CloseTabCallback | null;
	renameTab: RenameTabCallback | null;
	starTab: StarTabCallback | null;
	reorderTab: ReorderTabCallback | null;
	toggleBookmark: ToggleBookmarkCallback | null;
	getHistory: GetHistoryCallback | null;
}

export class CallbackRegistry {
	private callbacks: WebServerCallbacks = {
		getSessions: null,
		getSessionDetail: null,
		getSessionModels: null,
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
		deleteSession: null,
		closeTab: null,
		renameTab: null,
		starTab: null,
		reorderTab: null,
		toggleBookmark: null,
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
		}>
	): Promise<boolean> {
		if (!this.callbacks.executeCommand) return false;
		return this.callbacks.executeCommand(
			sessionId,
			command,
			inputMode,
			images,
			textAttachments,
			attachments
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

	setGetHistoryCallback(callback: GetHistoryCallback): void {
		this.callbacks.getHistory = callback;
	}

	// ============ Check Methods ============

	hasCallback(name: keyof WebServerCallbacks): boolean {
		return this.callbacks[name] !== null;
	}
}
