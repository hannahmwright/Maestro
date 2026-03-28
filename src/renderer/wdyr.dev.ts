/**
 * why-did-you-render setup for development performance profiling
 *
 * This file is only loaded in development mode via Vite's alias configuration.
 * In production, the empty wdyr.ts is used instead.
 *
 * To track a specific component, add this to the component file:
 *   MyComponent.whyDidYouRender = true;
 *
 * Or track all pure components by setting trackAllPureComponents: true below.
 *
 * Output appears in the browser DevTools console showing:
 * - Which components re-rendered
 * - What props/state changes triggered the re-render
 * - Whether the re-render was necessary
 */
import React from 'react';
import whyDidYouRender from '@welldone-software/why-did-you-render';

const wdyrEnabled = process.env.MAESTRO_ENABLE_WDYR === 'true';

// Must run synchronously before any component renders so that React hooks
// are patched consistently from the very first render. Async loading (dynamic
// import) causes hooks to be patched mid-session, changing the hook count
// between renders and crashing libraries that use internal React hooks
// (e.g. Zustand v5's useCallback inside useStore).
if (wdyrEnabled) {
	whyDidYouRender(React, {
		// Keep dev profiling opt-in and narrow. Tracking every pure component and hook
		// is too expensive for normal Maestro development, especially on Conductor boards.
		trackAllPureComponents: false,
		trackHooks: false,
		logOnDifferentValues: true,
		collapseGroups: true,
		include: [
			// Add specific components to always track, e.g.:
			// /^RightPanel/,
			// /^AutoRun/,
			// /^FilePreview/,
		],
		exclude: [/^BrowserRouter/, /^Link/, /^Route/],
	});
}
