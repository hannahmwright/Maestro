import { useEffect, useRef } from 'react';
import { Archive, Edit3, Trash2 } from 'lucide-react';
import type { Group, Theme } from '../../types';
import { useClickOutside, useContextMenuPosition } from '../../hooks';

interface GroupContextMenuProps {
	x: number;
	y: number;
	theme: Theme;
	group: Group;
	onEdit: () => void;
	onToggleArchived: () => void;
	onDelete: () => void;
	onDismiss: () => void;
}

export function GroupContextMenu({
	x,
	y,
	theme,
	group,
	onEdit,
	onToggleArchived,
	onDelete,
	onDismiss,
}: GroupContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	useClickOutside(menuRef, onDismiss);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onDismissRef.current();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, []);

	const { left, top, ready } = useContextMenuPosition(menuRef, x, y);

	return (
		<div
			ref={menuRef}
			className="fixed z-50 py-1 rounded-md shadow-xl border"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '170px',
			}}
		>
			<button
				type="button"
				onClick={() => {
					onEdit();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
				title={`Edit ${group.name}`}
			>
				<Edit3 className="w-3.5 h-3.5" />
				Edit Workspace...
			</button>

			<button
				type="button"
				onClick={() => {
					onToggleArchived();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
				title={`${group.archived ? 'Unarchive' : 'Archive'} ${group.name}`}
			>
				<Archive className="w-3.5 h-3.5" />
				{group.archived ? 'Unarchive Workspace' : 'Archive Workspace'}
			</button>

			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

			<button
				type="button"
				onClick={() => {
					onDelete();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.error }}
				title={`Delete ${group.name}`}
			>
				<Trash2 className="w-3.5 h-3.5" />
				Delete Workspace
			</button>
		</div>
	);
}
