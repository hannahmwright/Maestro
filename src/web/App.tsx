/**
 * Maestro Web Interface App
 *
 * Remote control interface for mobile/tablet devices.
 * Provides session monitoring and command input from anywhere on your network.
 */

import {
	StrictMode,
	lazy,
	Suspense,
	useEffect,
	useState,
	useMemo,
	createContext,
	useContext,
	useCallback,
	useRef,
} from 'react';
import { ThemeProvider } from './components/ThemeProvider';
import { registerServiceWorker, isOffline, skipWaiting } from './utils/serviceWorker';
import { getMaestroConfig } from './utils/config';
import type { MaestroConfig } from './utils/config';
import { webLogger } from './utils/logger';
import type { Theme } from '../shared/theme-types';

const THEME_SNAPSHOT_STORAGE_KEY = 'maestro:web-theme-snapshot';
function readStoredThemeSnapshot(): Theme | null {
	if (typeof window === 'undefined') {
		return null;
	}

	try {
		const raw = window.sessionStorage.getItem(THEME_SNAPSHOT_STORAGE_KEY);
		if (!raw) {
			return null;
		}
		return JSON.parse(raw) as Theme;
	} catch {
		return null;
	}
}

function persistThemeSnapshot(theme: Theme | null): void {
	if (typeof window === 'undefined') {
		return;
	}

	try {
		if (!theme) {
			window.sessionStorage.removeItem(THEME_SNAPSHOT_STORAGE_KEY);
			return;
		}
		window.sessionStorage.setItem(THEME_SNAPSHOT_STORAGE_KEY, JSON.stringify(theme));
	} catch {
		// Ignore sessionStorage failures
	}
}

interface BuildToastProps {
	variant: 'update-ready' | 'update-applied';
	onAction?: () => void;
}

function BuildToast({ variant, onAction }: BuildToastProps) {
	const isApplied = variant === 'update-applied';
	return (
		<div
			style={{
				position: 'fixed',
				top: '12px',
				left: '12px',
				right: '12px',
				zIndex: 1000,
				display: 'flex',
				alignItems: 'center',
				gap: '12px',
				padding: '12px 14px',
				borderRadius: '20px',
				border: '1px solid rgba(255, 255, 255, 0.10)',
				background:
					'linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.08) 100%)',
				boxShadow: '0 18px 40px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255,255,255,0.10)',
				backdropFilter: 'blur(26px)',
				WebkitBackdropFilter: 'blur(26px)',
				color: 'var(--color-text-main)',
			}}
		>
			<div
				style={{
					width: '34px',
					height: '34px',
					borderRadius: '12px',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					flexShrink: 0,
					background:
						'linear-gradient(180deg, rgba(10, 132, 255, 0.20) 0%, rgba(10, 132, 255, 0.10) 100%)',
					border: '1px solid rgba(10, 132, 255, 0.18)',
				}}
			>
				<svg
					width="17"
					height="17"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{ color: 'var(--maestro-accent, var(--color-accent))' }}
				>
					<path d="M21 12a9 9 0 1 1-2.64-6.36" />
					<path d="M21 3v6h-6" />
				</svg>
			</div>

			<div
				style={{
					flex: 1,
					minWidth: 0,
					display: 'flex',
					flexDirection: 'column',
					gap: '2px',
				}}
			>
				<div
					style={{
						fontSize: '13px',
						fontWeight: 650,
						letterSpacing: '-0.01em',
					}}
				>
					{isApplied ? 'Update installed in background' : 'New web build available'}
				</div>
				<div
					style={{
						fontSize: '12px',
						color: 'var(--color-text-muted, var(--color-text-dim))',
					}}
				>
					{isApplied
						? 'Refresh whenever convenient to start using it.'
						: 'Install the latest remote UI without interrupting your session.'}
				</div>
			</div>

			{onAction && (
				<button
					onClick={onAction}
					style={{
						border: '1px solid rgba(255, 255, 255, 0.10)',
						borderRadius: '999px',
						padding: '9px 14px',
						background:
							'linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.08) 100%)',
						color: 'var(--color-text-main)',
						cursor: 'pointer',
						fontSize: '12px',
						fontWeight: 650,
						boxShadow: '0 10px 24px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255,255,255,0.08)',
						flexShrink: 0,
					}}
				>
					{isApplied ? 'Refresh' : 'Install'}
				</button>
			)}
		</div>
	);
}

/**
 * Context for offline status
 * Provides offline state to all components in the app
 */
interface OfflineContextValue {
	isOffline: boolean;
}

const OfflineContext = createContext<OfflineContextValue>({ isOffline: false });

/**
 * Hook to access offline status
 */
export function useOfflineStatus(): boolean {
	return useContext(OfflineContext).isOffline;
}

/**
 * Context for Maestro mode (dashboard vs session)
 */
interface MaestroModeContextValue {
	/** Whether we're viewing the dashboard (all live sessions) */
	isDashboard: boolean;
	/** Whether we're viewing a specific session */
	isSession: boolean;
	/** Current session ID (if in session mode) */
	sessionId: string | null;
	/** Current tab ID from URL (if specified) */
	tabId: string | null;
	/** Stable app base path */
	basePath: string;
	/** Navigate to dashboard */
	goToDashboard: () => void;
	/** Navigate to a specific session (optionally with a specific tab) */
	goToSession: (sessionId: string, tabId?: string | null) => void;
	/** Update URL to reflect current session and tab without navigation */
	updateUrl: (sessionId: string, tabId?: string | null) => void;
}

const MaestroModeContext = createContext<MaestroModeContextValue>({
	isDashboard: true,
	isSession: false,
	sessionId: null,
	tabId: null,
	basePath: '',
	goToDashboard: () => {},
	goToSession: () => {},
	updateUrl: () => {},
});

/**
 * Hook to access Maestro mode context
 */
export function useMaestroMode(): MaestroModeContextValue {
	return useContext(MaestroModeContext);
}

/**
 * Context for theme updates from WebSocket
 * Allows the mobile app to update the theme when received from desktop
 */
interface ThemeUpdateContextValue {
	/** Current theme from desktop app (null if using device preference) */
	desktopTheme: Theme | null;
	/** Update the theme when received from desktop app */
	setDesktopTheme: (theme: Theme) => void;
}

const ThemeUpdateContext = createContext<ThemeUpdateContextValue>({
	desktopTheme: null,
	setDesktopTheme: () => {},
});

/**
 * Hook to access and update the desktop theme
 * Used by mobile app to set theme when received via WebSocket
 */
export function useDesktopTheme(): ThemeUpdateContextValue {
	return useContext(ThemeUpdateContext);
}

/**
 * Build the Maestro mode context based on injected config.
 */
export function createMaestroModeContextValue(config: MaestroConfig): MaestroModeContextValue {
	const baseUrl = `${window.location.origin}${config.basePath}`;
	const isDashboard = config.sessionId === null;

	const buildSessionUrl = (sessionId: string, tabId?: string | null) => {
		let url = `${baseUrl}/session/${sessionId}`;
		if (tabId) {
			url += `?tabId=${encodeURIComponent(tabId)}`;
		}
		return url;
	};

	return {
		isDashboard,
		isSession: !isDashboard,
		sessionId: config.sessionId,
		tabId: config.tabId,
		basePath: config.basePath,
		goToDashboard: () => {
			window.location.href = baseUrl;
		},
		goToSession: (sessionId: string, tabId?: string | null) => {
			window.location.href = buildSessionUrl(sessionId, tabId);
		},
		updateUrl: (sessionId: string, tabId?: string | null) => {
			const newUrl = buildSessionUrl(sessionId, tabId);
			// Only update if URL actually changed
			if (window.location.href !== newUrl) {
				window.history.replaceState({ sessionId, tabId }, '', newUrl);
			}
		},
	};
}

// Lazy load the web app
// Both mobile and desktop use the same remote control interface
const WebApp = lazy(() =>
	import(/* webpackChunkName: "mobile" */ './mobile').catch(() => ({
		default: () => <PlaceholderApp />,
	}))
);

/**
 * Placeholder component shown while the actual app loads
 * or if there's an error loading the app module
 */
function PlaceholderApp() {
	return <BootBackdrop />;
}

/**
 * Loading fallback component
 */
function LoadingFallback() {
	return <BootBackdrop />;
}

function BootBackdrop() {
	const [showSlowLoadingShell, setShowSlowLoadingShell] = useState(false);

	useEffect(() => {
		const timeoutId = window.setTimeout(() => {
			setShowSlowLoadingShell(true);
		}, 6000);

		return () => window.clearTimeout(timeoutId);
	}, []);

	if (showSlowLoadingShell) {
		return (
			<div
				style={{
					minHeight: '100vh',
					display: 'flex',
					flexDirection: 'column',
					background:
						'linear-gradient(180deg, var(--maestro-bg-sidebar, var(--color-surface)) 0%, var(--maestro-bg-main, var(--color-background)) 100%)',
					color: 'var(--maestro-text-main, var(--color-text-main))',
				}}
			>
				<div
					style={{
						padding: '18px 16px 14px',
						paddingTop: 'max(16px, env(safe-area-inset-top))',
						borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
					}}
				>
					<div>
						<div
							style={{
								fontSize: '10px',
								fontWeight: 600,
								letterSpacing: '0.08em',
								textTransform: 'uppercase',
								color: 'var(--maestro-text-dim, var(--color-text-muted))',
								opacity: 0.76,
							}}
						>
							Maestro Remote
						</div>
						<div
							style={{
								fontSize: '19px',
								fontWeight: 650,
								letterSpacing: '-0.02em',
								marginTop: '6px',
							}}
						>
							Refreshing Maestro
						</div>
					</div>
					<div
						style={{
							width: '32px',
							height: '32px',
							borderRadius: '12px',
							background: 'rgba(255, 255, 255, 0.08)',
						}}
					/>
				</div>

				<div
					style={{
						flex: 1,
						display: 'flex',
						flexDirection: 'column',
						padding: '18px 16px calc(96px + env(safe-area-inset-bottom))',
						gap: '14px',
					}}
				>
					<div
						style={{
							fontSize: '13px',
							color: 'var(--maestro-text-dim, var(--color-text-muted))',
							opacity: 0.9,
						}}
					>
						Still syncing with your desktop app.
					</div>

					<div
						style={{
							borderRadius: '22px',
							border: '1px solid rgba(255, 255, 255, 0.08)',
							background:
								'linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.04) 100%)',
							boxShadow:
								'0 14px 30px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
							padding: '16px',
							display: 'flex',
							flexDirection: 'column',
							gap: '12px',
						}}
					>
						{[0, 1, 2, 3].map((index) => (
							<div
								key={index}
								style={{
									height: index === 0 ? '18px' : index === 3 ? '72px' : '14px',
									width: index === 3 ? '100%' : index === 1 ? '58%' : index === 2 ? '72%' : '34%',
									borderRadius: '999px',
									background: 'rgba(255, 255, 255, 0.08)',
								}}
							/>
						))}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			style={{
				minHeight: '100vh',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background:
					'linear-gradient(180deg, var(--maestro-bg-sidebar, var(--color-surface)) 0%, var(--maestro-bg-main, var(--color-background)) 100%)',
				color: 'var(--maestro-text-main, var(--color-text-main))',
			}}
		>
			<div
				style={{
					width: '72px',
					height: '72px',
					borderRadius: '26px',
					border: '1px solid rgba(255, 255, 255, 0.10)',
					background:
						'linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.07) 100%)',
					boxShadow: '0 18px 36px rgba(15, 23, 42, 0.14), inset 0 1px 0 rgba(255,255,255,0.10)',
					backdropFilter: 'blur(22px)',
					WebkitBackdropFilter: 'blur(22px)',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
				}}
			>
				<div
					style={{
						width: '28px',
						height: '28px',
						borderRadius: '999px',
						border: '2.5px solid rgba(255, 255, 255, 0.18)',
						borderTopColor: 'var(--maestro-accent, var(--color-accent))',
						animation: 'spin 0.85s linear infinite',
					}}
				/>
			</div>
		</div>
	);
}

/**
 * Main App component - renders the remote control interface
 */
export function App() {
	const [offline, setOffline] = useState(isOffline());
	const [desktopTheme, setDesktopTheme] = useState<Theme | null>(() => readStoredThemeSnapshot());
	const [hasServiceWorkerUpdate, setHasServiceWorkerUpdate] = useState(false);
	const [hasInstalledServiceWorkerUpdate, setHasInstalledServiceWorkerUpdate] = useState(false);
	const config = useMemo(() => getMaestroConfig(), []);
	const shouldReloadAfterServiceWorkerRef = useRef(false);

	const modeContextValue = useMemo(
		() => createMaestroModeContextValue(config),
		[config.basePath, config.sessionId, config.tabId]
	);

	const handleDesktopTheme = useCallback((theme: Theme) => {
		webLogger.debug(`Desktop theme received: ${theme.name} (${theme.mode})`, 'App');
		persistThemeSnapshot(theme);
		setDesktopTheme(theme);
	}, []);

	const themeUpdateContextValue = useMemo(
		() => ({
			desktopTheme,
			setDesktopTheme: handleDesktopTheme,
		}),
		[desktopTheme, handleDesktopTheme]
	);

	// Register service worker for offline capability
	useEffect(() => {
		registerServiceWorker({
			onSuccess: (registration) => {
				webLogger.debug(`Service worker ready: ${registration.scope}`, 'App');
			},
			onUpdate: () => {
				webLogger.info('New content available, refresh recommended', 'App');
				setHasServiceWorkerUpdate(true);
			},
			onOfflineChange: (newOfflineStatus) => {
				webLogger.debug(`Offline status changed: ${newOfflineStatus}`, 'App');
				setOffline(newOfflineStatus);
			},
		});
	}, []);

	useEffect(() => {
		if (!('serviceWorker' in navigator)) {
			return;
		}

		const handleControllerChange = () => {
			if (shouldReloadAfterServiceWorkerRef.current && document.visibilityState !== 'visible') {
				window.location.reload();
				return;
			}

			setHasServiceWorkerUpdate(false);
			setHasInstalledServiceWorkerUpdate(true);
		};

		navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
		return () =>
			navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
	}, []);

	// Log mode info on mount
	useEffect(() => {
		webLogger.debug(
			`Mode: ${modeContextValue.isDashboard ? 'dashboard' : `session:${modeContextValue.sessionId}`}`,
			'App'
		);
	}, [modeContextValue.isDashboard, modeContextValue.sessionId]);

	return (
		<MaestroModeContext.Provider value={modeContextValue}>
			<OfflineContext.Provider value={{ isOffline: offline }}>
				<ThemeUpdateContext.Provider value={themeUpdateContextValue}>
					{/*
            Enable useDevicePreference to respect the device's dark/light mode preference.
            When no theme is provided from the desktop app via WebSocket, the web interface
            will automatically use a dark or light theme based on the user's device settings.
            Once the desktop app sends a theme (via desktopTheme), it will override the device preference.
          */}
					<ThemeProvider theme={desktopTheme || undefined} useDevicePreference>
						{hasServiceWorkerUpdate && (
							<BuildToast
								variant="update-ready"
								onAction={() => {
									shouldReloadAfterServiceWorkerRef.current = false;
									skipWaiting();
									setHasServiceWorkerUpdate(false);
								}}
							/>
						)}
						{!hasServiceWorkerUpdate && hasInstalledServiceWorkerUpdate && (
							<BuildToast
								variant="update-applied"
								onAction={() => {
									shouldReloadAfterServiceWorkerRef.current = true;
									window.location.reload();
								}}
							/>
						)}
						<Suspense fallback={<LoadingFallback />}>
							<WebApp />
						</Suspense>
					</ThemeProvider>
				</ThemeUpdateContext.Provider>
			</OfflineContext.Provider>
		</MaestroModeContext.Provider>
	);
}

export function AppRoot() {
	const isLocalDevelopment =
		typeof window !== 'undefined' &&
		(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

	if (isLocalDevelopment) {
		return <App />;
	}

	return (
		<StrictMode>
			<App />
		</StrictMode>
	);
}
