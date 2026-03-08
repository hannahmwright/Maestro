/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports */

const packageJson = require('../package.json');

module.exports = {
	...packageJson.build,
	appId: 'com.vervetechgroup.maestro.fork',
	productName: 'Maestro',
	publish: {
		provider: 'github',
		owner: 'hannahmwright',
		repo: 'Maestro',
	},
	extraMetadata: {
		repository: {
			type: 'git',
			url: 'https://github.com/hannahmwright/Maestro.git',
		},
		maestroRelease: {
			current: {
				label: 'Hannah Fork Releases',
				owner: 'hannahmwright',
				repo: 'Maestro',
			},
			upstream: {
				label: 'RunMaestro Releases',
				owner: 'RunMaestro',
				repo: 'Maestro',
			},
			fork: packageJson.maestroRelease?.fork,
		},
	},
};
