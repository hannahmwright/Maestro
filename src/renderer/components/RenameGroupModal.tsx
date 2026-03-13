import React, { useRef } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Theme, Group } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, EmojiPickerField, FormInput } from './ui';

interface RenameGroupModalProps {
	theme: Theme;
	groupId: string;
	groupName: string;
	setGroupName: (name: string) => void;
	groupEmoji: string;
	setGroupEmoji: (emoji: string) => void;
	groupProjectRoot: string;
	setGroupProjectRoot: (projectRoot: string) => void;
	onClose: () => void;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
}

export function RenameGroupModal(props: RenameGroupModalProps) {
	const {
		theme,
		groupId,
		groupName,
		setGroupName,
		groupEmoji,
		setGroupEmoji,
		groupProjectRoot,
		setGroupProjectRoot,
		onClose,
		groups: _groups,
		setGroups,
	} = props;

	const inputRef = useRef<HTMLInputElement>(null);
	const trimmedName = groupName.trim();
	const trimmedProjectRoot = groupProjectRoot.trim();

	const handleBrowse = async () => {
		const result = await window.maestro.dialog.selectFolder();
		if (result) {
			setGroupProjectRoot(result);
		}
	};

	const handleRename = () => {
		if (trimmedName && trimmedProjectRoot && groupId) {
			setGroups((prev) =>
				prev.map((g) =>
					g.id === groupId
						? { ...g, name: trimmedName, emoji: groupEmoji, projectRoot: trimmedProjectRoot }
						: g
				)
			);
			onClose();
		}
	};

	return (
		<Modal
			theme={theme}
			title="Edit Workspace"
			priority={MODAL_PRIORITIES.RENAME_GROUP}
			onClose={onClose}
			initialFocusRef={inputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleRename}
					confirmLabel="Save Changes"
					confirmDisabled={!trimmedName || !trimmedProjectRoot}
				/>
			}
		>
			<div className="flex gap-4 items-start">
				<EmojiPickerField
					theme={theme}
					value={groupEmoji}
					onChange={setGroupEmoji}
					restoreFocusRef={inputRef}
				/>

				<div className="flex-1 space-y-4">
					<FormInput
						ref={inputRef}
						theme={theme}
						label="Workspace Name"
						value={groupName}
						onChange={setGroupName}
						onSubmit={handleRename}
						placeholder="Enter workspace name..."
						heightClass="h-[52px]"
						autoFocus
					/>

					<FormInput
						theme={theme}
						label="Workspace Path"
						value={groupProjectRoot}
						onChange={setGroupProjectRoot}
						onSubmit={handleRename}
						placeholder="/path/to/workspace"
						monospace
						error={!trimmedProjectRoot ? 'Workspace path is required' : undefined}
						helperText="Used as the default directory for new threads in this workspace. Existing threads keep their current paths."
						addon={
							<button
								type="button"
								onClick={() => void handleBrowse()}
								className="px-3 rounded border flex items-center justify-center hover:bg-white/5 transition-colors"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								aria-label="Browse for workspace path"
								title="Browse for workspace path"
							>
								<FolderOpen className="w-4 h-4" />
							</button>
						}
					/>
				</div>
			</div>
		</Modal>
	);
}
