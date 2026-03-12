/**
 * Maestro Web Interface Entry Point
 */

import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { AppRoot } from './App';
import { webLogger } from './utils/logger';
import './index.css';

export { useOfflineStatus, useMaestroMode, useDesktopTheme } from './App';

declare global {
	interface Window {
		__MAESTRO_WEB_ROOT__?: Root;
	}
}

interface MaestroRootContainer extends HTMLElement {
	__maestroWebRoot__?: Root;
}

// Mount the application
const container = document.getElementById('root') as MaestroRootContainer | null;
if (container) {
	const root = container.__maestroWebRoot__ ?? window.__MAESTRO_WEB_ROOT__ ?? createRoot(container);
	container.__maestroWebRoot__ = root;
	window.__MAESTRO_WEB_ROOT__ = root;
	root.render(<AppRoot />);
} else {
	webLogger.error('Root element not found', 'App');
}
