/**
 * Tests for useKeyboardVisibility hook
 *
 * Covers:
 * - Default state when Visual Viewport API is unavailable
 * - Keyboard offset calculation when viewport shrinks
 * - Event listener registration and cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useKeyboardVisibility } from '../../../web/hooks/useKeyboardVisibility';

type MockViewport = {
	height: number;
	offsetTop: number;
	addEventListener: (event: string, handler: () => void) => void;
	removeEventListener: (event: string, handler: () => void) => void;
};

function setVisualViewport(mockViewport?: MockViewport) {
	if (mockViewport) {
		Object.defineProperty(window, 'visualViewport', {
			value: mockViewport,
			configurable: true,
			writable: true,
		});
	} else {
		Object.defineProperty(window, 'visualViewport', {
			value: undefined,
			configurable: true,
			writable: true,
		});
	}
}

function createMockViewport(initial: { height: number; offsetTop: number }) {
	const listeners = new Map<string, Set<() => void>>();
	const viewport: MockViewport & { emit: (event: string) => void } = {
		height: initial.height,
		offsetTop: initial.offsetTop,
		addEventListener: vi.fn((event: string, handler: () => void) => {
			if (!listeners.has(event)) {
				listeners.set(event, new Set());
			}
			listeners.get(event)!.add(handler);
		}),
		removeEventListener: vi.fn((event: string, handler: () => void) => {
			listeners.get(event)?.delete(handler);
		}),
		emit: (event: string) => {
			for (const handler of listeners.get(event) || []) {
				handler();
			}
		},
	};
	return viewport;
}

describe('useKeyboardVisibility', () => {
	const originalInnerHeight = window.innerHeight;

	beforeEach(() => {
		vi.restoreAllMocks();
		setVisualViewport(undefined);
	});

	afterEach(() => {
		window.innerHeight = originalInnerHeight;
		setVisualViewport(undefined);
	});

	it('returns default state when Visual Viewport API is unavailable', () => {
		setVisualViewport(undefined);
		const { result } = renderHook(() => useKeyboardVisibility());

		expect(result.current.keyboardOffset).toBe(0);
		expect(result.current.isKeyboardVisible).toBe(false);
	});

	it('calculates keyboard offset from viewport height', async () => {
		const viewport = createMockViewport({ height: 600, offsetTop: 0 });

		setVisualViewport(viewport);

		window.innerHeight = 800;

		const input = document.createElement('textarea');
		document.body.appendChild(input);
		input.focus();

		const { result } = renderHook(() => useKeyboardVisibility());

		await waitFor(() => {
			expect(result.current.keyboardOffset).toBe(200);
			expect(result.current.isKeyboardVisible).toBe(true);
		});

		input.remove();
	});

	it('registers and cleans up viewport listeners', () => {
		const viewport = createMockViewport({ height: 700, offsetTop: 0 });

		setVisualViewport(viewport);

		const { unmount } = renderHook(() => useKeyboardVisibility());

		expect(viewport.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
		expect(viewport.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));

		unmount();

		expect(viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
		expect(viewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
	});

	it('clears stale keyboard offset when the viewport returns to its baseline', async () => {
		const viewport = createMockViewport({ height: 844, offsetTop: 0 });
		setVisualViewport(viewport);
		window.innerHeight = 844;
		const input = document.createElement('textarea');
		document.body.appendChild(input);
		input.focus();

		const { result } = renderHook(() => useKeyboardVisibility());

		expect(result.current.keyboardOffset).toBe(0);
		expect(result.current.isKeyboardVisible).toBe(false);

		act(() => {
			viewport.height = 520;
			viewport.emit('resize');
		});

		await waitFor(() => {
			expect(result.current.keyboardOffset).toBe(324);
			expect(result.current.isKeyboardVisible).toBe(true);
		});

		act(() => {
			viewport.height = 844;
			viewport.emit('resize');
		});

		await waitFor(() => {
			expect(result.current.keyboardOffset).toBe(0);
			expect(result.current.isKeyboardVisible).toBe(false);
		});

		input.remove();
	});

	it('resets the keyboard offset when focus leaves editable elements', async () => {
		const viewport = createMockViewport({ height: 780, offsetTop: 0 });
		setVisualViewport(viewport);
		window.innerHeight = 844;

		const input = document.createElement('textarea');
		document.body.appendChild(input);
		input.focus();

		const { result } = renderHook(() => useKeyboardVisibility());

		act(() => {
			viewport.height = 520;
			viewport.emit('resize');
		});

		await waitFor(() => {
			expect(result.current.keyboardOffset).toBe(324);
			expect(result.current.isKeyboardVisible).toBe(true);
		});

		act(() => {
			input.blur();
			viewport.height = 780;
			viewport.emit('resize');
		});

		await waitFor(() => {
			expect(result.current.keyboardOffset).toBe(0);
			expect(result.current.isKeyboardVisible).toBe(false);
		});

		input.remove();
	});
});
