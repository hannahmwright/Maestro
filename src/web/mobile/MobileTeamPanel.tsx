import { useState } from 'react';
import type { ThemeColors } from '../../shared/theme-types';

export interface MobileTeamThreadTarget {
	sessionId: string;
	tabId?: string;
	label: string;
}

export interface MobileTeamMember {
	sessionId: string;
	name: string;
	emoji: string;
	providerLabel: string;
	status: 'working' | 'idle' | 'waiting' | 'error';
	parentTaskId?: string;
	parentTaskTitle?: string;
	threadTargets: MobileTeamThreadTarget[];
	lastActiveAt: number;
}

interface MobileTeamPanelProps {
	colors: ThemeColors;
	members: MobileTeamMember[];
	onOpenMember: (member: MobileTeamMember) => void;
	onOpenTask: (taskId: string) => void;
	onAskMember: (member: MobileTeamMember) => void;
}

type TeamFilter = 'active' | 'all';

function isActiveMember(member: MobileTeamMember): boolean {
	return member.status === 'working' || member.status === 'waiting' || member.status === 'error';
}

function getStatusLabel(status: MobileTeamMember['status']): string {
	switch (status) {
		case 'working':
			return 'Working';
		case 'waiting':
			return 'Waiting';
		case 'error':
			return 'Attention';
		case 'idle':
		default:
			return 'Idle';
	}
}

function getStatusColor(colors: ThemeColors, status: MobileTeamMember['status']): string {
	switch (status) {
		case 'working':
			return colors.accent;
		case 'waiting':
			return colors.warning;
		case 'error':
			return colors.error;
		case 'idle':
		default:
			return colors.success;
	}
}

export function MobileTeamPanel({
	colors,
	members,
	onOpenMember,
	onOpenTask,
	onAskMember,
}: MobileTeamPanelProps): JSX.Element {
	const [filter, setFilter] = useState<TeamFilter>('active');

	const activeCount = members.filter(isActiveMember).length;
	const visibleMembers = filter === 'active' ? members.filter(isActiveMember) : members;

	return (
		<div
			style={{
				borderRadius: '14px',
				overflow: 'hidden',
				backgroundColor: colors.bgSidebar,
				border: '1px solid rgba(255,255,255,0.08)',
			}}
		>
			{/* Tab bar */}
			<div
				style={{
					display: 'flex',
					backgroundColor: 'rgba(255,255,255,0.03)',
				}}
			>
				{(['active', 'all'] as const).map((tab) => {
					const isSelected = filter === tab;
					const label = tab === 'active' ? `Active (${activeCount})` : `All (${members.length})`;
					return (
						<button
							key={tab}
							type="button"
							onClick={() => setFilter(tab)}
							style={{
								flex: 1,
								padding: '10px 12px',
								fontSize: '11px',
								fontWeight: 700,
								textTransform: 'uppercase',
								letterSpacing: '0.06em',
								textAlign: 'center',
								background: 'transparent',
								border: 'none',
								borderBottom: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent',
								color: isSelected ? colors.textMain : colors.textDim,
								cursor: 'pointer',
								position: 'relative',
							}}
						>
							{label}
						</button>
					);
				})}
			</div>

			{/* Member list */}
			{visibleMembers.length > 0 ? (
				<div>
					{visibleMembers.map((member, index) => {
						const statusColor = getStatusColor(colors, member.status);
						return (
							<button
								key={member.sessionId}
								type="button"
								onClick={() => onOpenMember(member)}
								style={{
									width: '100%',
									padding: '12px 14px',
									textAlign: 'left',
									background: 'transparent',
									border: 'none',
									borderTop: index > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none',
									cursor: 'pointer',
									display: 'flex',
									alignItems: 'center',
									gap: '10px',
								}}
							>
								<span
									style={{
										fontSize: '16px',
										flexShrink: 0,
										lineHeight: 1,
									}}
									aria-hidden="true"
								>
									{member.emoji}
								</span>
								<div style={{ minWidth: 0, flex: 1 }}>
									<div
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: '6px',
										}}
									>
										<span
											style={{
												fontSize: '13px',
												fontWeight: 600,
												color: colors.textMain,
												overflow: 'hidden',
												textOverflow: 'ellipsis',
												whiteSpace: 'nowrap',
											}}
										>
											{member.name}
										</span>
										<span
											style={{
												display: 'inline-flex',
												alignItems: 'center',
												gap: '4px',
												fontSize: '11px',
												color: statusColor,
												flexShrink: 0,
											}}
										>
											<span
												style={{
													width: '6px',
													height: '6px',
													borderRadius: '50%',
													backgroundColor: statusColor,
													display: 'inline-block',
													animation:
														member.status === 'working'
															? 'pulse 1.5s ease-in-out infinite'
															: 'none',
												}}
											/>
											{getStatusLabel(member.status)}
										</span>
									</div>
									{member.parentTaskTitle && (
										<div
											style={{
												fontSize: '11px',
												marginTop: '3px',
												color: colors.textDim,
												overflow: 'hidden',
												textOverflow: 'ellipsis',
												whiteSpace: 'nowrap',
											}}
										>
											{member.parentTaskTitle}
										</div>
									)}
								</div>
								<div
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: '4px',
										flexShrink: 0,
									}}
								>
									<button
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											onAskMember(member);
										}}
										style={{
											padding: '6px',
											borderRadius: '8px',
											background: 'rgba(255,255,255,0.05)',
											border: 'none',
											color: colors.textDim,
											cursor: 'pointer',
											fontSize: '11px',
											fontWeight: 600,
										}}
										aria-label={`Ask about ${member.name}`}
									>
										Ask
									</button>
									{member.parentTaskId && (
										<button
											type="button"
											onClick={(event) => {
												event.stopPropagation();
												onOpenTask(member.parentTaskId!);
											}}
											style={{
												padding: '6px',
												borderRadius: '8px',
												background: 'rgba(255,255,255,0.05)',
												border: 'none',
												color: colors.textDim,
												cursor: 'pointer',
												fontSize: '11px',
												fontWeight: 600,
											}}
											aria-label="Open task"
										>
											Task
										</button>
									)}
								</div>
							</button>
						);
					})}
				</div>
			) : (
				<div
					style={{
						padding: '16px 14px',
						fontSize: '12px',
						color: colors.textDim,
					}}
				>
					{filter === 'active' ? 'No active agents right now.' : 'No helper agents yet.'}
				</div>
			)}
		</div>
	);
}
