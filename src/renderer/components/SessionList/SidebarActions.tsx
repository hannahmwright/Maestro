import { memo } from 'react';
import { ChevronsLeft, PanelLeftClose, PanelLeftOpen, Wand2 } from 'lucide-react';
import type { Theme, Shortcut } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

interface SidebarActionsProps {
	theme: Theme;
	leftSidebarOpen: boolean;
	leftSidebarHidden: boolean;
	hasNoSessions: boolean;
	shortcuts?: Record<string, Shortcut>;
	openWizard?: () => void;
	setLeftSidebarOpen: (open: boolean) => void;
	setLeftSidebarHidden: (hidden: boolean) => void;
}

export const SidebarActions = memo(function SidebarActions({
	theme,
	leftSidebarOpen,
	leftSidebarHidden,
	hasNoSessions,
	shortcuts = {},
	openWizard,
	setLeftSidebarOpen,
	setLeftSidebarHidden,
}: SidebarActionsProps) {
	const toggleSidebarShortcut = formatShortcutKeys(shortcuts.toggleSidebar?.keys ?? []);
	const openWizardShortcut = formatShortcutKeys(shortcuts.openWizard?.keys ?? []);

	return (
		<div
			className="p-2 border-t flex items-center justify-between gap-2"
			style={{ borderColor: theme.colors.border }}
		>
			{leftSidebarOpen && openWizard && (
				<button
					type="button"
					onClick={openWizard}
					className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold transition-colors hover:opacity-90 shrink-0"
					style={{
						backgroundColor: `${theme.colors.accent}18`,
						border: `1px solid ${theme.colors.accent}35`,
						color: theme.colors.accent,
					}}
					title={`New Project (${openWizardShortcut})`}
				>
					<Wand2 className="w-3 h-3" /> New Project
				</button>
			)}

			<div className="flex items-center gap-2 ml-auto">
				<button
					type="button"
					disabled={hasNoSessions && leftSidebarOpen}
					onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
					className={`flex items-center justify-center p-2 rounded transition-colors w-8 h-8 shrink-0 ${hasNoSessions && leftSidebarOpen ? 'opacity-20 cursor-not-allowed' : 'hover:bg-white/5'}`}
					title={
						hasNoSessions && leftSidebarOpen
							? 'Add an agent first to collapse sidebar'
							: `${leftSidebarOpen ? 'Collapse' : 'Expand'} Sidebar (${toggleSidebarShortcut})`
					}
				>
					{leftSidebarOpen ? (
						<PanelLeftClose className="w-4 h-4 opacity-50" />
					) : (
						<PanelLeftOpen className="w-4 h-4 opacity-50" />
					)}
				</button>

				{!leftSidebarHidden && (
					<button
						type="button"
						onClick={() => setLeftSidebarHidden(true)}
						className="flex items-center justify-center p-2 rounded transition-colors w-8 h-8 shrink-0 hover:bg-white/5"
						title="Hide Sidebar"
					>
						<ChevronsLeft className="w-4 h-4 opacity-50" />
					</button>
				)}
			</div>
		</div>
	);
});
