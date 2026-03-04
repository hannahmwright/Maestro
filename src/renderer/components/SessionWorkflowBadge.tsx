import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GitMerge, GitBranchPlus, PenLine, Lightbulb } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useHoverTooltip } from '../hooks';
import type { Theme } from '../types';
import type { HandoffWorkflowState } from '../utils/handoffWorkflow';

interface SessionWorkflowBadgeProps {
	state: HandoffWorkflowState;
	theme: Theme;
	branchName?: string | null;
}

interface WorkflowVisualConfig {
	label: string;
	title: string;
	description: string;
	color: string;
	bgColor: string;
	borderColor: string;
	icon: LucideIcon;
}

const WORKFLOW_VISUALS: Record<HandoffWorkflowState, WorkflowVisualConfig> = {
	LOCAL_PLAN: {
		label: 'Plan',
		title: 'Planning only',
		description:
			'This session is in read-only planning mode. It can analyze and propose next steps without changing files.',
		color: '#3B82F6',
		bgColor: 'rgba(59, 130, 246, 0.14)',
		borderColor: 'rgba(59, 130, 246, 0.35)',
		icon: Lightbulb,
	},
	LOCAL_EXEC: {
		label: 'Local Exec',
		title: 'Local execution',
		description:
			'This session is actively implementing in your current checkout. Use this for a single task lane.',
		color: '#10B981',
		bgColor: 'rgba(16, 185, 129, 0.14)',
		borderColor: 'rgba(16, 185, 129, 0.35)',
		icon: PenLine,
	},
	WORKTREE_EXEC: {
		label: 'Worktree',
		title: 'Isolated execution',
		description:
			'This session runs in its own worktree and branch, so parallel tasks stay isolated and easier to merge.',
		color: '#F59E0B',
		bgColor: 'rgba(245, 158, 11, 0.14)',
		borderColor: 'rgba(245, 158, 11, 0.35)',
		icon: GitBranchPlus,
	},
	INTEGRATION: {
		label: 'Integration',
		title: 'Integration lane',
		description:
			'This session is combining completed task branches, resolving conflicts, and validating before final merge.',
		color: '#EC4899',
		bgColor: 'rgba(236, 72, 153, 0.14)',
		borderColor: 'rgba(236, 72, 153, 0.35)',
		icon: GitMerge,
	},
};

export function SessionWorkflowBadge({
	state,
	theme,
	branchName,
}: SessionWorkflowBadgeProps): JSX.Element {
	const tooltip = useHoverTooltip(180);
	const config = useMemo(() => WORKFLOW_VISUALS[state], [state]);
	const Icon = config.icon;
	const anchorRef = useRef<HTMLDivElement | null>(null);
	const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number } | null>(
		null
	);

	useEffect(() => {
		if (!tooltip.isOpen) {
			setPopoverPosition(null);
			return;
		}

		const updatePosition = () => {
			const rect = anchorRef.current?.getBoundingClientRect();
			if (!rect) return;
			const popoverWidth = 320;
			const margin = 12;
			const maxLeft = Math.max(margin, window.innerWidth - popoverWidth - margin);
			const left = Math.min(Math.max(rect.left, margin), maxLeft);
			const top = rect.bottom + 8;
			setPopoverPosition({ top, left });
		};

		updatePosition();
		window.addEventListener('resize', updatePosition);
		window.addEventListener('scroll', updatePosition, true);
		return () => {
			window.removeEventListener('resize', updatePosition);
			window.removeEventListener('scroll', updatePosition, true);
		};
	}, [tooltip.isOpen]);

	return (
		<div
			ref={anchorRef}
			className="relative shrink-0"
			{...tooltip.triggerHandlers}
			data-testid="workflow-state-container"
		>
			<div
				className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border cursor-help"
				style={{
					color: config.color,
					backgroundColor: config.bgColor,
					borderColor: config.borderColor,
				}}
				data-testid="workflow-state-badge"
			>
				<Icon className="w-3 h-3 shrink-0" />
				<span className="font-semibold">{config.label}</span>
			</div>

			{tooltip.isOpen &&
				popoverPosition &&
				createPortal(
					<div
						className="fixed w-80 z-[120] pointer-events-auto"
						style={{ top: popoverPosition.top, left: popoverPosition.left }}
						{...tooltip.contentHandlers}
						data-testid="workflow-state-popover"
					>
						<div
							className="border rounded-xl p-3 shadow-xl"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
							}}
						>
							<div className="flex items-start gap-2">
								<div
									className="mt-0.5 p-1.5 rounded-lg shrink-0"
									style={{ backgroundColor: config.bgColor }}
								>
									<Icon className="w-3.5 h-3.5" style={{ color: config.color }} />
								</div>
								<div className="min-w-0">
									<div
										className="text-[10px] uppercase font-bold tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										Session Workflow
									</div>
									<div
										className="text-sm font-semibold mt-0.5"
										style={{ color: theme.colors.textMain }}
									>
										{config.title}
									</div>
									<p
										className="text-xs mt-1 leading-relaxed"
										style={{ color: theme.colors.textDim }}
									>
										{config.description}
									</p>
									<p className="text-[11px] mt-2" style={{ color: theme.colors.textDim }}>
										This status is session-specific.
									</p>
									{branchName && (
										<div
											className="mt-2 px-2 py-1 rounded text-[11px] font-mono truncate"
											style={{
												color: theme.colors.textMain,
												backgroundColor: theme.colors.bgMain,
												border: `1px solid ${theme.colors.border}`,
											}}
											title={branchName}
										>
											Branch: {branchName}
										</div>
									)}
								</div>
							</div>
						</div>
					</div>,
					document.body
				)}
		</div>
	);
}
