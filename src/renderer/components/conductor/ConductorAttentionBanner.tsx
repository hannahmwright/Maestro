import { AlertTriangle, CheckCircle2, GitMerge, MessageSquare, X } from 'lucide-react';

import type { Theme } from '../../types';

export interface AttentionItem {
	id: string;
	kind: 'operator_action' | 'plan_approval' | 'integration_conflict';
	title: string;
	summary: string;
	actionLabel: string;
	onAction: () => void;
}

interface ConductorAttentionBannerProps {
	theme: Theme;
	items: AttentionItem[];
	onDismiss: () => void;
}

function getKindIcon(kind: AttentionItem['kind']): JSX.Element {
	switch (kind) {
		case 'plan_approval':
			return <CheckCircle2 className="w-4 h-4" />;
		case 'integration_conflict':
			return <GitMerge className="w-4 h-4" />;
		case 'operator_action':
		default:
			return <MessageSquare className="w-4 h-4" />;
	}
}

export function ConductorAttentionBanner({
	theme,
	items,
	onDismiss,
}: ConductorAttentionBannerProps): JSX.Element | null {
	if (items.length === 0) {
		return null;
	}

	return (
		<div
			className="rounded-xl border p-4"
			style={{
				backgroundColor: `${theme.colors.warning}12`,
				borderColor: `${theme.colors.warning}35`,
			}}
		>
			<div className="flex items-start justify-between gap-3 mb-3">
				<div className="flex items-center gap-2">
					<AlertTriangle className="w-4 h-4" style={{ color: theme.colors.warning }} />
					<span className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
						Needs your attention
					</span>
					<span
						className="text-[11px] font-medium px-1.5 py-0.5 rounded-full"
						style={{
							backgroundColor: `${theme.colors.warning}1a`,
							color: theme.colors.warning,
						}}
					>
						{items.length}
					</span>
				</div>
				<button
					type="button"
					onClick={onDismiss}
					className="p-1 rounded-lg hover:bg-white/10"
					style={{ color: theme.colors.textDim }}
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			<div className="space-y-2">
				{items.map((item) => (
					<div
						key={item.id}
						className="flex items-center gap-3 rounded-lg px-3 py-2.5"
						style={{
							backgroundColor: 'rgba(255,255,255,0.04)',
							border: '1px solid rgba(255,255,255,0.06)',
						}}
					>
						<div style={{ color: theme.colors.warning }}>
							{getKindIcon(item.kind)}
						</div>
						<div className="flex-1 min-w-0">
							<div className="text-sm font-medium truncate" style={{ color: theme.colors.textMain }}>
								{item.title}
							</div>
							{item.summary && (
								<div className="text-xs mt-0.5 truncate" style={{ color: theme.colors.textDim }}>
									{item.summary}
								</div>
							)}
						</div>
						<button
							type="button"
							onClick={item.onAction}
							className="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0"
							style={{
								backgroundColor: `${theme.colors.warning}18`,
								border: `1px solid ${theme.colors.warning}30`,
								color: theme.colors.warning,
							}}
						>
							{item.actionLabel}
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
