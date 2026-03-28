import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, Send, Sparkles } from 'lucide-react';

import type { Theme, Conductor, ConductorProviderAgent, Session, WizardMessage } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { generateId } from '../../utils/ids';
import { Modal } from '../ui/Modal';
import { WizardConfidenceGauge } from '../InlineWizard/WizardConfidenceGauge';
import { WizardMessageBubble } from '../InlineWizard/WizardMessageBubble';
import {
	buildConductorPlanDiscoveryHandoff,
	sendConductorPlanDiscoveryTurn,
} from '../../services/conductorPlanDiscovery';
import { READY_CONFIDENCE_THRESHOLD } from '../../services/inlineWizardConversation';
import {
	getGlassButtonStyle,
	getGlassInputStyle,
	getGlassPanelStyle,
	getGlassPillStyle,
} from './conductorStyles';

interface ConductorPlanComposerProps {
	theme: Theme;
	groupName: string;
	conductor: Conductor | null | undefined;
	selectedTemplate: Session | null;
	isPlanning: boolean;
	planningError: string | null;
	onSetAutoExecute: (value: boolean) => void;
	onSubmitPlan: (input: {
		requestOverride: string;
		operatorNotesOverride: string;
		autoExecute: boolean;
		providerOverride?: ConductorProviderAgent;
	}) => void;
	onClose: () => void;
}

interface PendingDiscoveryRetry {
	historyBeforeTurn: WizardMessage[];
	userMessage: WizardMessage;
}

function createWizardMessage(
	role: WizardMessage['role'],
	content: string,
	extras?: Partial<Pick<WizardMessage, 'confidence' | 'ready'>>
): WizardMessage {
	return {
		id: generateId(),
		role,
		content,
		timestamp: Date.now(),
		...extras,
	};
}

function buildRoutingNote(input: { routedFrom?: string; providerLabel: string; reason?: string }): string | null {
	if (!input.routedFrom || !input.reason) {
		return null;
	}

	return `Discovery rerouted from ${input.routedFrom} to ${input.providerLabel}. ${input.reason}`;
}

export function ConductorPlanComposer({
	theme,
	groupName,
	conductor,
	selectedTemplate,
	isPlanning,
	planningError,
	onSetAutoExecute,
	onSubmitPlan,
	onClose,
}: ConductorPlanComposerProps): JSX.Element {
	const [description, setDescription] = useState('');
	const [notes, setNotes] = useState('');
	const [replyDraft, setReplyDraft] = useState('');
	const [conversationHistory, setConversationHistory] = useState<WizardMessage[]>([]);
	const [confidence, setConfidence] = useState(0);
	const [ready, setReady] = useState(false);
	const [isDiscovering, setIsDiscovering] = useState(false);
	const [discoveryError, setDiscoveryError] = useState<string | null>(null);
	const [discoveryToolType, setDiscoveryToolType] = useState<ConductorProviderAgent | null>(null);
	const [providerLabel, setProviderLabel] = useState<string | null>(null);
	const [routingNote, setRoutingNote] = useState<string | null>(null);
	const [pendingRetry, setPendingRetry] = useState<PendingDiscoveryRetry | null>(null);
	const conversationContainerRef = useRef<HTMLDivElement>(null);
	const replyInputRef = useRef<HTMLTextAreaElement>(null);

	const hasStartedDiscovery = conversationHistory.length > 0;
	const canStartDiscovery = Boolean(selectedTemplate) && description.trim().length > 0 && !isDiscovering;
	const canSendReply =
		Boolean(selectedTemplate) &&
		hasStartedDiscovery &&
		replyDraft.trim().length > 0 &&
		!isDiscovering;
	const canGeneratePlan =
		Boolean(selectedTemplate) &&
		hasStartedDiscovery &&
		ready &&
		confidence >= READY_CONFIDENCE_THRESHOLD &&
		!isDiscovering &&
		!isPlanning;

	const handoffNotes = useMemo(
		() =>
			buildConductorPlanDiscoveryHandoff({
				operatorNotes: notes,
				conversationHistory,
			}),
		[conversationHistory, notes]
	);

	useEffect(() => {
		const container = conversationContainerRef.current;
		if (!container) {
			return;
		}

		container.scrollTo({
			top: container.scrollHeight,
			behavior: 'smooth',
		});
	}, [conversationHistory, isDiscovering, discoveryError, routingNote]);

	useEffect(() => {
		if (!hasStartedDiscovery || isDiscovering) {
			return;
		}

		replyInputRef.current?.focus();
	}, [hasStartedDiscovery, isDiscovering]);

	const resetDiscoveryState = () => {
		setConversationHistory([]);
		setConfidence(0);
		setReady(false);
		setReplyDraft('');
		setDiscoveryError(null);
		setDiscoveryToolType(null);
		setProviderLabel(null);
		setRoutingNote(null);
		setPendingRetry(null);
	};

	const handleClose = () => {
		resetDiscoveryState();
		setDescription('');
		setNotes('');
		onClose();
	};

	const runDiscoveryTurn = async (userMessage: WizardMessage, historyBeforeTurn: WizardMessage[]) => {
		if (!selectedTemplate) {
			return;
		}

		setConversationHistory([...historyBeforeTurn, userMessage]);
		setIsDiscovering(true);
		setDiscoveryError(null);
		setPendingRetry(null);

		try {
			const result = await sendConductorPlanDiscoveryTurn({
				parentSession: selectedTemplate,
				groupName,
				initialRequest: description.trim(),
				operatorNotes: notes.trim(),
				conversationHistory: historyBeforeTurn,
				userMessage: userMessage.content,
			});
			const assistantMessage = createWizardMessage('assistant', result.response.message, {
				confidence: result.response.confidence,
				ready: result.response.ready,
			});
			setConversationHistory([...historyBeforeTurn, userMessage, assistantMessage]);
			setConfidence(result.response.confidence);
			setReady(result.response.ready);
			setDiscoveryToolType(result.toolType);
			setProviderLabel(result.providerLabel);
			setRoutingNote(
				buildRoutingNote({
					routedFrom: result.routedFromLabel,
					providerLabel: result.providerLabel,
					reason: result.reason,
				})
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Conductor discovery could not continue.';
			setConversationHistory([...historyBeforeTurn, userMessage]);
			setDiscoveryError(message);
			setPendingRetry({ historyBeforeTurn, userMessage });
		} finally {
			setIsDiscovering(false);
		}
	};

	const handleStartDiscovery = () => {
		const initialRequest = description.trim();
		if (!selectedTemplate || !initialRequest) {
			return;
		}

		void runDiscoveryTurn(createWizardMessage('user', initialRequest), []);
	};

	const handleSendReply = () => {
		const nextReply = replyDraft.trim();
		if (!selectedTemplate || !nextReply) {
			return;
		}

		const historyBeforeTurn = [...conversationHistory];
		setReplyDraft('');
		void runDiscoveryTurn(createWizardMessage('user', nextReply), historyBeforeTurn);
	};

	const handleRetry = () => {
		if (!pendingRetry) {
			return;
		}

		setConversationHistory(pendingRetry.historyBeforeTurn);
		setDiscoveryError(null);
		void runDiscoveryTurn(pendingRetry.userMessage, pendingRetry.historyBeforeTurn);
	};

	return (
		<Modal
			theme={theme}
			title="New Plan"
			priority={MODAL_PRIORITIES.SETTINGS + 2}
			onClose={handleClose}
			width={920}
			maxHeight="88vh"
			closeOnBackdropClick
		>
			<div className="space-y-4">
				<div className="flex items-start justify-between gap-3">
					<div className="space-y-2">
						<p className="text-sm leading-6" style={{ color: theme.colors.textMain }}>
							Conductor will ask a few focused questions, build confidence, and only commit to
							the strict planner once the scope is clear.
						</p>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							The planner unlocks at {READY_CONFIDENCE_THRESHOLD}% confidence.
						</p>
					</div>

					<div className="flex flex-col items-end gap-2">
						<WizardConfidenceGauge confidence={confidence} theme={theme} />
						{providerLabel && (
							<div className="px-3 py-1 rounded-full text-xs font-semibold" style={getGlassPillStyle(theme, ready ? 'success' : 'accent')}>
								{providerLabel}
							</div>
						)}
					</div>
				</div>

				{!hasStartedDiscovery ? (
					<div className="space-y-3">
						<textarea
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Describe what this plan should accomplish."
							rows={5}
							className="w-full rounded-lg border px-3 py-3 text-sm resize-y"
							style={getGlassInputStyle(theme)}
						/>

						<textarea
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							placeholder="Optional notes: what matters most, what should happen first, risks to watch, or areas to avoid."
							rows={3}
							className="w-full rounded-lg border px-3 py-2 text-sm resize-y"
							style={getGlassInputStyle(theme)}
						/>
					</div>
				) : (
					<div
						className="rounded-xl p-4 space-y-3"
						style={getGlassPanelStyle(theme, {
							tint: `${theme.colors.accent}10`,
							borderColor: `${theme.colors.accent}24`,
							strong: true,
						})}
					>
						<div className="flex items-start justify-between gap-3">
							<div>
								<div className="text-xs uppercase tracking-[0.18em]" style={{ color: theme.colors.textDim }}>
									Plan Brief
								</div>
								<div className="text-sm mt-2 whitespace-pre-wrap" style={{ color: theme.colors.textMain }}>
									{description.trim()}
								</div>
							</div>

							<button
								onClick={resetDiscoveryState}
								disabled={isDiscovering || isPlanning}
								className="px-3 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
								style={getGlassButtonStyle(theme)}
							>
								<RefreshCw className="w-4 h-4" />
								Restart
							</button>
						</div>

						{notes.trim() && (
							<div>
								<div className="text-xs uppercase tracking-[0.18em]" style={{ color: theme.colors.textDim }}>
									Operator Notes
								</div>
								<div className="text-sm mt-2 whitespace-pre-wrap" style={{ color: theme.colors.textMain }}>
									{notes.trim()}
								</div>
							</div>
						)}
					</div>
				)}

				<label className="flex items-center gap-2 text-sm" style={{ color: theme.colors.textMain }}>
					<input
						type="checkbox"
						checked={Boolean(conductor?.autoExecuteOnPlanCreation)}
						onChange={(e) => onSetAutoExecute(e.target.checked)}
					/>
					Autoplay approved plans
				</label>

				<div
					className="rounded-xl overflow-hidden"
					style={getGlassPanelStyle(theme, {
						tint: 'rgba(255,255,255,0.06)',
						borderColor: 'rgba(255,255,255,0.10)',
						strong: true,
					})}
				>
					<div
						ref={conversationContainerRef}
						className="max-h-[360px] min-h-[280px] overflow-y-auto p-4"
						style={{ backgroundColor: `${theme.colors.bgMain}66` }}
					>
						{!hasStartedDiscovery && !isDiscovering ? (
							<div className="h-full flex items-center justify-center">
								<div className="max-w-lg text-center space-y-4">
									<div
										className="inline-flex px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-[0.18em]"
										style={getGlassPillStyle(theme, 'accent')}
									>
										Conductor Discovery
									</div>
									<p className="text-sm" style={{ color: theme.colors.textMain }}>
										Start with the outcome you want. Conductor will inspect the codebase,
										ask only the important follow-up questions, and summarize the confirmed
										scope before it generates the actual plan.
									</p>
								</div>
							</div>
						) : (
							<>
								{conversationHistory.map((message) => (
									<WizardMessageBubble
										key={message.id}
										message={message}
										theme={theme}
										agentName="Conductor"
										providerName={providerLabel || undefined}
									/>
								))}

								{isDiscovering && (
									<div className="flex justify-start mb-4">
										<div
											className="max-w-[80%] rounded-lg rounded-bl-none px-4 py-3 inline-flex items-center gap-2"
											style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
										>
											<Loader2 className="w-4 h-4 animate-spin" />
											<span className="text-sm">Conductor is tightening the brief...</span>
										</div>
									</div>
								)}
							</>
						)}
					</div>

					<div className="border-t p-4 space-y-3" style={{ borderColor: `${theme.colors.border}aa` }}>
						{routingNote && (
							<div
								className="rounded-lg border px-3 py-2 text-xs"
								style={{
									...getGlassPanelStyle(theme, {
										tint: `${theme.colors.accent}10`,
										borderColor: `${theme.colors.accent}28`,
									}),
									color: theme.colors.textMain,
								}}
							>
								{routingNote}
							</div>
						)}

						{discoveryError && (
							<div
								className="rounded-lg border p-3 text-sm"
								style={{
									...getGlassPanelStyle(theme, {
										tint: `${theme.colors.warning}12`,
										borderColor: `${theme.colors.warning}35`,
									}),
									color: theme.colors.warning,
								}}
							>
								<div>{discoveryError}</div>
								{pendingRetry && (
									<button
										onClick={handleRetry}
										disabled={isDiscovering}
										className="mt-3 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50"
										style={getGlassButtonStyle(theme)}
									>
										Try that turn again
									</button>
								)}
							</div>
						)}

						{planningError && (
							<div
								className="rounded-lg border p-3 text-sm"
								style={{
									...getGlassPanelStyle(theme, {
										tint: `${theme.colors.warning}12`,
										borderColor: `${theme.colors.warning}35`,
									}),
									color: theme.colors.warning,
								}}
							>
								{planningError}
							</div>
						)}

						{hasStartedDiscovery && (
							<div className="space-y-2">
								<textarea
									ref={replyInputRef}
									value={replyDraft}
									onChange={(e) => setReplyDraft(e.target.value)}
									onKeyDown={(event) => {
										if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
											event.preventDefault();
											handleSendReply();
										}
									}}
									placeholder={
										ready
											? 'Add anything else the strict planner should preserve.'
											: 'Answer the question or add any constraints that will help the plan.'
									}
									rows={3}
									disabled={isDiscovering || !selectedTemplate}
									className="w-full rounded-lg border px-3 py-3 text-sm resize-y disabled:opacity-60"
									style={getGlassInputStyle(theme)}
								/>

								<div className="flex items-center justify-between gap-3">
									<p className="text-xs" style={{ color: theme.colors.textDim }}>
										Use Cmd/Ctrl+Enter to send another clarification turn.
									</p>

									<button
										onClick={handleSendReply}
										disabled={!canSendReply}
										className="px-3 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
										style={getGlassButtonStyle(theme)}
									>
										<Send className="w-4 h-4" />
										Send
									</button>
								</div>
							</div>
						)}
					</div>
				</div>

				<div className="flex items-center justify-between gap-3 pt-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						{hasStartedDiscovery
							? ready
								? 'The brief is clear enough to hand off to the strict planner.'
								: 'Conductor will enable plan creation once the scope is clear enough to decompose.'
							: 'Start discovery once the request captures the outcome you want.'}
					</div>

					<div className="flex items-center gap-3">
						<button
							onClick={handleClose}
							className="px-3 py-2 rounded-lg text-sm font-medium"
							style={getGlassButtonStyle(theme)}
						>
							Cancel
						</button>

						{!hasStartedDiscovery ? (
							<button
								onClick={handleStartDiscovery}
								disabled={!canStartDiscovery || isPlanning}
								className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
								style={getGlassButtonStyle(theme, { accent: true })}
							>
								{isDiscovering ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<Sparkles className="w-4 h-4" />
								)}
								Start discovery
							</button>
						) : (
							<button
								onClick={() =>
									void onSubmitPlan({
										requestOverride: description.trim(),
										operatorNotesOverride: handoffNotes,
										autoExecute: conductor?.autoExecuteOnPlanCreation ?? true,
										providerOverride: discoveryToolType || undefined,
									})
								}
								disabled={!canGeneratePlan}
								className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
								style={getGlassButtonStyle(theme, { accent: true })}
							>
								{isPlanning ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<Sparkles className="w-4 h-4" />
								)}
								{isPlanning ? 'Planning...' : 'Generate plan'}
							</button>
						)}
					</div>
				</div>
			</div>
		</Modal>
	);
}
