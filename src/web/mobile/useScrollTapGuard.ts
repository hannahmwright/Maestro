import { useCallback, useRef, type TouchEvent } from 'react';

const TAP_GUARD_MOVE_THRESHOLD_PX = 8;
const TAP_GUARD_WINDOW_MS = 180;

export function useScrollTapGuard() {
	const touchStartYRef = useRef<number | null>(null);
	const suppressUntilRef = useRef(0);

	const suppressTap = useCallback(() => {
		suppressUntilRef.current = Date.now() + TAP_GUARD_WINDOW_MS;
	}, []);

	const handleTouchStartCapture = useCallback((event: TouchEvent<HTMLElement>) => {
		touchStartYRef.current = event.touches[0]?.clientY ?? null;
	}, []);

	const handleTouchMoveCapture = useCallback(
		(event: TouchEvent<HTMLElement>) => {
			const touchStartY = touchStartYRef.current;
			const currentY = event.touches[0]?.clientY;
			if (touchStartY === null || typeof currentY !== 'number') {
				return;
			}

			if (Math.abs(currentY - touchStartY) >= TAP_GUARD_MOVE_THRESHOLD_PX) {
				suppressTap();
			}
		},
		[suppressTap]
	);

	const handleTouchEndCapture = useCallback(() => {
		touchStartYRef.current = null;
	}, []);

	const handleScrollCapture = useCallback(() => {
		suppressTap();
	}, [suppressTap]);

	const shouldIgnoreClick = useCallback(() => {
		if (Date.now() >= suppressUntilRef.current) {
			return false;
		}

		suppressUntilRef.current = 0;
		return true;
	}, []);

	return {
		scrollGuardProps: {
			onTouchStartCapture: handleTouchStartCapture,
			onTouchMoveCapture: handleTouchMoveCapture,
			onTouchEndCapture: handleTouchEndCapture,
			onScrollCapture: handleScrollCapture,
		},
		shouldIgnoreClick,
	};
}
