import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';

import type { Theme, ConductorTask, ConductorTaskPriority } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal } from '../ui/Modal';
import { PRIORITY_OPTIONS, formatLabel } from './conductorConstants';
import { getGlassInputStyle, getGlassButtonStyle } from './conductorStyles';

interface ConductorTaskComposerProps {
	theme: Theme;
	tasks: ConductorTask[];
	initialParentId?: string;
	onCreateTask: (input: {
		parentId: string;
		title: string;
		description: string;
		priority: ConductorTaskPriority;
		completionProofRequired: boolean;
	}) => void;
	onClose: () => void;
}

export function ConductorTaskComposer({
	theme,
	tasks,
	initialParentId = '',
	onCreateTask,
	onClose,
}: ConductorTaskComposerProps): JSX.Element {
	const [parentId, setParentId] = useState(initialParentId);
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [priority, setPriority] = useState<ConductorTaskPriority>('medium');
	const [completionProofRequired, setCompletionProofRequired] = useState(false);
	const isTopLevelTask = !parentId;

	useEffect(() => {
		if (!parentId) {
			return;
		}

		setCompletionProofRequired(false);
	}, [parentId]);

	const reset = () => {
		setParentId('');
		setTitle('');
		setDescription('');
		setPriority('medium');
		setCompletionProofRequired(false);
	};

	const handleClose = () => {
		reset();
		onClose();
	};

	const handleCreate = () => {
		onCreateTask({ parentId, title, description, priority, completionProofRequired });
		reset();
	};

	return (
		<Modal
			theme={theme}
			title={parentId ? 'Add Subtask' : 'Add Task'}
			priority={MODAL_PRIORITIES.SETTINGS + 2}
			onClose={handleClose}
			width={680}
			maxHeight="85vh"
			closeOnBackdropClick
		>
			<div className="space-y-4">
				<p className="text-sm leading-6" style={{ color: theme.colors.textDim }}>
					Add a task directly to the board. If you attach it to a parent, it becomes a first-class
					subtask that can move through planning, execution, and QA on its own.
				</p>

				<div>
					<div className="mb-2 text-sm" style={{ color: theme.colors.textDim }}>
						Parent task
					</div>
					<select
						value={parentId}
						onChange={(e) => setParentId(e.target.value)}
						className="w-full rounded-lg border px-3 py-2 text-sm"
						style={getGlassInputStyle(theme)}
					>
						<option value="">No parent, create a top-level task</option>
						{tasks.map((task) => (
							<option key={task.id} value={task.id}>
								{task.title}
							</option>
						))}
					</select>
				</div>

				<input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="Short task title"
					className="w-full rounded-lg border px-3 py-3 text-sm"
					style={getGlassInputStyle(theme)}
				/>

				<textarea
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="What needs to happen?"
					rows={4}
					className="w-full rounded-lg border px-3 py-3 text-sm resize-y"
					style={getGlassInputStyle(theme)}
				/>

				<div>
					<div className="mb-2 text-sm" style={{ color: theme.colors.textDim }}>
						Priority
					</div>
					<select
						value={priority}
						onChange={(e) => setPriority(e.target.value as ConductorTaskPriority)}
						className="w-full rounded-lg border px-3 py-2 text-sm"
						style={getGlassInputStyle(theme)}
					>
						{PRIORITY_OPTIONS.map((option) => (
							<option key={option} value={option}>
								{formatLabel(option)}
							</option>
						))}
					</select>
				</div>

				{isTopLevelTask && (
					<label
						className="flex items-start gap-3 rounded-xl border px-3.5 py-3 text-sm cursor-pointer"
						style={getGlassInputStyle(theme)}
					>
						<input
							type="checkbox"
							checked={completionProofRequired}
							onChange={(event) => setCompletionProofRequired(event.target.checked)}
							className="mt-0.5"
						/>
						<span>
							<div style={{ color: theme.colors.textMain }}>Require proof before Complete</div>
							<div className="mt-1 text-xs leading-5" style={{ color: theme.colors.textDim }}>
								Top-level tasks can require a screen recording plus screenshots before they move
								into Done.
							</div>
						</span>
					</label>
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
						onClick={handleCreate}
						disabled={!title.trim()}
						className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
						style={getGlassButtonStyle(theme, { accent: true })}
					>
						<ClipboardList className="w-4 h-4" />
						{parentId ? 'Create subtask' : 'Create task'}
					</button>
				</div>
			</div>
		</Modal>
	);
}
