import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bot, MessageSquarePlus, Send, Sparkles, User, X } from 'lucide-react';

import type { Theme, Conductor, ConductorRun, ConductorTask } from '../../types';
import type { ConductorTeamMember } from './ConductorTeamPanel';
import type { ConductorOrchestratorUpdate } from '../../../shared/conductorUpdates';
import {
	buildConductorOrchestratorReply,
	getConductorOrchestratorQuickPrompts,
	type ConductorOrchestratorAction,
	type ConductorOrchestratorContext,
	type ConductorOrchestratorReply,
} from '../../../shared/conductorOrchestrator';

interface ConductorOrchestratorPanelProps {
	theme: Theme;
	groupName: string;
	isOpen: boolean;
	context: ConductorOrchestratorContext | null;
	conductor?: Conductor | null;
	tasksById: Map<string, ConductorTask>;
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
	updates: ConductorOrchestratorUpdate[];
	teamMembers: ConductorTeamMember[];
	onOpenTask: (taskId: string) => void;
	onOpenMember: (memberName: string) => void;
	onApplyAction: (action: ConductorOrchestratorAction) => void;
	onClose: () => void;
}

interface OrchestratorConversationMessage {
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
		teamMembers: ConductorTeamMember[];
	}
): string | null {
	if (!context) {
		return null;
	}

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

export function ConductorOrchestratorPanel({
	theme,
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
	onOpenMember,
	onApplyAction,
	onClose,
}: ConductorOrchestratorPanelProps): JSX.Element | null {
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [draft, setDraft] = useState('');
	const [messages, setMessages] = useState<OrchestratorConversationMessage[]>([]);

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
		if (!isOpen || !context) {
			return;
		}

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

	if (!isOpen || !context) {
		return null;
	}

	const handleAsk = (question: string) => {
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			return;
		}

		const reply = buildConductorOrchestratorReply({
			groupName,
			context,
			question: trimmedQuestion,
			conductor,
			tasksById,
			childTasksByParentId,
			runs,
			updates,
			team: teamSnapshots,
		});

		setMessages((previous) => [
			...previous,
			{
				id: `orchestrator-user-${Date.now()}`,
				role: 'user',
				text: trimmedQuestion,
			},
			{
				id: `orchestrator-reply-${Date.now() + 1}`,
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
			onOpenMember(action.memberName);
			onClose();
			return;
		}
		onApplyAction(action);
	};

	return (
		<div
			className="h-full w-[540px] shrink-0 border-l shadow-2xl flex flex-col"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: 'rgba(255,255,255,0.08)',
			}}
		>
			<div
				className="px-5 py-4 border-b"
				style={{
					borderColor: 'rgba(255,255,255,0.06)',
					backgroundColor: 'rgba(255,255,255,0.03)',
				}}
			>
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<MessageSquarePlus className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
								Ask Orchestrator
							</div>
						</div>
						<div className="text-xs mt-1 leading-5" style={{ color: theme.colors.textDim }}>
							Manager-facing answers about what is moving, what is blocked, and what needs you.
						</div>
					</div>
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onClose();
						}}
						className="p-1.5 rounded-lg hover:bg-white/5"
						style={{ color: theme.colors.textDim }}
					>
						<X className="w-4 h-4" />
					</button>
				</div>

				<div className="mt-3 flex flex-wrap items-center gap-2">
					<span
						className="px-2.5 py-1 rounded-full text-[11px] border"
						style={{
							color: theme.colors.accent,
							borderColor: `${theme.colors.accent}26`,
							backgroundColor: `${theme.colors.accent}12`,
						}}
					>
						{groupName}
					</span>
					{contextLabel && (
						<span
							className="px-2.5 py-1 rounded-full text-[11px] border"
							style={{
								color: theme.colors.textMain,
								borderColor: 'rgba(255,255,255,0.08)',
								backgroundColor: 'rgba(255,255,255,0.04)',
							}}
						>
							{contextLabel}
						</span>
					)}
				</div>
			</div>

			<div className="px-5 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
				<div
					className="text-[11px] uppercase tracking-wider mb-2"
					style={{ color: theme.colors.textDim }}
				>
					Quick asks
				</div>
				<div className="flex flex-wrap gap-2">
					{quickPrompts.map((prompt) => (
						<button
							key={prompt}
							type="button"
							onClick={() => handleAsk(prompt)}
							className="px-2.5 py-1.5 rounded-full text-xs border hover:bg-white/5"
							style={{
								color: theme.colors.textMain,
								borderColor: 'rgba(255,255,255,0.08)',
								backgroundColor: 'rgba(255,255,255,0.03)',
							}}
						>
							{prompt}
						</button>
					))}
				</div>
			</div>

			<div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 scrollbar-thin">
				{messages.map((message) =>
					message.role === 'user' ? (
						<div key={message.id} className="flex justify-end">
							<div
								className="max-w-[88%] rounded-2xl px-4 py-3"
								style={{
									backgroundColor: `${theme.colors.accent}14`,
									border: `1px solid ${theme.colors.accent}20`,
								}}
							>
								<div className="flex items-center gap-2 mb-1">
									<User className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span className="text-[11px] font-medium" style={{ color: theme.colors.accent }}>
										You
									</span>
								</div>
								<div className="text-sm leading-6" style={{ color: theme.colors.textMain }}>
									{message.text}
								</div>
							</div>
						</div>
					) : (
						<div key={message.id} className="flex justify-start">
							<div
								className="w-full max-w-[92%] rounded-2xl border px-4 py-4"
								style={{
									backgroundColor: 'rgba(255,255,255,0.03)',
									borderColor: 'rgba(255,255,255,0.08)',
								}}
							>
								<div className="flex items-center gap-2 mb-2">
									<Bot className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<span
										className="text-[11px] font-medium uppercase tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										Orchestrator
									</span>
								</div>

								{message.reply?.title && (
									<div
										className="text-sm font-semibold mb-1"
										style={{ color: theme.colors.textMain }}
									>
										{message.reply.title}
									</div>
								)}

								<div className="text-sm leading-6" style={{ color: theme.colors.textMain }}>
									{message.text}
								</div>

								{message.reply?.bullets && message.reply.bullets.length > 0 && (
									<div className="mt-3 space-y-2">
										{message.reply.bullets.map((bullet, index) => (
											<div
												key={`${message.id}-bullet-${index}`}
												className="flex items-start gap-2 text-xs leading-5"
												style={{ color: theme.colors.textDim }}
											>
												<Sparkles
													className="w-3.5 h-3.5 mt-0.5 shrink-0"
													style={{ color: theme.colors.accent }}
												/>
												<span>{bullet}</span>
											</div>
										))}
									</div>
								)}

								{message.reply?.actions && message.reply.actions.length > 0 && (
									<div className="mt-3 flex flex-wrap items-center gap-2">
										{message.reply?.actions?.map((action, index) => (
											<button
												key={`${message.id}-action-${action.type}-${index}`}
												type="button"
												onClick={() => handleAction(action)}
												className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium hover:bg-white/5"
												style={{
													color:
														action.type === 'pause_board' ||
														action.type === 'resume_board' ||
														action.type === 'prioritize_task'
															? theme.colors.accent
															: theme.colors.textMain,
													borderColor:
														action.type === 'pause_board' ||
														action.type === 'resume_board' ||
														action.type === 'prioritize_task'
															? `${theme.colors.accent}24`
															: 'rgba(255,255,255,0.08)',
													backgroundColor:
														action.type === 'pause_board' ||
														action.type === 'resume_board' ||
														action.type === 'prioritize_task'
															? `${theme.colors.accent}12`
															: 'rgba(255,255,255,0.03)',
												}}
											>
												<span>{action.label}</span>
												{(action.type === 'open_task' || action.type === 'open_member') && (
													<ArrowUpRight className="w-3.5 h-3.5" />
												)}
											</button>
										))}
									</div>
								)}
							</div>
						</div>
					)
				)}
			</div>

			<div
				className="px-5 py-4 border-t"
				style={{
					borderColor: 'rgba(255,255,255,0.06)',
					backgroundColor: 'rgba(255,255,255,0.02)',
				}}
			>
				<div
					className="text-[11px] uppercase tracking-wider mb-2"
					style={{ color: theme.colors.textDim }}
				>
					Message orchestrator
				</div>
				<div className="flex items-end gap-2">
					<textarea
						ref={inputRef}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey) {
								event.preventDefault();
								handleAsk(draft);
							}
						}}
						rows={3}
						placeholder="Ask why something is blocked, what changed, or what needs you."
						className="flex-1 rounded-xl border px-3 py-2.5 text-sm resize-none"
						style={{
							color: theme.colors.textMain,
							backgroundColor: 'rgba(255,255,255,0.04)',
							borderColor: 'rgba(255,255,255,0.08)',
						}}
					/>
					<button
						type="button"
						onClick={() => handleAsk(draft)}
						disabled={!draft.trim()}
						className="px-3 py-2.5 rounded-xl inline-flex items-center gap-2 disabled:opacity-40"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						<Send className="w-4 h-4" />
						Ask
					</button>
				</div>
			</div>
		</div>
	);
}
