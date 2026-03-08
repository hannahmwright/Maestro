export { ArtifactsDB } from './ArtifactsDB';
export { DemoArtifactService } from './DemoArtifactService';
export {
	configureArtifacts,
	getArtifactsDB,
	getDemoArtifactService,
	initializeArtifacts,
	closeArtifacts,
} from './singleton';
export type {
	ArtifactRecord,
	CaptureRunRecord,
	DemoRecord,
	DemoStepRecord,
	DemoCaptureContext,
	DemoCaptureEventInput,
} from './types';
