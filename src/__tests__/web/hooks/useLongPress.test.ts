/**
 * Tests for useLongPress hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLongPress } from '../../../web/hooks/useLongPress';

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: {
		tap: 10,
		success: [10, 20],
	},
}));

function createTouchEvent(
	target: HTMLElement,
	coords: { x: number; y: number } = { x: 10, y: 10 }
): React.TouchEvent {
	return {
		currentTarget: target,
		touches: [{ clientX: coords.x, clientY: coords.y }],
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as React.TouchEvent;
}

describe('useLongPress', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('prevents synthetic click on touch end after a long press', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));
		const button = document.createElement('button');

		act(() => {
			result.current.elementRef.current = button;
		});

		const startEvent = createTouchEvent(button);
		const endEvent = createTouchEvent(button);

		act(() => {
			result.current.handlers.onTouchStart(startEvent);
			vi.advanceTimersByTime(500);
		});

		act(() => {
			result.current.handlers.onTouchEnd(endEvent);
		});

		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(onTap).not.toHaveBeenCalled();
		expect(endEvent.preventDefault).toHaveBeenCalledTimes(1);
		expect(endEvent.stopPropagation).toHaveBeenCalledTimes(1);
	});

	it('fires onTap for a normal short press', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));
		const button = document.createElement('button');

		act(() => {
			result.current.elementRef.current = button;
		});

		const startEvent = createTouchEvent(button);
		const endEvent = createTouchEvent(button);

		act(() => {
			result.current.handlers.onTouchStart(startEvent);
			vi.advanceTimersByTime(200);
			result.current.handlers.onTouchEnd(endEvent);
		});

		expect(onLongPress).not.toHaveBeenCalled();
		expect(onTap).toHaveBeenCalledTimes(1);
		expect(endEvent.preventDefault).not.toHaveBeenCalled();
	});
});
