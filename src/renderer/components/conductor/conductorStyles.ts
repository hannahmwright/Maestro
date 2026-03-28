import type { CSSProperties } from 'react';

import type { Theme, ConductorTaskStatus, ConductorTaskPriority } from '../../types';

// ── Glass morphism helpers ──────────────────────────────────────────
//
// NOTE: backdrop-filter was intentionally removed from all inline style
// helpers.  Chromium/Electron re-composites the blurred backdrop on
// every scroll frame, which causes white-flash repaint artefacts in the
// kanban board (and any other scroll container with many child elements
// that carry the property).  The linear-gradient + solid backgroundColor
// fallback already gives the frosted-glass look without the GPU cost.
// If you need backdrop-blur on a *fixed* overlay (e.g. a modal scrim),
// apply it directly in CSS where it won't sit inside a scroll container.

export function getGlassPanelStyle(
	theme: Theme,
	options?: {
		tint?: string;
		borderColor?: string;
		strong?: boolean;
		elevated?: boolean;
	}
): CSSProperties {
	const tint = options?.tint || 'rgba(255, 255, 255, 0.10)';
	const borderColor = options?.borderColor || 'rgba(255, 255, 255, 0.10)';
	const strong = options?.strong ?? false;
	const elevated = options?.elevated ?? false;

	return {
		background: `linear-gradient(180deg, ${tint} 0%, rgba(255, 255, 255, ${strong ? '0.06' : '0.04'}) 42%, rgba(255, 255, 255, 0.02) 100%)`,
		backgroundColor: theme.colors.bgSidebar,
		border: `1px solid ${borderColor}`,
		boxShadow: strong
			? elevated
				? '0 30px 60px rgba(15, 23, 42, 0.18), 0 12px 28px rgba(15, 23, 42, 0.12), 0 1px 0 rgba(255, 255, 255, 0.20) inset, 0 -1px 0 rgba(255, 255, 255, 0.03) inset'
				: '0 24px 48px rgba(15, 23, 42, 0.14), 0 10px 24px rgba(15, 23, 42, 0.10), 0 1px 0 rgba(255, 255, 255, 0.16) inset, 0 -1px 0 rgba(255, 255, 255, 0.03) inset'
			: elevated
				? '0 22px 42px rgba(15, 23, 42, 0.14), 0 8px 20px rgba(15, 23, 42, 0.09), 0 1px 0 rgba(255, 255, 255, 0.14) inset, 0 -1px 0 rgba(255, 255, 255, 0.03) inset'
				: '0 16px 30px rgba(15, 23, 42, 0.10), 0 6px 14px rgba(15, 23, 42, 0.07), 0 1px 0 rgba(255, 255, 255, 0.12) inset, 0 -1px 0 rgba(255, 255, 255, 0.02) inset',
	};
}

export function getGlassButtonStyle(
	theme: Theme,
	options?: {
		active?: boolean;
		accent?: boolean;
	}
): CSSProperties {
	const active = options?.active ?? false;
	const accent = options?.accent ?? false;

	if (accent) {
		return {
			border: `1px solid ${theme.colors.accent}35`,
			background: `linear-gradient(180deg, ${theme.colors.accent} 0%, ${theme.colors.accent}e0 55%, ${theme.colors.accent}c8 100%)`,
			color: theme.colors.accentForeground,
			boxShadow: `0 22px 34px ${theme.colors.accent}30, 0 10px 18px ${theme.colors.accent}18, inset 0 1px 0 rgba(255,255,255,0.24), inset 0 -1px 0 rgba(0,0,0,0.08)`,
		};
	}

	return {
		border: `1px solid ${active ? `${theme.colors.accent}32` : 'rgba(255, 255, 255, 0.10)'}`,
		background: active
			? `linear-gradient(180deg, ${theme.colors.accent}18 0%, rgba(255,255,255,0.08) 55%, rgba(255,255,255,0.03) 100%)`
			: 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 55%, rgba(255,255,255,0.03) 100%)',
		color: active ? theme.colors.textMain : theme.colors.textDim,
		boxShadow: active
			? '0 16px 28px rgba(15, 23, 42, 0.12), 0 6px 14px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(255,255,255,0.03)'
			: '0 12px 22px rgba(15, 23, 42, 0.08), 0 4px 10px rgba(15, 23, 42, 0.05), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(255,255,255,0.02)',
	};
}

export function getGlassInputStyle(theme: Theme): CSSProperties {
	return {
		background:
			'linear-gradient(180deg, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.07) 55%, rgba(255,255,255,0.03) 100%)',
		backgroundColor: theme.colors.bgMain,
		border: '1px solid rgba(255,255,255,0.10)',
		color: theme.colors.textMain,
		boxShadow:
			'0 10px 20px rgba(15, 23, 42, 0.05), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(255,255,255,0.02)',
	};
}

export function getGlassPillStyle(
	theme: Theme,
	tone?: 'default' | 'accent' | 'success' | 'warning'
): CSSProperties {
	const tint =
		tone === 'success'
			? theme.colors.success
			: tone === 'warning'
				? theme.colors.warning
				: tone === 'accent'
					? theme.colors.accent
					: theme.colors.textDim;

	return {
		background: `linear-gradient(180deg, ${tint}18 0%, rgba(255,255,255,0.07) 55%, rgba(255,255,255,0.03) 100%)`,
		border: `1px solid ${tint}28`,
		color: tint,
		boxShadow: '0 10px 18px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255,255,255,0.08)',
	};
}

// ── Pastel status tones ─────────────────────────────────────────────

export const PASTEL_STATUS_TONES: Record<
	ConductorTaskStatus,
	{ fg: string; bg: string; border: string }
> = {
	draft: { fg: '#b0b8c4', bg: '#b0b8c41a', border: '#b0b8c43d' }, // soft gray
	planning: { fg: '#a78bfa', bg: '#a78bfa1a', border: '#a78bfa3d' }, // lavender
	ready: { fg: '#60a5fa', bg: '#60a5fa1a', border: '#60a5fa3d' }, // sky blue
	running: { fg: '#818cf8', bg: '#818cf81a', border: '#818cf83d' }, // periwinkle
	needs_revision: { fg: '#fbbf24', bg: '#fbbf241a', border: '#fbbf243d' }, // buttercup
	needs_input: { fg: '#fb7185', bg: '#fb71851a', border: '#fb71853d' }, // rose
	needs_proof: { fg: '#14b8a6', bg: '#14b8a61a', border: '#14b8a63d' }, // teal
	blocked: { fg: '#fb923c', bg: '#fb923c1a', border: '#fb923c3d' }, // peach
	needs_review: { fg: '#22d3ee', bg: '#22d3ee1a', border: '#22d3ee3d' }, // aqua
	cancelled: { fg: '#94a3b8', bg: '#94a3b81a', border: '#94a3b83d' }, // slate
	done: { fg: '#22c55e', bg: '#22c55e1a', border: '#22c55e3d' }, // green
};

export function getTaskStatusTone(
	_theme: Theme,
	status: ConductorTaskStatus
): { bg: string; fg: string; border: string } {
	return PASTEL_STATUS_TONES[status] ?? PASTEL_STATUS_TONES.draft;
}

export function getTaskPriorityTone(
	theme: Theme,
	priority: ConductorTaskPriority
): { bg: string; fg: string; border: string } {
	switch (priority) {
		case 'critical':
			return {
				bg: `${theme.colors.error}18`,
				fg: theme.colors.error,
				border: `${theme.colors.error}35`,
			};
		case 'high':
			return {
				bg: `${theme.colors.warning}18`,
				fg: theme.colors.warning,
				border: `${theme.colors.warning}35`,
			};
		case 'medium':
			return {
				bg: `${theme.colors.accent}14`,
				fg: theme.colors.accent,
				border: `${theme.colors.accent}30`,
			};
		default:
			return {
				bg: `${theme.colors.textDim}10`,
				fg: theme.colors.textDim,
				border: `${theme.colors.textDim}24`,
			};
	}
}

// ── Simpler aliases (used by ConductorHomePanel) ────────────────────

export function getHomePanelStyle(
	theme: Theme,
	tint = 'rgba(255,255,255,0.06)',
	border = 'rgba(255,255,255,0.08)'
): CSSProperties {
	return {
		background: `linear-gradient(180deg, ${tint} 0%, rgba(255,255,255,0.02) 100%)`,
		backgroundColor: theme.colors.bgSidebar,
		border: `1px solid ${border}`,
		boxShadow:
			'0 20px 44px rgba(15, 23, 42, 0.10), 0 8px 18px rgba(15, 23, 42, 0.06), 0 1px 0 rgba(255,255,255,0.10) inset',
	};
}

export function getHomeInputStyle(theme: Theme): CSSProperties {
	return {
		backgroundColor: `${theme.colors.bgSidebar}cc`,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};
}
