#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const releaseDir = path.join(rootDir, 'release');
const forkRelease = packageJson.maestroRelease?.fork;

if (!forkRelease?.owner || !forkRelease?.repo) {
	throw new Error('package.json maestroRelease.fork is missing owner/repo');
}

const repo = `${forkRelease.owner}/${forkRelease.repo}`;
const version = packageJson.version;
const tag = process.argv[2] || `v${version}`;
const title = `${forkRelease.productName || 'Maestro Fork'} ${tag}`;

const releaseFiles = fs
	.readdirSync(releaseDir)
	.filter(
		(file) =>
			file === 'latest-mac.yml' ||
			(file.startsWith(`maestro-${version}-`) &&
				(file.endsWith('.dmg') ||
					file.endsWith('.zip') ||
					file.endsWith('.blockmap') ||
					file.endsWith('.yml')))
	)
	.map((file) => path.join(releaseDir, file));

if (releaseFiles.length === 0) {
	throw new Error(`No release artifacts found in ${releaseDir} for version ${version}`);
}

const releaseView = spawnSync('gh', ['release', 'view', tag, '--repo', repo], {
	cwd: rootDir,
	stdio: 'ignore',
});

if (releaseView.status === 0) {
	execFileSync('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...releaseFiles], {
		cwd: rootDir,
		stdio: 'inherit',
	});
} else {
	execFileSync(
		'gh',
		[
			'release',
			'create',
			tag,
			'--repo',
			repo,
			'--title',
			title,
			'--notes',
			`${title}\n\nFork release artifacts for the Maestro fork update channel.`,
			...releaseFiles,
		],
		{
			cwd: rootDir,
			stdio: 'inherit',
		}
	);
}
