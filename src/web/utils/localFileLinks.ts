import { getSessionLocalFileViewerUrl } from './config';
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const PROJECT_RELATIVE_FILE_PATTERN =
	/^(?:\.{1,2}\/)?(?:output\/playwright\/|screenshots\/|artifacts\/).+\.[a-z0-9]+$/i;

function hasSupportedFileExtension(candidate: string): boolean {
	return /\.[a-z0-9]+$/i.test(candidate);
}

function normalizeAbsoluteFilePath(candidate: string): string | null {
	if (candidate.startsWith('/Users/') || candidate.startsWith('/home/')) {
		return candidate;
	}

	if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(candidate)) {
		return candidate.replace(/\//g, '\\');
	}

	return null;
}

function extractPathFromAppUrl(rawHref: string): string | null {
	let pathname = rawHref;

	try {
		const normalizedHref =
			rawHref.startsWith('/http://') || rawHref.startsWith('/https://')
				? rawHref.slice(1)
				: rawHref;
		const parsed = new URL(normalizedHref);
		pathname = parsed.pathname;
	} catch {
		// Fall back to treating the raw href as a path.
	}

	if (!pathname.startsWith('/app/')) {
		return null;
	}

	const decodedPath = decodeURIComponent(pathname.slice('/app/'.length));
	const absoluteCandidate = normalizeAbsoluteFilePath(`/${decodedPath.replace(/^\/+/, '')}`);
	if (absoluteCandidate) {
		return absoluteCandidate;
	}

	return null;
}

export function extractStreamableLocalFilePath(href: string | undefined): string | null {
	if (!href) {
		return null;
	}

	const trimmedHref = href.trim();
	if (!trimmedHref || trimmedHref.startsWith('#') || trimmedHref.startsWith('mailto:')) {
		return null;
	}

	if (trimmedHref.startsWith('file://')) {
		const decodedFilePath = decodeURIComponent(trimmedHref.replace(/^file:\/\//, ''));
		return normalizeAbsoluteFilePath(decodedFilePath);
	}

	const extractedFromAppUrl = extractPathFromAppUrl(trimmedHref);
	if (extractedFromAppUrl) {
		return extractedFromAppUrl;
	}

	const decodedHref = decodeURIComponent(trimmedHref);
	const absoluteCandidate = normalizeAbsoluteFilePath(decodedHref);
	if (absoluteCandidate) {
		return absoluteCandidate;
	}

	if (
		PROJECT_RELATIVE_FILE_PATTERN.test(decodedHref) &&
		hasSupportedFileExtension(decodedHref) &&
		!decodedHref.includes('://')
	) {
		return decodedHref.replace(/^\.\//, '');
	}

	return null;
}

const LOCAL_FILE_TEXT_PATTERN =
	/(?:\/https?:\/\/[^\s)]+\/app\/(?:Users|home)\/[^\s)]+|https?:\/\/[^\s)]+\/app\/(?:Users|home)\/[^\s)]+|file:\/\/[^\s)]+|\/(?:Users|home)\/[^\n]+?\/(?:output\/playwright|screenshots|artifacts)\/[^\s)]+|(?:\.{1,2}\/)?output\/playwright\/[^\s)]+)/g;

export function findStreamableLocalFilePathsInText(text: string): string[] {
	if (!text.trim()) {
		return [];
	}

	const matches = text.match(LOCAL_FILE_TEXT_PATTERN) || [];
	const uniquePaths = new Set<string>();
	for (const match of matches) {
		const filePath = extractStreamableLocalFilePath(match);
		if (filePath) {
			uniquePaths.add(filePath);
		}
	}

	return Array.from(uniquePaths);
}

export function buildSessionLocalFileViewerUrl(sessionId: string, filePath: string): string {
	return getSessionLocalFileViewerUrl(sessionId, filePath);
}
