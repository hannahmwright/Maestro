/**
 * useKeyboardVisibility - Mobile keyboard visibility detection hook
 *
 * Detects when the mobile virtual keyboard appears/disappears using
 * the Visual Viewport API. Provides the keyboard offset for proper
 * positioning of fixed elements above the keyboard.
 *
 * Features:
 * - Uses modern Visual Viewport API for accurate detection
 * - Tracks keyboard offset for positioning calculations
 * - Boolean flag for simple keyboard visibility checks
 * - Handles viewport scroll events to maintain proper positioning
 * - Proper cleanup on unmount
 *
 * @example
 * ```tsx
 * const { keyboardOffset, isKeyboardVisible } = useKeyboardVisibility();
 *
 * return (
 *   <div style={{
 *     position: 'fixed',
 *     bottom: keyboardOffset,
 *     transition: isKeyboardVisible ? 'none' : 'bottom 0.15s ease-out',
 *   }}>
 *     Input bar content
 *   </div>
 * );
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react';

/** Minimum offset (in pixels) to consider keyboard visible */
const KEYBOARD_VISIBILITY_THRESHOLD = 50;

/** Return value from useKeyboardVisibility hook */
export interface UseKeyboardVisibilityReturn {
	/** Current keyboard offset in pixels (0 when keyboard is hidden) */
	keyboardOffset: number;
	/** Whether the keyboard is currently visible */
	isKeyboardVisible: boolean;
}

function hasFocusedEditableElement(): boolean {
	if (typeof document === 'undefined') {
		return false;
	}

	const activeElement = document.activeElement;
	if (!activeElement) {
		return false;
	}

	return (
		activeElement instanceof HTMLInputElement ||
		activeElement instanceof HTMLTextAreaElement ||
		(activeElement instanceof HTMLElement && activeElement.isContentEditable)
	);
}

/**
 * Hook for detecting mobile keyboard visibility
 *
 * Uses the Visual Viewport API to detect when the mobile virtual keyboard
 * appears. This is the modern, reliable way to handle keyboard appearance
 * on mobile devices.
 *
 * The Visual Viewport API reports the actual visible area of the viewport,
 * which shrinks when the keyboard appears. By comparing the visual viewport
 * height to the window inner height, we can detect the keyboard.
 *
 * @returns Keyboard visibility state and offset
 */
export function useKeyboardVisibility(): UseKeyboardVisibilityReturn {
	const [keyboardOffset, setKeyboardOffset] = useState(0);
	const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
	const baselineViewportBottomRef = useRef(0);
	const lastWindowSizeRef = useRef<{ width: number; height: number } | null>(null);
	const rafIdRef = useRef<number | null>(null);

	const updateKeyboardState = useCallback((offset: number) => {
		if (offset > KEYBOARD_VISIBILITY_THRESHOLD) {
			setKeyboardOffset(offset);
			setIsKeyboardVisible(true);
			return;
		}

		setKeyboardOffset(0);
		setIsKeyboardVisible(false);
	}, []);

	const scheduleCalculateOffset = useCallback(() => {
		if (typeof window === 'undefined') return;
		if (rafIdRef.current !== null) {
			window.cancelAnimationFrame(rafIdRef.current);
		}
		rafIdRef.current = window.requestAnimationFrame(() => {
			rafIdRef.current = null;
			calculateOffset();
		});
	}, []);

	/**
	 * Calculate keyboard offset from viewport dimensions
	 */
	const calculateOffset = useCallback(() => {
		if (typeof window === 'undefined') return;
		const viewport = window.visualViewport;
		if (!viewport) {
			updateKeyboardState(0);
			return;
		}

		const viewportBottom = viewport.height + viewport.offsetTop;
		if (!hasFocusedEditableElement()) {
			baselineViewportBottomRef.current = viewportBottom;
			updateKeyboardState(0);
			return;
		}

		const windowSize = {
			width: window.innerWidth,
			height: window.innerHeight,
		};
		const lastWindowSize = lastWindowSizeRef.current;
		const windowSizeChanged =
			!lastWindowSize ||
			lastWindowSize.width !== windowSize.width ||
			lastWindowSize.height !== windowSize.height;

		if (windowSizeChanged) {
			lastWindowSizeRef.current = windowSize;
			if (
				baselineViewportBottomRef.current === 0 &&
				windowSize.height - viewportBottom > KEYBOARD_VISIBILITY_THRESHOLD &&
				hasFocusedEditableElement()
			) {
				baselineViewportBottomRef.current = windowSize.height;
			} else {
				baselineViewportBottomRef.current = viewportBottom;
			}
		}

		const baselineViewportBottom = baselineViewportBottomRef.current || viewportBottom;

		// When the viewport returns to its baseline, refresh the baseline so stale
		// keyboard offsets do not leave fixed elements stranded mid-screen.
		if (viewportBottom >= baselineViewportBottom - KEYBOARD_VISIBILITY_THRESHOLD) {
			baselineViewportBottomRef.current = viewportBottom;
		}

		// Use the largest recent visible viewport bottom as the baseline instead of
		// relying on window.innerHeight alone. This is more stable in PWAs when the
		// browser chrome or viewport metrics temporarily drift.
		const offset = Math.max(0, baselineViewportBottomRef.current - viewportBottom);

		updateKeyboardState(offset);
	}, [updateKeyboardState]);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		const viewport = window.visualViewport;
		if (!viewport) {
			updateKeyboardState(0);
			return;
		}

		const handleResize = () => {
			scheduleCalculateOffset();
		};

		const handleScroll = () => {
			scheduleCalculateOffset();
		};

		const handleFocusChange = () => {
			window.setTimeout(() => {
				scheduleCalculateOffset();
			}, 0);
		};

		viewport.addEventListener('resize', handleResize);
		viewport.addEventListener('scroll', handleScroll);
		window.addEventListener('resize', handleResize);
		window.addEventListener('orientationchange', handleResize);
		window.addEventListener('focus', handleFocusChange, true);
		window.addEventListener('blur', handleFocusChange, true);

		// Initial check
		calculateOffset();

		return () => {
			viewport.removeEventListener('resize', handleResize);
			viewport.removeEventListener('scroll', handleScroll);
			window.removeEventListener('resize', handleResize);
			window.removeEventListener('orientationchange', handleResize);
			window.removeEventListener('focus', handleFocusChange, true);
			window.removeEventListener('blur', handleFocusChange, true);
			if (rafIdRef.current !== null) {
				window.cancelAnimationFrame(rafIdRef.current);
			}
		};
	}, [calculateOffset, scheduleCalculateOffset, updateKeyboardState]);

	return {
		keyboardOffset,
		isKeyboardVisible,
	};
}

export default useKeyboardVisibility;
