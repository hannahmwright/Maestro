/**
 * Update checker for Maestro
 * Fetches release information from GitHub API to check for updates
 */

import { compareVersions } from '../shared/pathUtils';
import { logger } from './utils/logger';
import {
	getCurrentReleaseSource,
	getUpstreamReleaseSource,
	type ReleaseSource,
} from './release-config';

export interface ReleaseAsset {
	name: string;
	browser_download_url: string;
	size: number;
	content_type: string;
}

export interface Release {
	tag_name: string;
	name: string;
	body: string;
	html_url: string;
	published_at: string;
	prerelease: boolean;
	draft: boolean;
	assets: ReleaseAsset[];
}

export interface UpdateCheckResult {
	currentVersion: string;
	latestVersion: string;
	updateAvailable: boolean;
	versionsBehind: number;
	releases: Release[];
	releasesUrl: string;
	assetsReady: boolean;
	source: ReleaseSource;
	error?: string;
}

function getReleaseApiUrl(source: ReleaseSource): string {
	return `https://api.github.com/repos/${source.owner}/${source.repo}/releases`;
}

function getReleaseHtmlUrl(source: ReleaseSource): string {
	return `https://github.com/${source.owner}/${source.repo}/releases`;
}

/**
 * Check if a release has assets available for the current platform
 */
function hasAssetsForPlatform(release: Release): boolean {
	if (!release.assets || release.assets.length === 0) {
		return false;
	}

	const platform = process.platform;
	const assetNames = release.assets.map((a) => a.name.toLowerCase());

	switch (platform) {
		case 'darwin':
			// macOS: look for .dmg or .zip (arm64 or x64)
			return assetNames.some(
				(name) =>
					name.endsWith('.dmg') ||
					(name.endsWith('.zip') && (name.includes('mac') || name.includes('darwin')))
			);
		case 'win32':
			// Windows: look for .exe or .msi
			return assetNames.some((name) => name.endsWith('.exe') || name.endsWith('.msi'));
		case 'linux':
			// Linux: look for .AppImage, .deb, .rpm, or .tar.gz
			return assetNames.some(
				(name) =>
					name.endsWith('.appimage') ||
					name.endsWith('.deb') ||
					name.endsWith('.rpm') ||
					(name.endsWith('.tar.gz') && name.includes('linux'))
			);
		default:
			// Unknown platform, assume assets are ready if any exist
			return release.assets.length > 0;
	}
}

/**
 * Fetch all releases from GitHub API
 * @param includePrerelease - If true, include beta/rc/alpha releases. Default: false (stable only)
 */
async function fetchReleases(
	source: ReleaseSource,
	includePrerelease: boolean = false
): Promise<Release[]> {
	const releasesUrl = getReleaseApiUrl(source);
	logger.info(
		`Fetching releases from GitHub (source: ${source.owner}/${source.repo}, includePrerelease: ${includePrerelease})`,
		'UpdateChecker'
	);

	const response = await fetch(releasesUrl, {
		headers: {
			Accept: 'application/vnd.github.v3+json',
			'User-Agent': 'Maestro-Update-Checker',
		},
	});

	if (!response.ok) {
		const errorMsg = `GitHub API error: ${response.status} ${response.statusText}`;
		logger.error(errorMsg, 'UpdateChecker', {
			url: releasesUrl,
			status: response.status,
			statusText: response.statusText,
		});
		throw new Error(errorMsg);
	}

	const releases = (await response.json()) as Release[];
	logger.info(`Fetched ${releases.length} total releases from GitHub`, 'UpdateChecker');

	// Filter out drafts (always excluded)
	// Filter out prereleases and prerelease suffixes (-rc, -beta, -alpha) unless includePrerelease is true
	const prereleasePattern = /-(rc|beta|alpha|dev|canary)/i;
	const filtered = releases
		.filter((r) => {
			// Always filter out drafts
			if (r.draft) return false;

			// If including prereleases, allow all non-draft releases
			if (includePrerelease) return true;

			// Otherwise, filter out prereleases and releases with prerelease suffixes
			return !r.prerelease && !prereleasePattern.test(r.tag_name);
		})
		.sort((a, b) => compareVersions(b.tag_name, a.tag_name));

	const filteredOut = releases.length - filtered.length;
	logger.info(
		`After filtering: ${filtered.length} eligible releases (${filteredOut} excluded as drafts/prereleases)`,
		'UpdateChecker',
		{ versions: filtered.map((r) => r.tag_name) }
	);

	return filtered;
}

/**
 * Count how many versions behind the current version is
 */
function countVersionsBehind(currentVersion: string, releases: Release[]): number {
	let count = 0;
	for (const release of releases) {
		if (compareVersions(release.tag_name, currentVersion) > 0) {
			count++;
		} else {
			break;
		}
	}
	return count;
}

/**
 * Get releases that are newer than the current version
 */
function getNewerReleases(currentVersion: string, releases: Release[]): Release[] {
	return releases.filter((r) => compareVersions(r.tag_name, currentVersion) > 0);
}

/**
 * Check for updates
 * @param currentVersion - The current app version
 * @param includePrerelease - If true, include beta/rc/alpha releases. Default: false (stable only)
 */
export async function checkForUpdates(
	currentVersion: string,
	includePrerelease: boolean = false,
	source: ReleaseSource = getCurrentReleaseSource()
): Promise<UpdateCheckResult> {
	const releasesUrl = getReleaseHtmlUrl(source);

	logger.info(
		`Checking for updates (source: ${source.owner}/${source.repo}, current: ${currentVersion}, includePrerelease: ${includePrerelease}, platform: ${process.platform})`,
		'UpdateChecker'
	);

	try {
		const allReleases = await fetchReleases(source, includePrerelease);

		if (allReleases.length === 0) {
			logger.info('No eligible releases found on GitHub', 'UpdateChecker');
			return {
				currentVersion,
				latestVersion: currentVersion,
				updateAvailable: false,
				versionsBehind: 0,
				releases: [],
				releasesUrl,
				assetsReady: false,
				source,
			};
		}

		const latestVersion = allReleases[0].tag_name.replace(/^v/, '');
		const newerReleases = getNewerReleases(currentVersion, allReleases);
		const versionsBehind = countVersionsBehind(currentVersion, allReleases);
		const updateAvailable = versionsBehind > 0;

		// Check if the latest release has assets ready for this platform
		const assetsReady = allReleases.length > 0 && hasAssetsForPlatform(allReleases[0]);

		if (updateAvailable) {
			logger.info(
				`Update available: ${currentVersion} → ${latestVersion} (${versionsBehind} version(s) behind, assets ready: ${assetsReady})`,
				'UpdateChecker',
				{ newerVersions: newerReleases.map((r) => r.tag_name) }
			);
		} else {
			logger.info(
				`Already up to date (current: ${currentVersion}, latest: ${latestVersion})`,
				'UpdateChecker'
			);
		}

		return {
			currentVersion,
			latestVersion,
			updateAvailable,
			versionsBehind,
			releases: newerReleases,
			releasesUrl,
			assetsReady,
			source,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logger.error(`Update check failed: ${errorMessage}`, 'UpdateChecker', {
			currentVersion,
			includePrerelease,
			stack: error instanceof Error ? error.stack : undefined,
		});
		return {
			currentVersion,
			latestVersion: currentVersion,
			updateAvailable: false,
			versionsBehind: 0,
			releases: [],
			releasesUrl,
			assetsReady: false,
			source,
			error: errorMessage,
		};
	}
}

export async function checkUpstreamUpdates(
	currentVersion: string,
	includePrerelease: boolean = false
): Promise<UpdateCheckResult> {
	return checkForUpdates(currentVersion, includePrerelease, getUpstreamReleaseSource());
}
