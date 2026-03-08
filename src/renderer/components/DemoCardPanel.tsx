import React, { useEffect, useState } from 'react';
import type { Theme } from '../types';
import type { DemoCard } from '../../shared/demo-artifacts';

interface DemoCardPanelProps {
	theme: Theme;
	demoCard: DemoCard;
	onOpen: () => void;
}

export function DemoCardPanel({ theme, demoCard, onOpen }: DemoCardPanelProps) {
	const [posterDataUrl, setPosterDataUrl] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const artifactId = demoCard.posterArtifact?.id;
		if (!artifactId) {
			setPosterDataUrl(null);
			return;
		}

		void window.maestro.artifacts.loadArtifact(artifactId).then((dataUrl) => {
			if (!cancelled) {
				setPosterDataUrl(dataUrl);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [demoCard.posterArtifact?.id]);

	return (
		<button
			type="button"
			onClick={onOpen}
			className="w-full rounded-xl border text-left transition-opacity hover:opacity-90"
			style={{
				borderColor: theme.colors.border,
				background: `linear-gradient(180deg, ${theme.colors.bgSidebar}f2 0%, ${theme.colors.bgMain}f8 100%)`,
				padding: '14px',
			}}
		>
			<div className="flex flex-col gap-3">
				{posterDataUrl ? (
					<img
						src={posterDataUrl}
						alt={demoCard.title}
						style={{
							width: '100%',
							maxHeight: '240px',
							objectFit: 'cover',
							borderRadius: '14px',
							border: `1px solid ${theme.colors.border}`,
						}}
					/>
				) : null}
				<div className="flex flex-col gap-1">
					<div className="text-[11px] font-semibold tracking-[0.12em]" style={{ color: theme.colors.textDim }}>
						DEMO
					</div>
					<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
						{demoCard.title}
					</div>
					{demoCard.summary ? (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							{demoCard.summary}
						</div>
					) : null}
				</div>
				<div className="flex flex-wrap gap-2 text-[11px]" style={{ color: theme.colors.textDim }}>
					<span>{demoCard.stepCount} steps</span>
					{demoCard.durationMs ? <span>{Math.round(demoCard.durationMs / 1000)}s</span> : null}
					<span>{demoCard.status}</span>
				</div>
			</div>
		</button>
	);
}
