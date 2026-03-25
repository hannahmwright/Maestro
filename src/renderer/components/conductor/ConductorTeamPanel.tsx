import { useState } from 'react';
import { AlertTriangle, ArrowUpRight, Loader2, MessageSquarePlus, PauseCircle } from 'lucide-react';

import type { Theme } from '../../types';

export interface ConductorTeamThreadTarget {
	sessionId: string;
	tabId?: string;
	label: string;
}

export interface ConductorTeamMember {
	sessionId: string;
	name: string;
	emoji: string;
	providerLabel: string;
	status: 'working' | 'idle' | 'waiting' | 'error';
	parentTaskId?: string;
	parentTaskTitle?: string;
	threadTargets: ConductorTeamThreadTarget[];
	lastActiveAt: number;
}

interface ConductorTeamPanelProps {
	theme: Theme;
	members: ConductorTeamMember[];
	onOpenMember: (member: ConductorTeamMember) => void;
	onOpenTask: (taskId: string) => void;
	onAskMember: (member: ConductorTeamMember) => void;
}

type TeamFilter = 'active' | 'all';

function isActiveMember(member: ConductorTeamMember): boolean {
	return member.status === 'working' || member.status === 'waiting' || member.status === 'error';
}

function getStatusMeta(
	theme: Theme,
	status: ConductorTeamMember['status']
): {
	label: string;
	color: string;
	icon: JSX.Element;
} {
	switch (status) {
		case 'working':
			return {
				label: 'Working',
				color: theme.colors.accent,
				icon: <Loader2 className="w-3 h-3 animate-spin" />,
			};
		case 'waiting':
			return {
				label: 'Waiting',
				color: theme.colors.warning,
				icon: <PauseCircle className="w-3 h-3" />,
			};
		case 'error':
			return {
				label: 'Attention',
				color: theme.colors.error,
				icon: <AlertTriangle className="w-3 h-3" />,
			};
		case 'idle':
		default:
			return {
				label: 'Idle',
				color: theme.colors.success,
				icon: <span className="w-2 h-2 rounded-full" style={{ backgroundColor: theme.colors.success }} />,
			};
	}
}

export function ConductorTeamPanel({
	theme,
	members,
	onOpenMember,
	onOpenTask,
	onAskMember,
}: ConductorTeamPanelProps): JSX.Element {
	const [filter, setFilter] = useState<TeamFilter>('active');

	const activeCount = members.filter(isActiveMember).length;
	const visibleMembers = filter === 'active' ? members.filter(isActiveMember) : members;

	return (
		<div
			className="rounded-xl overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				border: '1px solid rgba(255,255,255,0.08)',
			}}
		>
			{/* Tab bar */}
			<div
				className="flex"
				style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}
			>
				{(['active', 'all'] as const).map((tab) => {
					const isSelected = filter === tab;
					const label = tab === 'active' ? `Active (${activeCount})` : `All (${members.length})`;
					return (
						<button
							key={tab}
							type="button"
							onClick={() => setFilter(tab)}
							className="flex-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-center transition-colors relative"
							style={{
								color: isSelected ? theme.colors.textMain : theme.colors.textDim,
							}}
						>
							{label}
							{isSelected && (
								<span
									className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full"
									style={{ backgroundColor: theme.colors.accent }}
								/>
							)}
						</button>
					);
				})}
			</div>

			{/* Member list */}
			{visibleMembers.length > 0 ? (
				<div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
					{visibleMembers.map((member) => {
						const statusMeta = getStatusMeta(theme, member.status);
						return (
							<button
								key={member.sessionId}
								type="button"
								onClick={() => onOpenMember(member)}
								className="w-full px-3 py-2 text-left transition-colors hover:bg-white/[0.03]"
							>
								<div className="flex items-center gap-2 min-w-0">
									<span className="text-sm leading-none shrink-0" aria-hidden="true">
										{member.emoji}
									</span>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-1.5">
											<span className="text-xs font-medium truncate" style={{ color: theme.colors.textMain }}>
												{member.name}
											</span>
											<span
												className="inline-flex items-center gap-1 text-[10px] shrink-0"
												style={{ color: statusMeta.color }}
											>
												{statusMeta.icon}
												{statusMeta.label}
											</span>
										</div>
										{member.parentTaskTitle && (
											<div
												className="text-[11px] mt-0.5 truncate"
												style={{ color: theme.colors.textDim }}
											>
												{member.parentTaskTitle}
											</div>
										)}
									</div>
									<div className="flex items-center gap-0.5 shrink-0">
										<button
											type="button"
											onClick={(event) => {
												event.stopPropagation();
												onAskMember(member);
											}}
											className="p-1 rounded-md hover:bg-white/5"
											style={{ color: theme.colors.textDim }}
											aria-label={`Ask about ${member.name}`}
										>
											<MessageSquarePlus className="w-3 h-3" />
										</button>
										{member.parentTaskId && (
											<button
												type="button"
												onClick={(event) => {
													event.stopPropagation();
													onOpenTask(member.parentTaskId!);
												}}
												className="p-1 rounded-md hover:bg-white/5"
												style={{ color: theme.colors.textDim }}
												aria-label="Open task"
											>
												<ArrowUpRight className="w-3 h-3" />
											</button>
										)}
									</div>
								</div>
							</button>
						);
					})}
				</div>
			) : (
				<div className="px-3 py-3 text-xs" style={{ color: theme.colors.textDim }}>
					{filter === 'active' ? 'No active agents right now.' : 'No helper agents yet.'}
				</div>
			)}
		</div>
	);
}
