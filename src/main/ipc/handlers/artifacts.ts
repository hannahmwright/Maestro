import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { pathToFileURL } from 'url';
import { getDemoArtifactService } from '../../artifacts';
import type { DemoArtifactHarvestRequest } from '../../../shared/demo-artifacts';

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
			url: pathToFileURL(artifact.storedPath).toString(),
			mimeType: artifact.mimeType,
			filename: artifact.filename,
		};
	});

	ipcMain.handle(
		'artifacts:exportArtifact',
		async (_event, artifactId: string, destinationPath: string) => {
			const artifact = getDemoArtifactService().getArtifactRecord(artifactId);
			if (!artifact) {
				return {
					success: false,
					error: `Artifact '${artifactId}' not found`,
				};
			}

			try {
				await fs.copyFile(artifact.storedPath, destinationPath);
				return { success: true };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
	);

	ipcMain.handle(
		'artifacts:harvestFromLogText',
		async (_event, request: DemoArtifactHarvestRequest) => {
			// Debug-only compatibility import for recovered legacy artifacts.
			return getDemoArtifactService().harvestFromLogText(request);
		}
	);
}
