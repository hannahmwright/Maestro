import { ipcMain } from 'electron';
import { getDemoArtifactService } from '../../artifacts';

export function registerArtifactsHandlers(): void {
	ipcMain.handle(
		'artifacts:listSessionDemos',
		async (_event, sessionId: string, tabId?: string | null) => {
			return getDemoArtifactService().listSessionDemos(sessionId, tabId);
		}
	);

	ipcMain.handle('artifacts:getDemo', async (_event, demoId: string) => {
		return getDemoArtifactService().getDemo(demoId);
	});

	ipcMain.handle('artifacts:loadArtifact', async (_event, artifactId: string) => {
		return getDemoArtifactService().loadArtifactAsDataUrl(artifactId);
	});

	ipcMain.handle('artifacts:getArtifactFileInfo', async (_event, artifactId: string) => {
		const artifact = getDemoArtifactService().getArtifactRecord(artifactId);
		if (!artifact) {
			return null;
		}

		return {
			id: artifact.id,
			path: artifact.storedPath,
			mimeType: artifact.mimeType,
			filename: artifact.filename,
		};
	});
}
