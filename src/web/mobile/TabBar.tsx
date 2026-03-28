/**
 * Mobile thread navigation strip for the web interface.
 *
 * This replaces the legacy multi-tab UI with compact turn markers plus
 * quick actions for model switching and starting a new thread.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentModelCatalogGroup } from '../../shared/agent-model-catalog';
import { useThemeColors } from '../components/ThemeProvider';
import { ModelSelectorButton } from './CommandInputButtons';
import { useScrollTapGuard } from './useScrollTapGuard';

interface TurnMarker {
	key: string;
	label: string;
	timestamp: number;
}

interface TabBarProps {
	sessionKey?: string | null;
	onNewThread: () => void;
	supportsModelSelection?: boolean;
	modelLabel?: string;
	modelToolType?: string | null;
	loadModels?: (forceRefresh?: boolean) => Promise<string[]>;
	onSelectModel?: (model: string | null) => Promise<void> | void;
	canChooseProviderModels?: boolean;
	loadProviderModels?: (forceRefresh?: boolean) => Promise<AgentModelCatalogGroup[]>;
	onSelectProviderModel?: (provider: string, model: string | null) => Promise<void> | void;
	contextUsagePercentage?: number | null;
	contextUsageColor?: string;
}

function normalizeModelLabel(model: string | null | undefined): string | null {
	const normalized = model?.trim();
	if (!normalized || normalized.toLowerCase() === 'default' || normalized === 'Model') {
		return null;
	}
	return normalized;
}

export function TabBar({
	sessionKey = null,
	onNewThread,
	supportsModelSelection = false,
	modelLabel = 'Model',
	modelToolType = null,
	loadModels,
	onSelectModel,
	canChooseProviderModels = false,
	loadProviderModels,
	onSelectProviderModel,
	contextUsagePercentage = null,
	contextUsageColor,
}: TabBarProps) {
	const colors = useThemeColors();
	const modelMenuRef = useRef<HTMLDivElement>(null);
	const {
		scrollGuardProps: modelMenuScrollGuardProps,
		shouldIgnoreClick: shouldIgnoreModelMenuClick,
	} = useScrollTapGuard();
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [modelCatalogGroups, setModelCatalogGroups] = useState<AgentModelCatalogGroup[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [pullDistance, setPullDistance] = useState(0);
	const pullStartYRef = useRef<number | null>(null);
	const collapseStartYRef = useRef<number | null>(null);
	const collapseDeltaYRef = useRef(0);
	const normalizedCurrentModel = normalizeModelLabel(modelLabel);
	const canOpenModelMenu =
		(canChooseProviderModels && !!loadProviderModels) || (supportsModelSelection && !!loadModels);

	useEffect(() => {
		if (!canOpenModelMenu) {
			setModelMenuOpen(false);
		}
	}, [canOpenModelMenu]);

	useEffect(() => {
		setIsExpanded(false);
		setPullDistance(0);
		setModelMenuOpen(false);
	}, [sessionKey]);

	useEffect(() => {
		if (!modelMenuOpen) {
			return;
		}

		const handlePointerDown = (event: MouseEvent | TouchEvent) => {
			const target = event.target as Node;
			if (modelMenuRef.current && !modelMenuRef.current.contains(target)) {
				setModelMenuOpen(false);
			}
		};

		document.addEventListener('mousedown', handlePointerDown);
		document.addEventListener('touchstart', handlePointerDown);

		return () => {
			document.removeEventListener('mousedown', handlePointerDown);
			document.removeEventListener('touchstart', handlePointerDown);
		};
	}, [modelMenuOpen]);

	const handleToggleModelMenu = useCallback(async () => {
		if (!canOpenModelMenu) {
			return;
		}

		const nextOpen = !modelMenuOpen;
		setModelMenuOpen(nextOpen);
		if (!nextOpen) {
			return;
		}

		setLoadingModels(true);
		try {
			if (canChooseProviderModels && loadProviderModels) {
				const groups = await loadProviderModels(false);
				setModelCatalogGroups(groups);
				return;
			}

			const models = await loadModels?.(false);
			setAvailableModels(models || []);
		} finally {
			setLoadingModels(false);
		}
	}, [canChooseProviderModels, canOpenModelMenu, loadModels, loadProviderModels, modelMenuOpen]);

	const handleRefreshModels = useCallback(async () => {
		if (!canOpenModelMenu) {
			return;
		}

		setLoadingModels(true);
		try {
			if (canChooseProviderModels && loadProviderModels) {
				const groups = await loadProviderModels(true);
				setModelCatalogGroups(groups);
				return;
			}

			const models = await loadModels?.(true);
			setAvailableModels(models || []);
		} finally {
			setLoadingModels(false);
		}
	}, [canChooseProviderModels, canOpenModelMenu, loadModels, loadProviderModels]);

	const handleSelectModelInternal = useCallback(
		async (model: string | null) => {
			if (shouldIgnoreModelMenuClick() || !onSelectModel) {
				return;
			}
			await onSelectModel(model);
			setModelMenuOpen(false);
		},
		[onSelectModel, shouldIgnoreModelMenuClick]
	);

	const handleSelectProviderModelInternal = useCallback(
		async (provider: string, model: string | null) => {
			if (shouldIgnoreModelMenuClick() || !onSelectProviderModel) {
				return;
			}
			await onSelectProviderModel(provider, model);
			setModelMenuOpen(false);
		},
		[onSelectProviderModel, shouldIgnoreModelMenuClick]
	);

	const selectableModels = useMemo(() => {
		const currentModel = modelLabel.trim();
		const models = [...availableModels];
		if (currentModel && currentModel !== 'Model' && !models.includes(currentModel)) {
			models.unshift(currentModel);
		}
		return models;
	}, [availableModels, modelLabel]);
	const clampedContextUsage =
		contextUsagePercentage === null ? null : Math.max(0, Math.min(100, contextUsagePercentage));
	const contextIndicatorColor = contextUsageColor || colors.textDim;
	const collapsedHandleOffset = Math.min(26, pullDistance * 0.45);

	const handleExpand = useCallback(() => {
		setPullDistance(0);
		setIsExpanded(true);
	}, []);

	const handleCollapse = useCallback(() => {
		setModelMenuOpen(false);
		setPullDistance(0);
		setIsExpanded(false);
	}, []);

	const handlePullStart = useCallback((event: React.TouchEvent<HTMLButtonElement>) => {
		pullStartYRef.current = event.touches[0]?.clientY ?? null;
	}, []);

	const handlePullMove = useCallback((event: React.TouchEvent<HTMLButtonElement>) => {
		if (pullStartYRef.current === null) {
			return;
		}

		const currentY = event.touches[0]?.clientY;
		if (typeof currentY !== 'number') {
			return;
		}

		const delta = Math.max(0, currentY - pullStartYRef.current);
		setPullDistance(Math.min(64, delta));
	}, []);

	const handlePullEnd = useCallback(() => {
		if (pullDistance >= 24) {
			handleExpand();
			pullStartYRef.current = null;
			return;
		}

		pullStartYRef.current = null;
		setPullDistance(0);
	}, [handleExpand, pullDistance]);

	const handleCollapseSwipeStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
		collapseStartYRef.current = event.touches[0]?.clientY ?? null;
		collapseDeltaYRef.current = 0;
	}, []);

	const handleCollapseSwipeMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
		if (collapseStartYRef.current === null) {
			return;
		}

		const currentY = event.touches[0]?.clientY;
		if (typeof currentY !== 'number') {
			return;
		}

		collapseDeltaYRef.current = currentY - collapseStartYRef.current;
	}, []);

	const handleCollapseSwipeEnd = useCallback(() => {
		if (collapseDeltaYRef.current <= -24) {
			handleCollapse();
		}

		collapseStartYRef.current = null;
		collapseDeltaYRef.current = 0;
	}, [handleCollapse]);

	if (!isExpanded) {
		return (
			<div
				style={{
					position: 'relative',
					display: 'flex',
					justifyContent: 'center',
					alignItems: 'flex-start',
					minHeight: '30px',
					padding: '2px 10px 8px',
				}}
			>
				<button
					type="button"
					onClick={handleExpand}
					onTouchStart={handlePullStart}
					onTouchMove={handlePullMove}
					onTouchEnd={handlePullEnd}
					onTouchCancel={handlePullEnd}
					aria-label="Pull down to open thread controls"
					title="Open thread controls"
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '88px',
						height: '24px',
						borderRadius: '999px',
						border: '1px solid rgba(255, 255, 255, 0.12)',
						background:
							'linear-gradient(180deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.06) 100%)',
						backdropFilter: 'blur(18px)',
						WebkitBackdropFilter: 'blur(18px)',
						boxShadow:
							'0 12px 24px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
						cursor: 'pointer',
						transform: `translateY(${collapsedHandleOffset}px)`,
						transition: pullDistance > 0 ? 'none' : 'transform 180ms ease, box-shadow 180ms ease',
					}}
				>
					<span
						style={{
							width: '28px',
							height: '4px',
							borderRadius: '999px',
							background: `${colors.textDim}88`,
							boxShadow: `0 0 12px ${colors.accent}10`,
						}}
					/>
				</button>
			</div>
		);
	}

	return (
		<div
			onTouchStart={handleCollapseSwipeStart}
			onTouchMove={handleCollapseSwipeMove}
			onTouchEnd={handleCollapseSwipeEnd}
			onTouchCancel={handleCollapseSwipeEnd}
			style={{
				position: 'relative',
				display: 'flex',
				alignItems: 'center',
				gap: '10px',
				padding: '4px 10px 10px',
				background:
					'linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.02) 100%)',
				backdropFilter: 'blur(18px)',
				WebkitBackdropFilter: 'blur(18px)',
				boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '10px',
					flex: 1,
					minHeight: '46px',
					padding: '6px 12px',
					borderRadius: '20px',
					border: '1px solid rgba(255, 255, 255, 0.08)',
					background:
						'linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.04) 100%)',
					backdropFilter: 'blur(18px)',
					WebkitBackdropFilter: 'blur(18px)',
					boxShadow: '0 14px 30px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						minWidth: 0,
						flex: 1,
					}}
				>
					<span
						style={{
							fontSize: '12px',
							fontWeight: 500,
							color: colors.textDim,
						}}
					>
						Thread controls
					</span>
				</div>

				{clampedContextUsage !== null && (
					<div
						title={`Context window ${clampedContextUsage}% used`}
						aria-label={`Context window ${clampedContextUsage}% used`}
						style={{
							marginLeft: 'auto',
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: '28px',
							height: '28px',
							borderRadius: '999px',
							background: `conic-gradient(${contextIndicatorColor} ${clampedContextUsage * 3.6}deg, rgba(15, 23, 42, 0.12) 0deg)`,
							boxShadow: `0 0 16px ${contextIndicatorColor}18`,
							flexShrink: 0,
						}}
					>
						<div
							style={{
								width: '21px',
								height: '21px',
								borderRadius: '999px',
								background:
									'linear-gradient(180deg, rgba(248, 250, 252, 0.95) 0%, rgba(241, 245, 249, 0.92) 100%)',
								border: '1px solid rgba(255, 255, 255, 0.18)',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								color: colors.textDim,
								fontSize: '8px',
								fontWeight: 700,
								lineHeight: 1,
							}}
						>
							{clampedContextUsage}%
						</div>
					</div>
				)}
			</div>

			{canOpenModelMenu && (
				<div
					ref={modelMenuRef}
					style={{
						position: 'relative',
						flexShrink: 0,
					}}
				>
					<ModelSelectorButton
						label={modelLabel}
						toolType={modelToolType}
						onClick={() => void handleToggleModelMenu()}
						disabled={!canOpenModelMenu}
						isOpen={modelMenuOpen}
					/>

					{modelMenuOpen && (
						<div
							style={{
								position: 'absolute',
								right: '0',
								top: 'calc(100% + 10px)',
								width: 'min(320px, calc(100vw - 32px))',
								maxHeight: '320px',
								overflow: 'hidden',
								borderRadius: '18px',
								border: '1px solid rgba(255, 255, 255, 0.18)',
								background:
									'linear-gradient(180deg, rgba(246, 248, 252, 0.94) 0%, rgba(238, 242, 249, 0.92) 100%)',
								backdropFilter: 'blur(24px) saturate(120%)',
								WebkitBackdropFilter: 'blur(24px) saturate(120%)',
								boxShadow:
									'0 18px 36px rgba(15, 23, 42, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.26)',
								padding: '12px',
								display: 'flex',
								flexDirection: 'column',
								gap: '10px',
								zIndex: 40,
							}}
						>
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
									gap: '12px',
								}}
							>
								<div
									style={{
										fontSize: '12px',
										fontWeight: 700,
										color: colors.textMain,
									}}
								>
									Model
								</div>
								<button
									type="button"
									onClick={() => void handleRefreshModels()}
									style={{
										border: 'none',
										background: 'transparent',
										color: colors.accent,
										fontSize: '12px',
										fontWeight: 600,
										cursor: 'pointer',
									}}
								>
									{loadingModels ? 'Loading...' : 'Refresh'}
								</button>
							</div>
							<div
								{...modelMenuScrollGuardProps}
								style={{
									display: 'flex',
									flexDirection: 'column',
									gap: '8px',
									maxHeight: '240px',
									overflowY: 'auto',
									WebkitOverflowScrolling: 'touch',
								}}
							>
								{canChooseProviderModels
									? modelCatalogGroups.map((group) => {
											const isCurrentProvider = group.provider === modelToolType;
											const defaultSelected = isCurrentProvider && !normalizedCurrentModel;

											return (
												<div
													key={group.provider}
													style={{
														display: 'flex',
														flexDirection: 'column',
														gap: '6px',
													}}
												>
													<div
														style={{
															padding: '2px 4px 0',
															fontSize: '11px',
															fontWeight: 700,
															color: colors.textDim,
														}}
													>
														{group.providerLabel}
													</div>
													{group.options.map((option) => {
														const optionModel = normalizeModelLabel(option.modelId);
														const isSelected = option.isDefault
															? defaultSelected
															: isCurrentProvider && optionModel === normalizedCurrentModel;

														return (
															<button
																key={option.id}
																type="button"
																onClick={() =>
																	void handleSelectProviderModelInternal(
																		group.provider,
																		option.modelId || null
																	)
																}
																style={{
																	padding: '11px 12px',
																	borderRadius: '12px',
																	border: '1px solid rgba(255, 255, 255, 0.18)',
																	backgroundColor: isSelected
																		? `${colors.accent}1f`
																		: 'rgba(255, 255, 255, 0.62)',
																	color: isSelected ? colors.accent : colors.textMain,
																	fontSize: '13px',
																	fontWeight: 500,
																	textAlign: 'left',
																	cursor: 'pointer',
																	overflow: 'hidden',
																	textOverflow: 'ellipsis',
																	whiteSpace: 'nowrap',
																}}
															>
																{option.label}
															</button>
														);
													})}
												</div>
											);
										})
									: selectableModels.map((model) => {
											const isSelected = model === modelLabel;
											return (
												<button
													key={model}
													type="button"
													onClick={() => void handleSelectModelInternal(model)}
													style={{
														padding: '11px 12px',
														borderRadius: '12px',
														border: '1px solid rgba(255, 255, 255, 0.18)',
														backgroundColor: isSelected
															? `${colors.accent}1f`
															: 'rgba(255, 255, 255, 0.62)',
														color: isSelected ? colors.accent : colors.textMain,
														fontSize: '13px',
														fontWeight: 500,
														textAlign: 'left',
														cursor: 'pointer',
														overflow: 'hidden',
														textOverflow: 'ellipsis',
														whiteSpace: 'nowrap',
													}}
												>
													{model}
												</button>
											);
										})}
								{!loadingModels &&
									((canChooseProviderModels && modelCatalogGroups.length === 0) ||
										(!canChooseProviderModels && selectableModels.length === 0)) && (
										<div
											style={{
												padding: '11px 12px',
												borderRadius: '12px',
												border: '1px solid rgba(255, 255, 255, 0.18)',
												backgroundColor: 'rgba(255, 255, 255, 0.62)',
												color: colors.textDim,
												fontSize: '13px',
											}}
										>
											No models available
										</div>
									)}
							</div>
						</div>
					)}
				</div>
			)}

			<button
				type="button"
				onClick={onNewThread}
				aria-label="New Thread"
				title="New Thread"
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					width: '42px',
					height: '42px',
					borderRadius: '999px',
					border: '1px solid rgba(255, 255, 255, 0.08)',
					background: `linear-gradient(180deg, ${colors.accent}14 0%, rgba(255, 255, 255, 0.06) 100%)`,
					color: colors.textMain,
					cursor: 'pointer',
					flexShrink: 0,
					boxShadow: '0 10px 22px rgba(15, 23, 42, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
				}}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
				</svg>
			</button>
		</div>
	);
}

export default TabBar;
