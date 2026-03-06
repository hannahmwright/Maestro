const MIN_MAJOR = 22;
const MIN_MINOR = 12;

function parseNodeVersion(version) {
	const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10));
	return { major, minor, patch };
}

function isSupported(version) {
	if (version.major > MIN_MAJOR) {
		return true;
	}

	if (version.major < MIN_MAJOR) {
		return false;
	}

	return version.minor >= MIN_MINOR;
}

const current = parseNodeVersion(process.versions.node);

if (!isSupported(current)) {
	console.error(
		[
			`Maestro requires Node.js ${MIN_MAJOR}.${MIN_MINOR}+ for dependency installation.`,
			`Current Node.js version: ${process.versions.node}`,
			'Install a newer Node.js release and rerun npm install.',
		].join('\n')
	);
	process.exit(1);
}
