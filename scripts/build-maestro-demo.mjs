#!/usr/bin/env node

import { build } from 'esbuild';

const bundles = [
	{
		entryPoints: ['src/main/artifacts/maestro-demo.ts'],
		outfile: 'dist/main/artifacts/maestro-demo.js',
		label: 'maestro-demo runtime',
	},
	{
		entryPoints: ['src/main/artifacts/maestro-pwcli.ts'],
		outfile: 'dist/main/artifacts/maestro-pwcli.js',
		label: 'maestro-pwcli runtime',
		external: ['playwright'],
	},
];

for (const bundleConfig of bundles) {
	console.log(`Bundling ${bundleConfig.label}...`);
	await build({
		entryPoints: bundleConfig.entryPoints,
		outfile: bundleConfig.outfile,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		legalComments: 'none',
		logLevel: 'info',
		external: bundleConfig.external || [],
	});
	console.log(`✓ Bundled ${bundleConfig.outfile}`);
}
