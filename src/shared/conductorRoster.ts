import type { ConductorProviderAgent } from './types';

export interface ConductorRosterIdentity {
	name: string;
	emoji: string;
}

export const CLAUDE_CONDUCTOR_ROSTER: readonly ConductorRosterIdentity[] = [
	{ name: 'Vera', emoji: '🌿' },
	{ name: 'Mira', emoji: '🌙' },
	{ name: 'Evie', emoji: '✨' },
	{ name: 'Lina', emoji: '🌸' },
	{ name: 'Selah', emoji: '🕊️' },
	{ name: 'Talia', emoji: '🎀' },
	{ name: 'Ines', emoji: '🍃' },
	{ name: 'Kaia', emoji: '🌊' },
	{ name: 'Noemi', emoji: '💫' },
	{ name: 'Leona', emoji: '🦋' },
	{ name: 'Eliza', emoji: '🌼' },
	{ name: 'Celine', emoji: '🎐' },
	{ name: 'Nadia', emoji: '🌷' },
	{ name: 'Clara', emoji: '🫧' },
	{ name: 'Maeve', emoji: '🍓' },
] as const;

export const CODEX_CONDUCTOR_ROSTER: readonly ConductorRosterIdentity[] = [
	{ name: 'Jupiter', emoji: '🪐' },
	{ name: 'Kairo', emoji: '⚙️' },
	{ name: 'Eli', emoji: '🔹' },
	{ name: 'Dorian', emoji: '🧰' },
	{ name: 'Cillian', emoji: '🛠️' },
	{ name: 'Arden', emoji: '🧭' },
	{ name: 'Niko', emoji: '⚡' },
	{ name: 'Jonas', emoji: '🧩' },
	{ name: 'Theo', emoji: '📘' },
	{ name: 'Lucian', emoji: '🔧' },
	{ name: 'Rowan', emoji: '🌲' },
	{ name: 'Ivo', emoji: '🧠' },
	{ name: 'Matteo', emoji: '📐' },
	{ name: 'Adrian', emoji: '🛰️' },
	{ name: 'Luca', emoji: '🚀' },
] as const;

function getConductorRoster(toolType: ConductorProviderAgent): readonly ConductorRosterIdentity[] {
	if (toolType === 'claude-code') {
		return CLAUDE_CONDUCTOR_ROSTER;
	}
	if (toolType === 'codex') {
		return CODEX_CONDUCTOR_ROSTER;
	}
	return toolType === 'opencode' ? CLAUDE_CONDUCTOR_ROSTER : CODEX_CONDUCTOR_ROSTER;
}

function hashSeed(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
	}
	return hash;
}

export function extractConductorRosterName(sessionName: string): string {
	const normalized = sessionName.trim();
	if (!normalized) {
		return '';
	}

	const [firstSegment] = normalized.split(' · ');
	return firstSegment.trim();
}

export function getConductorRosterIdentityByName(
	toolType: ConductorProviderAgent,
	name: string
): ConductorRosterIdentity {
	const roster = getConductorRoster(toolType);
	const exactMatch = roster.find((entry) => entry.name === name.trim());
	if (exactMatch) {
		return exactMatch;
	}

	return roster[hashSeed(name || toolType) % roster.length];
}

export function resolveConductorRosterIdentity(
	toolType: ConductorProviderAgent,
	sessionName: string
): ConductorRosterIdentity {
	const extractedName = extractConductorRosterName(sessionName);
	return getConductorRosterIdentityByName(toolType, extractedName || sessionName);
}

export function getConductorNamePool(toolType: ConductorProviderAgent): readonly string[] {
	return getConductorRoster(toolType).map((entry) => entry.name);
}
