import { useCallback, useEffect, useState } from 'react';
import { webLogger } from '../utils/logger';

interface BeforeInstallPromptEvent extends Event {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface UseInstallPromptReturn {
	canInstall: boolean;
	isInstalled: boolean;
	install: () => Promise<boolean>;
}

function getIsInstalled(): boolean {
	if (typeof window === 'undefined') {
		return false;
	}

	return (
		window.matchMedia('(display-mode: standalone)').matches ||
		(window.navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

export function useInstallPrompt(): UseInstallPromptReturn {
	const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
	const [isInstalled, setIsInstalled] = useState(() => getIsInstalled());

	useEffect(() => {
		const handleBeforeInstallPrompt = (event: Event) => {
			event.preventDefault();
			setDeferredPrompt(event as BeforeInstallPromptEvent);
			webLogger.debug('beforeinstallprompt received', 'InstallPrompt');
		};

		const handleInstalled = () => {
			setDeferredPrompt(null);
			setIsInstalled(true);
			webLogger.info('PWA installed', 'InstallPrompt');
		};

		const mediaQuery = window.matchMedia('(display-mode: standalone)');
		const handleDisplayModeChange = () => {
			setIsInstalled(getIsInstalled());
		};

		window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
		window.addEventListener('appinstalled', handleInstalled);
		mediaQuery.addEventListener?.('change', handleDisplayModeChange);

		return () => {
			window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
			window.removeEventListener('appinstalled', handleInstalled);
			mediaQuery.removeEventListener?.('change', handleDisplayModeChange);
		};
	}, []);

	const install = useCallback(async (): Promise<boolean> => {
		if (!deferredPrompt) {
			return false;
		}

		await deferredPrompt.prompt();
		const choice = await deferredPrompt.userChoice;
		setDeferredPrompt(null);
		const accepted = choice.outcome === 'accepted';
		if (accepted) {
			setIsInstalled(true);
		}
		return accepted;
	}, [deferredPrompt]);

	return {
		canInstall: !isInstalled && deferredPrompt !== null,
		isInstalled,
		install,
	};
}

export default useInstallPrompt;
