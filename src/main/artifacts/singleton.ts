import { ArtifactsDB } from './ArtifactsDB';
import { DemoArtifactService, type DemoArtifactServiceOptions } from './DemoArtifactService';

let artifactsDbInstance: ArtifactsDB | null = null;
let demoArtifactServiceInstance: DemoArtifactService | null = null;
let demoArtifactServiceOptions: DemoArtifactServiceOptions = {};

export function configureArtifacts(options: DemoArtifactServiceOptions): void {
	if (demoArtifactServiceInstance) {
		throw new Error(
			'configureArtifacts must be called before demo artifact service initialization'
		);
	}
	demoArtifactServiceOptions = {
		...demoArtifactServiceOptions,
		...options,
	};
}

export function getArtifactsDB(): ArtifactsDB {
	if (!artifactsDbInstance) {
		artifactsDbInstance = new ArtifactsDB();
	}
	return artifactsDbInstance;
}

export function getDemoArtifactService(): DemoArtifactService {
	if (!demoArtifactServiceInstance) {
		demoArtifactServiceInstance = new DemoArtifactService(
			getArtifactsDB(),
			demoArtifactServiceOptions
		);
	}
	return demoArtifactServiceInstance;
}

export async function initializeArtifacts(): Promise<void> {
	await getDemoArtifactService().initialize();
}

export function closeArtifacts(): void {
	if (artifactsDbInstance) {
		artifactsDbInstance.close();
	}
	demoArtifactServiceInstance = null;
	artifactsDbInstance = null;
	demoArtifactServiceOptions = {};
}
