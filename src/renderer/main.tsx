// IMPORTANT: wdyr must be imported BEFORE React
import './wdyr';
import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import MaestroConsole from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LayerStackProvider } from './contexts/LayerStackContext';
// ToastProvider removed - notification state now managed by notificationStore (Zustand)
// ModalProvider removed - modal state now managed by modalStore (Zustand)
import { WizardProvider } from './components/Wizard';
import { logger } from './utils/logger';
import './index.css';

const HMR_FORCE_RELOAD_PREFIXES = [
	'/App.tsx',
	'/stores/',
	'/hooks/session/',
	'/hooks/remote/',
	'/components/ConductorPanel.tsx',
	'/components/conductor/',
];

interface ViteHotUpdatePayload {
	updates: Array<{
		path: string;
	}>;
}

interface ViteHotModule {
	on(event: 'vite:beforeUpdate', callback: (payload: ViteHotUpdatePayload) => void): void;
}

// Initialize Sentry for renderer process
// Uses IPCMode.Classic in main process to avoid "sentry-ipc://" protocol conflicts
// See: https://github.com/getsentry/sentry-electron/issues/661
const isDevelopment = process.env.NODE_ENV === 'development';

// Check crash reporting setting - default to enabled
// This mirrors the main process check for consistency
const initSentry = async () => {
	try {
		const crashReportingEnabled =
			(await window.maestro?.settings?.get('crashReportingEnabled')) ?? true;
		if (crashReportingEnabled && !isDevelopment) {
			Sentry.init({
				// Only send errors, not performance data
				tracesSampleRate: 0,
				// Filter out sensitive data
				beforeSend(event) {
					if (event.user) {
						delete event.user.ip_address;
						delete event.user.email;
					}
					return event;
				},
			});
		}
	} catch {
		// Settings not available yet, Sentry will be initialized by main process
	}
};
initSentry();

// Set up global error handlers for uncaught exceptions in renderer process
window.addEventListener('error', (event: ErrorEvent) => {
	logger.error(`Uncaught Error: ${event.message}`, 'UncaughtError', {
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
		error: event.error?.stack || String(event.error),
	});
	// Report to Sentry
	if (event.error) {
		Sentry.captureException(event.error, {
			extra: {
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
			},
		});
	}
	// Prevent default browser error handling
	event.preventDefault();
});

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
	logger.error(
		`Unhandled Promise Rejection: ${event.reason?.message || String(event.reason)}`,
		'UnhandledRejection',
		{
			reason: event.reason,
			stack: event.reason?.stack,
		}
	);
	// Report to Sentry
	Sentry.captureException(event.reason || new Error('Unhandled Promise Rejection'), {
		extra: {
			type: 'unhandledrejection',
		},
	});
	// Prevent default browser error handling
	event.preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<ErrorBoundary>
			<LayerStackProvider>
				<WizardProvider>
					<MaestroConsole />
				</WizardProvider>
			</LayerStackProvider>
		</ErrorBoundary>
	</React.StrictMode>
);

const viteHot = (import.meta as ImportMeta & { hot?: ViteHotModule }).hot;

if (viteHot) {
	viteHot.on('vite:beforeUpdate', (payload) => {
		const shouldForceReload = payload.updates.some((update) =>
			HMR_FORCE_RELOAD_PREFIXES.some((prefix) => update.path.startsWith(prefix))
		);
		if (!shouldForceReload) {
			return;
		}

		logger.info('Forcing full renderer reload for broad HMR update', 'HMR', {
			updates: payload.updates.map((update) => update.path),
		});
		window.location.reload();
	});
}
