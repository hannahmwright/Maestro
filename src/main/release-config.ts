import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface ReleaseSource {
	label: string;
	owner: string;
	repo: string;
}

interface MaestroReleaseMetadata {
	current?: Partial<ReleaseSource>;
	upstream?: Partial<ReleaseSource>;
}

const DEFAULT_CURRENT_SOURCE: ReleaseSource = {
	label: 'RunMaestro Releases',
	owner: 'RunMaestro',
	repo: 'Maestro',
};

const DEFAULT_UPSTREAM_SOURCE: ReleaseSource = {
	label: 'RunMaestro Releases',
	owner: 'RunMaestro',
	repo: 'Maestro',
};

let cachedReleaseMetadata: MaestroReleaseMetadata | null = null;

function normalizeSource(
	source: Partial<ReleaseSource> | undefined,
	fallback: ReleaseSource
): ReleaseSource {
	return {
		label: source?.label?.trim() || fallback.label,
		owner: source?.owner?.trim() || fallback.owner,
		repo: source?.repo?.trim() || fallback.repo,
	};
}

function loadReleaseMetadata(): MaestroReleaseMetadata {
	if (cachedReleaseMetadata) {
		return cachedReleaseMetadata;
	}

	try {
		const packageJsonPath = path.join(app.getAppPath(), 'package.json');
		const rawPackageJson = fs.readFileSync(packageJsonPath, 'utf8');
		const parsedPackageJson = JSON.parse(rawPackageJson) as {
			maestroRelease?: MaestroReleaseMetadata;
		};
		cachedReleaseMetadata = parsedPackageJson.maestroRelease || {};
	} catch {
		cachedReleaseMetadata = {};
	}

	return cachedReleaseMetadata;
}

export function getCurrentReleaseSource(): ReleaseSource {
	return normalizeSource(loadReleaseMetadata().current, DEFAULT_CURRENT_SOURCE);
}

export function getUpstreamReleaseSource(): ReleaseSource {
	return normalizeSource(loadReleaseMetadata().upstream, DEFAULT_UPSTREAM_SOURCE);
}
