import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThemeColors } from '../../shared/theme-types';
import type { Conductor, ConductorRun, ConductorTask } from '../../shared/types';
import type { ConductorOrchestratorUpdate } from '../../shared/conductorUpdates';
import type { MobileTeamMember } from './MobileTeamPanel';
import {
	buildConductorOrchestratorReply,
	getConductorOrchestratorQuickPrompts,
	type ConductorOrchestratorAction,
	type ConductorOrchestratorContext,
	type ConductorOrchestratorReply,
} from '../../shared/conductorOrchestrator';

interface MobileOrchestratorChatProps {
	colors: ThemeColors;
	groupName: string;
	isOpen: boolean;
	context: ConductorOrchestratorContext | null;
	conductor?: Conductor | null;
	tasksById: Map<string, ConductorTask>;
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
	updates: ConductorOrchestratorUpdate[];
	teamMembers: MobileTeamMember[];
	onOpenTask: (taskId: string) => void;
	onApplyAction: (action: ConductorOrchestratorAction) => void;
	onClose: () => void;
}

interface ConversationMessage {
	id: string;
	role: 'orchestrator' | 'user';
	text: string;
	reply?: ConductorOrchestratorReply;
}

function buildContextLabel(
	context: ConductorOrchestratorContext | null,
	input: {
		tasksById: Map<string, ConductorTask>;
		updates: ConductorOrchestratorUpdate[];
		teamMembers: MobileTeamMember[];
	}
): string | null {
	if (!context) return null;
	switch (context.scope) {
		case 'task':
			return input.tasksById.get(context.taskId)?.title || 'Task';
		case 'update':
			return input.updates.find((update) => update.id === context.updateId)?.summary || 'Update';
		case 'member': {
			const member = input.teamMembers.find((item) => item.name === context.memberName);
			return member ? `${member.emoji} ${member.name}` : context.memberName;
		}
		case 'board':
		default:
			return 'Board overview';
	}
}

export function MobileOrchestratorChat({
	colors,
	groupName,
	isOpen,
	context,
	conductor,
	tasksById,
	childTasksByParentId,
	runs,
	updates,
	teamMembers,
	onOpenTask,
	onApplyAction,
	onClose,
}: MobileOrchestratorChatProps): JSX.Element | null {
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const [draft, setDraft] = useState('');
	const [messages, setMessages] = useState<ConversationMessage[]>([]);

	const teamSnapshots = useMemo(
		() =>
			teamMembers.map((member) => ({
				name: member.name,
				emoji: member.emoji,
				status: member.status,
				parentTaskId: member.parentTaskId,
				parentTaskTitle: member.parentTaskTitle,
				threadCount: member.threadTargets.length,
			})),
		[teamMembers]
	);

	const contextLabel = useMemo(
		() => buildContextLabel(context, { tasksById, updates, teamMembers }),
		[context, tasksById, updates, teamMembers]
	);

	const quickPrompts = useMemo(
		() => getConductorOrchestratorQuickPrompts(context || { scope: 'board' }),
		[context]
	);

	useEffect(() => {
		if (!isOpen || !context) return;

		const initialReply = buildConductorOrchestratorReply({
			groupName,
			context,
			conductor,
			tasksById,
			childTasksByParentId,
			runs,
			updates,
			team: teamSnapshots,
		});

		setMessages([
			{
				id: `orchestrator-initial-${Date.now()}`,
				role: 'orchestrator',
				text: initialReply.body,
				reply: initialReply,
			},
		]);
		setDraft('');

		requestAnimationFrame(() => {
			inputRef.current?.focus();
		});
	}, [
		isOpen,
		context,
		groupName,
		conductor,
		tasksById,
		childTasksByParentId,
		runs,
		updates,
		teamSnapshots,
	]);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages]);

	if (!isOpen || !context) return null;

	const handleAsk = (question: string) => {
		const trimmed = question.trim();
		if (!trimmed) return;

		const reply = buildConductorOrchestratorReply({
			groupName,
			context,
			question: trimmed,
			conductor,
			tasksById,
			childTasksByParentId,
			runs,
			updates,
			team: teamSnapshots,
		});

		setMessages((prev) => [
			...prev,
			{
				id: `user-${Date.now()}`,
				role: 'user',
				text: trimmed,
			},
			{
				id: `reply-${Date.now() + 1}`,
				role: 'orchestrator',
				text: reply.body,
				reply,
			},
		]);
		setDraft('');
	};

	const handleAction = (action: ConductorOrchestratorAction) => {
		if (action.type === 'open_task') {
			onOpenTask(action.taskId);
			onClose();
			return;
		}
		if (action.type === 'open_member') {
			onClose();
			return;
		}
		onApplyAction(action);
	};

	return (
		<div
			role="button"
			tabIndex={-1}
			onClick={onClose}
			onKeyDown={(e) => {
				if (e.key === 'Escape') onClose();
			}}
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 165,
				background: 'rgba(2, 8, 23, 0.5)',
				display: 'flex',
				alignItems: 'flex-end',
				justifyContent: 'center',
			}}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				style={{
					width: 'min(100vw, 520px)',
					maxHeight: '92vh',
					display: 'flex',
					flexDirection: 'column',
					borderTopLeftRadius: '26px',
					borderTopRightRadius: '26px',
					backgroundColor: colors.bgMain,
					background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
					borderTop: '1px solid rgba(255,255,255,0.08)',
					overflow: 'hidden',
				}}
			>
				{/* Header */}
				<div
					style={{
						padding: '16px 16px 12px',
						borderBottom: '1px solid rgba(255,255,255,0.06)',
						backgroundColor: 'rgba(255,255,255,0.03)',
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
						<div style={{ minWidth: 0 }}>
							<div
								style={{
									fontSize: '14px',
									fontWeight: 700,
									color: colors.textMain,
								}}
							>
								Ask Orchestrator
							</div>
							<div
								style={{
									fontSize: '11px',
									marginTop: '3px',
									color: colors.textDim,
									lineHeight: 1.4,
								}}
							>
								What is moving, what is blocked, and what needs you.
							</div>
						</div>
						<button
							type="button"
							onClick={onClose}
							style={{
								padding: '8px',
								borderRadius: '10px',
								background: 'rgba(255,255,255,0.08)',
								border: '1px solid rgba(255,255,255,0.08)',
								color: colors.textDim,
								cursor: 'pointer',
								fontSize: '14px',
								lineHeight: 1,
								flexShrink: 0,
							}}
						>
							✕
						</button>
					</div>

					{/* Context pills */}
					<div
						style={{
							display: 'flex',
							flexWrap: 'wrap',
							gap: '6px',
							marginTop: '10px',
						}}
					>
						<span
							style={{
								padding: '4px 10px',
								borderRadius: '999px',
								fontSize: '11px',
								fontWeight: 600,
								color: colors.accent,
								border: `1px solid ${colors.accent}26`,
								backgroundColor: `${colors.accent}12`,
							}}
						>
							{groupName}
						</span>
						{contextLabel && (
							<span
								style={{
									padding: '4px 10px',
									borderRadius: '999px',
									fontSize: '11px',
									fontWeight: 600,
									color: colors.textMain,
									border: '1px solid rgba(255,255,255,0.08)',
									backgroundColor: 'rgba(255,255,255,0.04)',
								}}
							>
								{contextLabel}
							</span>
						)}
					</div>
				</div>

				{/* Quick prompts */}
				<div
					style={{
						padding: '10px 16px',
						borderBottom: '1px solid rgba(255,255,255,0.06)',
					}}
				>
					<div
						style={{
							fontSize: '10px',
							textTransform: 'uppercase',
							letterSpacing: '0.06em',
							fontWeight: 700,
							color: colors.textDim,
							marginBottom: '8px',
						}}
					>
						Quick asks
					</div>
					<div
						style={{
							display: 'flex',
							flexWrap: 'wrap',
							gap: '6px',
						}}
					>
						{quickPrompts.map((prompt) => (
							<button
								key={prompt}
								type="button"
								onClick={() => handleAsk(prompt)}
								style={{
									padding: '6px 12px',
									borderRadius: '999px',
									fontSize: '12px',
									border: '1px solid rgba(255,255,255,0.08)',
									backgroundColor: 'rgba(255,255,255,0.03)',
									color: colors.textMain,
									cursor: 'pointer',
								}}
							>
								{prompt}
							</button>
						))}
					</div>
				</div>

				{/* Messages */}
				<div
					style={{
						flex: 1,
						minHeight: 0,
						overflowY: 'auto',
						WebkitOverflowScrolling: 'touch',
						padding: '14px 16px',
						display: 'flex',
						flexDirection: 'column',
						gap: '12px',
					}}
				>
					{messages.map((message) =>
						message.role === 'user' ? (
							<div
								key={message.id}
								style={{
									alignSelf: 'flex-end',
									maxWidth: '88%',
									borderRadius: '18px',
									padding: '10px 14px',
									backgroundColor: `${colors.accent}14`,
									border: `1px solid ${colors.accent}20`,
								}}
							>
								<div
									style={{
										fontSize: '10px',
										fontWeight: 600,
										color: colors.accent,
										marginBottom: '4px',
									}}
								>
									You
								</div>
								<div
									style={{
										fontSize: '13px',
										lineHeight: 1.5,
										color: colors.textMain,
									}}
								>
									{message.text}
								</div>
							</div>
						) : (
							<div
								key={message.id}
								style={{
									alignSelf: 'flex-start',
									maxWidth: '92%',
									borderRadius: '18px',
									padding: '12px 14px',
									border: '1px solid rgba(255,255,255,0.08)',
									backgroundColor: 'rgba(255,255,255,0.03)',
								}}
							>
								<div
									style={{
										fontSize: '10px',
										fontWeight: 700,
										textTransform: 'uppercase',
										letterSpacing: '0.05em',
										color: colors.textDim,
										marginBottom: '6px',
									}}
								>
									Orchestrator
								</div>

								{message.reply?.title && (
									<div
										style={{
											fontSize: '13px',
											fontWeight: 700,
											color: colors.textMain,
											marginBottom: '4px',
										}}
									>
										{message.reply.title}
									</div>
								)}

								<div
									style={{
										fontSize: '13px',
										lineHeight: 1.5,
										color: colors.textMain,
									}}
								>
									{message.text}
								</div>

								{message.reply?.bullets && message.reply.bullets.length > 0 && (
									<div
										style={{
											marginTop: '10px',
											display: 'flex',
											flexDirection: 'column',
											gap: '6px',
										}}
									>
										{message.reply.bullets.map((bullet, idx) => (
											<div
												key={`${message.id}-bullet-${idx}`}
												style={{
													display: 'flex',
													alignItems: 'flex-start',
													gap: '6px',
													fontSize: '12px',
													lineHeight: 1.4,
													color: colors.textDim,
												}}
											>
												<span
													style={{
														color: colors.accent,
														flexShrink: 0,
														marginTop: '1px',
													}}
												>
													*
												</span>
												<span>{bullet}</span>
											</div>
										))}
									</div>
								)}

								{message.reply?.actions && message.reply.actions.length > 0 && (
									<div
										style={{
											marginTop: '10px',
											display: 'flex',
											flexWrap: 'wrap',
											gap: '6px',
										}}
									>
										{message.reply.actions.map((action, idx) => {
											const isAccent =
												action.type === 'pause_board' ||
												action.type === 'resume_board' ||
												action.type === 'prioritize_task';
											return (
												<button
													key={`${message.id}-action-${action.type}-${idx}`}
													type="button"
													onClick={() => handleAction(action)}
													style={{
														padding: '6px 12px',
														borderRadius: '999px',
														fontSize: '12px',
														fontWeight: 600,
														border: `1px solid ${isAccent ? `${colors.accent}24` : 'rgba(255,255,255,0.08)'}`,
														backgroundColor: isAccent
															? `${colors.accent}12`
															: 'rgba(255,255,255,0.03)',
														color: isAccent ? colors.accent : colors.textMain,
														cursor: 'pointer',
													}}
												>
													{action.label}
												</button>
											);
										})}
									</div>
								)}
							</div>
						)
					)}
					<div ref={messagesEndRef} />
				</div>

				{/* Input */}
				<div
					style={{
						padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
						borderTop: '1px solid rgba(255,255,255,0.06)',
						backgroundColor: 'rgba(255,255,255,0.02)',
					}}
				>
					<div
						style={{
							fontSize: '10px',
							textTransform: 'uppercase',
							letterSpacing: '0.06em',
							fontWeight: 700,
							color: colors.textDim,
							marginBottom: '8px',
						}}
					>
						Message orchestrator
					</div>
					<div
						style={{
							display: 'flex',
							alignItems: 'flex-end',
							gap: '8px',
						}}
					>
						<textarea
							ref={inputRef}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault();
									handleAsk(draft);
								}
							}}
							rows={2}
							placeholder="Ask why something is blocked, what changed, or what needs you."
							style={{
								flex: 1,
								borderRadius: '14px',
								border: '1px solid rgba(255,255,255,0.08)',
								padding: '10px 12px',
								fontSize: '13px',
								color: colors.textMain,
								backgroundColor: 'rgba(255,255,255,0.04)',
								resize: 'none',
								fontFamily: 'inherit',
								lineHeight: 1.5,
								outline: 'none',
							}}
						/>
						<button
							type="button"
							onClick={() => handleAsk(draft)}
							disabled={!draft.trim()}
							style={{
								padding: '10px 16px',
								borderRadius: '14px',
								backgroundColor: colors.accent,
								color: '#fff',
								border: 'none',
								fontSize: '13px',
								fontWeight: 700,
								cursor: draft.trim() ? 'pointer' : 'default',
								opacity: draft.trim() ? 1 : 0.4,
								flexShrink: 0,
							}}
						>
							Ask
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
