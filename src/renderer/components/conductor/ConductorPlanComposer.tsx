import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import type { Theme, Conductor, Session } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal } from '../ui/Modal';
import { getGlassInputStyle, getGlassButtonStyle, getGlassPanelStyle } from './conductorStyles';

interface ConductorPlanComposerProps {
	theme: Theme;
	conductor: Conductor | null | undefined;
	selectedTemplate: Session | null;
	isPlanning: boolean;
	planningError: string | null;
	onSetAutoExecute: (value: boolean) => void;
	onSubmitPlan: (input: {
		requestOverride: string;
		operatorNotesOverride: string;
		autoExecute: boolean;
	}) => void;
	onClose: () => void;
}

export function ConductorPlanComposer({
	theme,
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

	const handleClose = () => {
		setDescription('');
		setNotes('');
		onClose();
	};

	return (
		<Modal
			theme={theme}
			title="New Plan"
			priority={MODAL_PRIORITIES.SETTINGS + 2}
			onClose={handleClose}
			width={760}
			maxHeight="85vh"
			closeOnBackdropClick
		>
			<div className="space-y-4">
				<p className="text-sm leading-6" style={{ color: theme.colors.textDim }}>
					Write the request in plain English. Conductor will break it down into tasks.
				</p>

				<textarea
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="Example: fix the flaky login issue, tighten the onboarding copy, and make the settings page easier to scan."
					rows={6}
					className="w-full rounded-lg border px-3 py-3 text-sm resize-y"
					style={getGlassInputStyle(theme)}
				/>

				<textarea
					value={notes}
					onChange={(e) => setNotes(e.target.value)}
					placeholder="Optional notes: what matters most, what should happen first, what areas to avoid, or how bold the changes should be."
					rows={3}
					className="w-full rounded-lg border px-3 py-2 text-sm resize-y"
					style={getGlassInputStyle(theme)}
				/>

				<label
					className="flex items-center gap-2 text-sm"
					style={{ color: theme.colors.textMain }}
				>
					<input
						type="checkbox"
						checked={Boolean(conductor?.autoExecuteOnPlanCreation)}
						onChange={(e) => onSetAutoExecute(e.target.checked)}
					/>
						Autoplay approved plans
				</label>

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

				<div className="flex items-center justify-between gap-3 pt-2">
					<button
						onClick={handleClose}
						className="px-3 py-2 rounded-lg text-sm font-medium"
						style={getGlassButtonStyle(theme)}
					>
						Cancel
					</button>

					<button
						onClick={() =>
							void onSubmitPlan({
								requestOverride: description,
								operatorNotesOverride: notes,
								autoExecute: conductor?.autoExecuteOnPlanCreation ?? true,
							})
						}
						disabled={isPlanning || !selectedTemplate || !description.trim()}
						className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
						style={getGlassButtonStyle(theme, { accent: true })}
					>
						{isPlanning ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							<Sparkles className="w-4 h-4" />
						)}
						{isPlanning ? 'Planning...' : 'Submit plan'}
					</button>
				</div>
			</div>
		</Modal>
	);
}
