import { ipcRenderer } from 'electron';
import type {
	DemoArtifactHarvestRequest,
	DemoCard,
	DemoDetail,
} from '../../shared/demo-artifacts';

export interface ArtifactFileInfo {
	id: string;
	path: string;
	mimeType: string;
	filename: string;
}

export function createArtifactsApi() {
	return {
		listSessionDemos: (sessionId: string, tabId?: string | null): Promise<DemoCard[]> =>
			ipcRenderer.invoke('artifacts:listSessionDemos', sessionId, tabId),
		getDemo: (demoId: string): Promise<DemoDetail | null> =>
			ipcRenderer.invoke('artifacts:getDemo', demoId),
		loadArtifact: (artifactId: string): Promise<string | null> =>
			ipcRenderer.invoke('artifacts:loadArtifact', artifactId),
		getArtifactFileInfo: (artifactId: string): Promise<ArtifactFileInfo | null> =>
			ipcRenderer.invoke('artifacts:getArtifactFileInfo', artifactId),
		harvestFromLogText: (request: DemoArtifactHarvestRequest): Promise<DemoCard | null> =>
			ipcRenderer.invoke('artifacts:harvestFromLogText', request),
	};
}

export type ArtifactsApi = ReturnType<typeof createArtifactsApi>;
