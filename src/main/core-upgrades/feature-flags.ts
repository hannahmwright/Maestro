export function isCoreUpgradesEnabled(): boolean {
	return (process.env.MAESTRO_CORE_UPGRADES || '').toLowerCase() !== 'off';
}
