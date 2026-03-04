/**
 * AgentConfigPanel.tsx
 *
 * Shared component for agent configuration settings.
 * Used by both NewInstanceModal and the Wizard's AgentSelectionScreen.
 */

import { useState, useRef, useMemo, useEffect } from 'react';
import {
	RefreshCw,
	Plus,
	Trash2,
	HelpCircle,
	ChevronDown,
	Brain,
	Database,
	Sparkles,
	Wrench,
} from 'lucide-react';
import type { Theme, AgentConfig, AgentConfigOption } from '../../types';

// Counter for generating stable IDs for env vars
let envVarIdCounter = 0;

// Built-in environment variables that Maestro sets automatically
const BUILT_IN_ENV_VARS: { key: string; description: string; value: string }[] = [
	{
		key: 'MAESTRO_SESSION_RESUMED',
		description:
			'Set to "1" when resuming an existing session. Not set for new sessions. Use this in your agent hooks to skip initialization on resumed sessions.',
		value: '1 (when resuming)',
	},
];

const PRIMARY_DEFAULT_OPTION_KEYS = ['model', 'contextWindow', 'reasoningEffort'] as const;
const PRIMARY_DEFAULT_ORDER: Record<(typeof PRIMARY_DEFAULT_OPTION_KEYS)[number], number> = {
	model: 0,
	contextWindow: 1,
	reasoningEffort: 2,
};

// Separate component for text input with optional model dropdown
// This avoids the browser's native datalist styling issues
interface ModelTextInputProps {
	theme: Theme;
	option: { key: string; default?: string };
	value: string;
	onChange: (value: string) => void;
	onBlur: () => void;
	availableModels: string[];
	loadingModels: boolean;
	onRefreshModels?: () => void;
}

function ModelTextInput({
	theme,
	option,
	value,
	onChange,
	onBlur,
	availableModels,
	loadingModels,
	onRefreshModels,
}: ModelTextInputProps): JSX.Element {
	const [showDropdown, setShowDropdown] = useState(false);
	const [filterText, setFilterText] = useState('');
	const [isFiltering, setIsFiltering] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const committedValueRef = useRef(value);
	const selectionMadeRef = useRef(false);

	useEffect(() => {
		committedValueRef.current = value;
	}, [value]);

	const filteredModels = useMemo(() => {
		if (!filterText) return availableModels;
		const lower = filterText.toLowerCase();
		return availableModels.filter((m) => m.toLowerCase().includes(lower));
	}, [availableModels, filterText]);

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setShowDropdown(false);
				if (isFiltering) {
					setFilterText('');
					setIsFiltering(false);
				}
			}
		};
		if (showDropdown) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [showDropdown, isFiltering]);

	const isModelField = option.key === 'model';
	const hasModels = availableModels.length > 0;
	const displayValue = isFiltering ? filterText : value;

	return (
		<>
			<div className="flex gap-2" ref={containerRef}>
				<div className="relative flex-1">
					<input
						ref={inputRef}
						type="text"
						value={displayValue}
						onChange={(e) => {
							if (isModelField && hasModels) {
								setFilterText(e.target.value);
								setIsFiltering(true);
								setShowDropdown(true);
							} else {
								onChange(e.target.value);
							}
						}}
						onFocus={() => {
							if (isModelField && hasModels) {
								setFilterText(value);
								setShowDropdown(true);
							}
						}}
						onBlur={() => {
							setTimeout(() => {
								if (selectionMadeRef.current) {
									selectionMadeRef.current = false;
									return;
								}
								setShowDropdown(false);
								if (isFiltering) {
									if (filterText && filterText !== committedValueRef.current) {
										onChange(filterText);
										committedValueRef.current = filterText;
									}
									setIsFiltering(false);
									setFilterText('');
								}
								onBlur();
							}, 150);
						}}
						onClick={(e) => e.stopPropagation()}
						placeholder={option.default || ''}
						className="w-full p-2 rounded border bg-transparent outline-none text-xs font-mono pr-8"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
					{isModelField && hasModels && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								setShowDropdown(!showDropdown);
								inputRef.current?.focus();
							}}
							className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-white/10"
							style={{ color: theme.colors.textDim }}
						>
							<ChevronDown
								className={`w-3 h-3 transition-transform ${showDropdown ? 'rotate-180' : ''}`}
							/>
						</button>
					)}
					{isModelField && showDropdown && filteredModels.length > 0 && (
						<div
							className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded border shadow-lg"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							{filteredModels.map((model) => (
								<button
									key={model}
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										selectionMadeRef.current = true;
										onChange(model);
										committedValueRef.current = model;
										setShowDropdown(false);
										setFilterText('');
										setIsFiltering(false);
										onBlur();
									}}
									className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-white/10 transition-colors"
									style={{
										color: model === value ? theme.colors.accent : theme.colors.textMain,
										backgroundColor: model === value ? 'rgba(255,255,255,0.05)' : undefined,
									}}
								>
									{model}
								</button>
							))}
						</div>
					)}
				</div>
				{isModelField && onRefreshModels && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							onRefreshModels();
						}}
						className="p-2 rounded border hover:bg-white/10 transition-colors"
						title="Refresh available models"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						<RefreshCw className={`w-3 h-3 ${loadingModels ? 'animate-spin' : ''}`} />
					</button>
				)}
			</div>
			{isModelField && loadingModels && (
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					Loading available models...
				</p>
			)}
			{isModelField && !loadingModels && hasModels && (
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					{availableModels.length} model{availableModels.length !== 1 ? 's' : ''} available
				</p>
			)}
		</>
	);
}

export interface AgentConfigPanelProps {
	theme: Theme;
	agent: AgentConfig;
	customPath: string;
	onCustomPathChange: (value: string) => void;
	onCustomPathBlur: () => void;
	onCustomPathClear: () => void;
	customArgs: string;
	onCustomArgsChange: (value: string) => void;
	onCustomArgsBlur: () => void;
	onCustomArgsClear: () => void;
	customEnvVars: Record<string, string>;
	onEnvVarKeyChange: (oldKey: string, newKey: string, value: string) => void;
	onEnvVarValueChange: (key: string, value: string) => void;
	onEnvVarRemove: (key: string) => void;
	onEnvVarAdd: () => void;
	onEnvVarsBlur: () => void;
	agentConfig: Record<string, any>;
	onConfigChange: (key: string, value: any) => void;
	onConfigBlur: () => void;
	availableModels?: string[];
	loadingModels?: boolean;
	onRefreshModels?: () => void;
	onRefreshAgent?: () => void;
	refreshingAgent?: boolean;
	compact?: boolean;
	showBuiltInEnvVars?: boolean;
	isSshEnabled?: boolean;
}

export function AgentConfigPanel({
	theme,
	agent,
	customPath,
	onCustomPathChange,
	onCustomPathBlur,
	onCustomPathClear,
	customArgs,
	onCustomArgsChange,
	onCustomArgsBlur,
	onCustomArgsClear,
	customEnvVars,
	onEnvVarKeyChange,
	onEnvVarValueChange,
	onEnvVarRemove,
	onEnvVarAdd,
	onEnvVarsBlur,
	agentConfig,
	onConfigChange,
	onConfigBlur,
	availableModels = [],
	loadingModels = false,
	onRefreshModels,
	onRefreshAgent,
	refreshingAgent = false,
	compact = false,
	showBuiltInEnvVars = false,
	isSshEnabled = false,
}: AgentConfigPanelProps): JSX.Element {
	const padding = compact ? 'p-2' : 'p-3';
	const spacing = compact ? 'space-y-2' : 'space-y-3';
	const [showingTooltip, setShowingTooltip] = useState<string | null>(null);
	const [showAdvanced, setShowAdvanced] = useState<boolean>(compact);

	const envVarIdsRef = useRef<Map<string, number>>(new Map());
	const pendingKeyEditsRef = useRef<Map<string, string>>(new Map());
	const [, forceUpdate] = useState(0);

	const getEnvVarId = (key: string): number => {
		if (!envVarIdsRef.current.has(key)) {
			envVarIdsRef.current.set(key, ++envVarIdCounter);
		}
		return envVarIdsRef.current.get(key)!;
	};

	useMemo(() => {
		const currentKeys = new Set(Object.keys(customEnvVars));
		for (const key of envVarIdsRef.current.keys()) {
			if (!currentKeys.has(key) && !pendingKeyEditsRef.current.has(key)) {
				envVarIdsRef.current.delete(key);
				pendingKeyEditsRef.current.delete(key);
			}
		}
	}, [customEnvVars]);

	const getKeyDisplayValue = (originalKey: string): string => {
		return pendingKeyEditsRef.current.get(originalKey) ?? originalKey;
	};

	const handleKeyInputChange = (originalKey: string, newKey: string) => {
		pendingKeyEditsRef.current.set(originalKey, newKey);
		forceUpdate((n) => n + 1);
	};

	const handleKeyBlur = (originalKey: string, currentValue: string) => {
		const pendingKey = pendingKeyEditsRef.current.get(originalKey);
		pendingKeyEditsRef.current.delete(originalKey);
		if (pendingKey !== undefined && pendingKey !== originalKey) {
			const id = envVarIdsRef.current.get(originalKey);
			if (id !== undefined) {
				envVarIdsRef.current.delete(originalKey);
				envVarIdsRef.current.set(pendingKey, id);
			}
			onEnvVarKeyChange(originalKey, pendingKey, currentValue);
		}
		onEnvVarsBlur();
	};

	const configOptions = agent.configOptions || [];
	const primaryOptions = useMemo(() => {
		return configOptions
			.filter((option) =>
				PRIMARY_DEFAULT_OPTION_KEYS.includes(
					option.key as (typeof PRIMARY_DEFAULT_OPTION_KEYS)[number]
				)
			)
			.sort((a, b) => {
				const aOrder =
					PRIMARY_DEFAULT_ORDER[a.key as keyof typeof PRIMARY_DEFAULT_ORDER] ??
					Number.MAX_SAFE_INTEGER;
				const bOrder =
					PRIMARY_DEFAULT_ORDER[b.key as keyof typeof PRIMARY_DEFAULT_ORDER] ??
					Number.MAX_SAFE_INTEGER;
				return aOrder - bOrder;
			});
	}, [configOptions]);

	const secondaryOptions = useMemo(() => {
		return configOptions.filter(
			(option) =>
				!PRIMARY_DEFAULT_OPTION_KEYS.includes(
					option.key as (typeof PRIMARY_DEFAULT_OPTION_KEYS)[number]
				)
		);
	}, [configOptions]);

	const formatSelectOptionLabel = (optionKey: string, rawValue: string): string => {
		if (rawValue === '') return 'Default';
		if (optionKey === 'reasoningEffort') {
			return rawValue === 'xhigh'
				? 'Extra High'
				: rawValue.charAt(0).toUpperCase() + rawValue.slice(1);
		}
		return rawValue;
	};

	const renderConfigOptionControl = (
		option: AgentConfigOption,
		compactVariant = false
	): JSX.Element => {
		const inputClass = compactVariant
			? 'w-full p-2 rounded border bg-transparent outline-none text-xs font-mono'
			: 'w-full p-2 rounded border bg-transparent outline-none text-sm';

		if (option.type === 'number') {
			return (
				<input
					type="number"
					value={agentConfig[option.key] ?? option.default}
					onChange={(e) => {
						const value = e.target.value === '' ? 0 : parseInt(e.target.value, 10);
						onConfigChange(option.key, isNaN(value) ? 0 : value);
					}}
					onBlur={onConfigBlur}
					onClick={(e) => e.stopPropagation()}
					placeholder={option.default?.toString() || '0'}
					min={0}
					className={inputClass}
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				/>
			);
		}

		if (option.type === 'text') {
			return (
				<ModelTextInput
					theme={theme}
					option={option}
					value={agentConfig[option.key] ?? option.default}
					onChange={(value) => onConfigChange(option.key, value)}
					onBlur={onConfigBlur}
					availableModels={option.key === 'model' ? availableModels : []}
					loadingModels={option.key === 'model' ? loadingModels : false}
					onRefreshModels={
						option.key === 'model' && agent.capabilities?.supportsModelSelection
							? onRefreshModels
							: undefined
					}
				/>
			);
		}

		if (option.type === 'checkbox') {
			return (
				<label
					className="flex items-center gap-2 cursor-pointer"
					onClick={(e) => e.stopPropagation()}
				>
					<input
						type="checkbox"
						checked={agentConfig[option.key] ?? option.default}
						onChange={(e) => {
							onConfigChange(option.key, e.target.checked);
							onConfigBlur();
						}}
						className="w-4 h-4"
						style={{ accentColor: theme.colors.accent }}
					/>
					<span className="text-xs" style={{ color: theme.colors.textMain }}>
						Enabled
					</span>
				</label>
			);
		}

		if (option.type === 'select' && option.options) {
			return (
				<select
					value={agentConfig[option.key] ?? option.default ?? ''}
					onChange={(e) => {
						onConfigChange(option.key, e.target.value);
						onConfigBlur();
					}}
					onClick={(e) => e.stopPropagation()}
					className={`w-full p-2 rounded border bg-transparent outline-none ${
						compactVariant ? 'text-xs' : 'text-sm'
					} cursor-pointer`}
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					{option.options.map((opt) => (
						<option key={opt} value={opt} style={{ backgroundColor: theme.colors.bgMain }}>
							{formatSelectOptionLabel(option.key, opt)}
						</option>
					))}
				</select>
			);
		}

		return <></>;
	};

	const getDefaultOptionStyle = (
		optionKey: string
	): { icon: typeof Sparkles; color: string; tint: string; border: string } => {
		if (optionKey === 'contextWindow') {
			return {
				icon: Database,
				color: theme.colors.success,
				tint: `${theme.colors.success}12`,
				border: `${theme.colors.success}55`,
			};
		}
		if (optionKey === 'reasoningEffort') {
			return {
				icon: Brain,
				color: theme.colors.warning,
				tint: `${theme.colors.warning}12`,
				border: `${theme.colors.warning}55`,
			};
		}
		return {
			icon: Sparkles,
			color: theme.colors.accent,
			tint: `${theme.colors.accent}12`,
			border: `${theme.colors.accent}55`,
		};
	};

	return (
		<div className={spacing}>
			{primaryOptions.length > 0 && (
				<div
					className={`${padding} rounded border`}
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div
						className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
						style={{ color: theme.colors.textDim }}
					>
						<Sparkles className="w-3 h-3" />
						Defaults
					</div>
					<div className="space-y-2">
						{primaryOptions.map((option: AgentConfigOption) => {
							const optionStyle = getDefaultOptionStyle(option.key);
							const OptionIcon = optionStyle.icon;
							return (
								<div
									key={option.key}
									className="p-2 rounded border"
									style={{ borderColor: optionStyle.border, backgroundColor: optionStyle.tint }}
								>
									<div className="flex items-center gap-1.5 mb-2">
										<OptionIcon className="w-3.5 h-3.5" style={{ color: optionStyle.color }} />
										<div className="text-xs font-semibold" style={{ color: optionStyle.color }}>
											{option.label}
										</div>
									</div>
									{renderConfigOptionControl(option)}
									<p className="text-xs opacity-65 mt-2" style={{ color: theme.colors.textDim }}>
										{option.description}
									</p>
								</div>
							);
						})}
					</div>
				</div>
			)}

			<div
				className={`${padding} rounded border`}
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<button
					type="button"
					onClick={() => setShowAdvanced((prev) => !prev)}
					className="w-full flex items-center justify-between text-xs font-medium"
					style={{ color: theme.colors.textDim }}
				>
					<span className="flex items-center gap-2">
						<Wrench className="w-3.5 h-3.5" />
						Advanced
					</span>
					<ChevronDown
						className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
					/>
				</button>
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					Runtime path and optional overrides.
				</p>
				{showAdvanced && (
					<div className="space-y-3 mt-3">
						<div>
							<label
								className="block text-xs font-medium mb-2 flex items-center justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>{isSshEnabled ? 'Remote Command' : 'Path'}</span>
								{onRefreshAgent && !isSshEnabled && (
									<button
										onClick={onRefreshAgent}
										className="p-1 rounded hover:bg-white/10 transition-colors flex items-center gap-1"
										title="Re-check command location"
										style={{ color: theme.colors.textDim }}
									>
										<RefreshCw className={`w-3 h-3 ${refreshingAgent ? 'animate-spin' : ''}`} />
										<span className="text-xs">Find</span>
									</button>
								)}
							</label>
							<div className="flex gap-2">
								<input
									type="text"
									value={customPath || (isSshEnabled ? agent.binaryName : agent.path) || ''}
									onChange={(e) => onCustomPathChange(e.target.value)}
									onBlur={onCustomPathBlur}
									onClick={(e) => e.stopPropagation()}
									placeholder={`/path/to/${agent.binaryName}`}
									readOnly={isSshEnabled && !customPath}
									className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										opacity: isSshEnabled && !customPath ? 0.7 : 1,
									}}
								/>
								{customPath && (
									<button
										onClick={(e) => {
											e.stopPropagation();
											onCustomPathClear();
										}}
										className="px-2 py-1.5 rounded text-xs"
										style={{
											backgroundColor: theme.colors.bgActivity,
											color: theme.colors.textDim,
										}}
										title={isSshEnabled ? 'Reset to remote binary name' : 'Reset to detected path'}
									>
										Reset
									</button>
								)}
							</div>
							<p className="text-xs opacity-50 mt-2">
								{isSshEnabled
									? `Command used on the remote machine. Leave blank to use ${agent.binaryName}.`
									: `Maestro detected this automatically. Set manually only if needed.`}
							</p>
						</div>

						<div>
							<label
								className="block text-xs font-medium mb-2"
								style={{ color: theme.colors.textDim }}
							>
								Custom Arguments (optional)
							</label>
							<div className="flex gap-2">
								<input
									type="text"
									value={customArgs}
									onChange={(e) => onCustomArgsChange(e.target.value)}
									onBlur={onCustomArgsBlur}
									onClick={(e) => e.stopPropagation()}
									placeholder="--flag value --another-flag"
									className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								/>
								{customArgs && (
									<button
										onClick={(e) => {
											e.stopPropagation();
											onCustomArgsClear();
										}}
										className="px-2 py-1.5 rounded text-xs"
										style={{
											backgroundColor: theme.colors.bgActivity,
											color: theme.colors.textDim,
										}}
									>
										Clear
									</button>
								)}
							</div>
							<p className="text-xs opacity-50 mt-2">
								Extra command flags added whenever this agent starts.
							</p>
						</div>

						<div>
							<label
								className="block text-xs font-medium mb-2"
								style={{ color: theme.colors.textDim }}
							>
								Environment Variables (optional)
							</label>
							<div className="space-y-2">
								{showBuiltInEnvVars &&
									BUILT_IN_ENV_VARS.map((envVar) => (
										<div
											key={envVar.key}
											className="flex gap-2 items-center rounded px-2 py-1.5"
											style={{ backgroundColor: theme.colors.bgActivity }}
										>
											<div
												className="p-2 rounded text-xs font-mono flex items-center gap-1 whitespace-nowrap"
												style={{ color: theme.colors.textDim }}
											>
												<span>{envVar.key}</span>
												<div className="relative inline-block">
													<button
														onClick={(e) => {
															e.stopPropagation();
															setShowingTooltip(showingTooltip === envVar.key ? null : envVar.key);
														}}
														onBlur={() => setTimeout(() => setShowingTooltip(null), 150)}
														className="p-0.5 rounded hover:bg-white/10 transition-colors"
														title="What is this?"
														style={{ color: theme.colors.accent }}
													>
														<HelpCircle className="w-3 h-3" />
													</button>
													{showingTooltip === envVar.key && (
														<div
															className="absolute left-1/2 bottom-full mb-1 z-50 p-3 rounded shadow-lg text-xs whitespace-normal leading-relaxed"
															style={{
																backgroundColor: theme.colors.bgMain,
																border: `1px solid ${theme.colors.border}`,
																color: theme.colors.textMain,
																width: '320px',
																transform: 'translateX(-50%)',
															}}
														>
															{envVar.description}
														</div>
													)}
												</div>
											</div>
											<span className="text-xs" style={{ color: theme.colors.textDim }}>
												=
											</span>
											<div
												className="p-2 rounded text-xs font-mono italic whitespace-nowrap"
												style={{ color: theme.colors.textDim }}
											>
												{envVar.value}
											</div>
										</div>
									))}
								{Object.entries(customEnvVars).map(([key, value]) => (
									<div key={`env-var-${getEnvVarId(key)}`} className="flex gap-2">
										<input
											type="text"
											value={getKeyDisplayValue(key)}
											onChange={(e) => handleKeyInputChange(key, e.target.value)}
											onBlur={() => handleKeyBlur(key, value)}
											onClick={(e) => e.stopPropagation()}
											placeholder="VARIABLE_NAME"
											className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
											style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
										/>
										<span
											className="flex items-center text-xs"
											style={{ color: theme.colors.textDim }}
										>
											=
										</span>
										<input
											type="text"
											value={value}
											onChange={(e) => onEnvVarValueChange(key, e.target.value)}
											onBlur={onEnvVarsBlur}
											onClick={(e) => e.stopPropagation()}
											placeholder="value"
											className="flex-[2] p-2 rounded border bg-transparent outline-none text-xs font-mono"
											style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
										/>
										<button
											onClick={(e) => {
												e.stopPropagation();
												onEnvVarRemove(key);
											}}
											className="p-2 rounded hover:bg-white/10 transition-colors"
											title="Remove variable"
											style={{ color: theme.colors.textDim }}
										>
											<Trash2 className="w-3 h-3" />
										</button>
									</div>
								))}
								<button
									onClick={(e) => {
										e.stopPropagation();
										onEnvVarAdd();
									}}
									className="flex items-center gap-1 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textDim }}
								>
									<Plus className="w-3 h-3" />
									Add Variable
								</button>
							</div>
							<p className="text-xs opacity-50 mt-2">
								Extra environment values available only to this agent.
							</p>
						</div>

						{secondaryOptions.length > 0 && (
							<div className="space-y-2 pt-1">
								<div className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
									Additional Runtime Options
								</div>
								{secondaryOptions.map((option: AgentConfigOption) => (
									<div
										key={option.key}
										className="p-2 rounded border"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgActivity,
										}}
									>
										<div
											className="text-xs font-medium mb-1"
											style={{ color: theme.colors.textMain }}
										>
											{option.label}
										</div>
										{renderConfigOptionControl(option, true)}
										<p className="text-xs opacity-60 mt-2" style={{ color: theme.colors.textDim }}>
											{option.description}
										</p>
									</div>
								))}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
