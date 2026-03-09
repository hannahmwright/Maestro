import React, { useEffect, useMemo, useState } from 'react';
import type { Theme } from '../types';
import type { DemoDetail } from '../../shared/demo-artifacts';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface DemoViewerModalProps {
	theme: Theme;
	demoId: string;
	onClose: () => void;
}

function formatDuration(durationMs?: number | null): string | null {
	if (!durationMs || durationMs <= 0) return null;
	const totalSeconds = Math.round(durationMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function DemoViewerModal({ theme, demoId, onClose }: DemoViewerModalProps) {
	const [demo, setDemo] = useState<DemoDetail | null>(null);
	const [posterDataUrl, setPosterDataUrl] = useState<string | null>(null);
	const [videoSrc, setVideoSrc] = useState<string | null>(null);
	const [stepImages, setStepImages] = useState<Record<string, string>>({});

	useEffect(() => {
		let cancelled = false;
		void window.maestro.artifacts.getDemo(demoId).then((loadedDemo) => {
			if (!cancelled) {
				setDemo(loadedDemo);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [demoId]);

	useEffect(() => {
		let cancelled = false;
		const posterArtifactId = demo?.posterArtifact?.id;
		if (!posterArtifactId) {
			setPosterDataUrl(null);
			return;
		}
		void window.maestro.artifacts.loadArtifact(posterArtifactId).then((dataUrl) => {
			if (!cancelled) {
				setPosterDataUrl(dataUrl);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [demo?.posterArtifact?.id]);

	useEffect(() => {
		let cancelled = false;
		const videoArtifactId = demo?.videoArtifact?.id;
		if (!videoArtifactId) {
			setVideoSrc(null);
			return;
		}
		void window.maestro.artifacts.getArtifactFileInfo(videoArtifactId).then((fileInfo) => {
			if (!cancelled) {
				setVideoSrc(fileInfo ? `file://${fileInfo.path}` : null);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [demo?.videoArtifact?.id]);

	useEffect(() => {
		let cancelled = false;
		const screenshotSteps = demo?.steps.filter((step) => !!step.screenshotArtifact?.id) || [];
		if (screenshotSteps.length === 0) {
			setStepImages({});
			return;
		}

		void Promise.all(
			screenshotSteps.map(async (step) => {
				const image = await window.maestro.artifacts.loadArtifact(step.screenshotArtifact!.id);
				return [step.id, image || ''] as const;
			})
		).then((entries) => {
			if (!cancelled) {
				setStepImages(Object.fromEntries(entries));
			}
		});

		return () => {
			cancelled = true;
		};
	}, [demo]);

	const durationLabel = useMemo(() => formatDuration(demo?.durationMs), [demo?.durationMs]);

	return (
		<Modal
			theme={theme}
			title={demo?.title || 'Demo'}
			priority={MODAL_PRIORITIES.SAVE_MARKDOWN}
			onClose={onClose}
			width={860}
			closeOnBackdropClick
		>
			<div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1">
				{videoSrc ? (
					<video
						controls
						preload="metadata"
						poster={posterDataUrl || undefined}
						src={videoSrc}
						style={{
							width: '100%',
							borderRadius: '16px',
							border: `1px solid ${theme.colors.border}`,
							backgroundColor: '#020617',
						}}
					/>
				) : posterDataUrl ? (
					<img
						src={posterDataUrl}
						alt={demo?.title || 'Demo'}
						style={{
							width: '100%',
							borderRadius: '16px',
							border: `1px solid ${theme.colors.border}`,
						}}
					/>
				) : null}

				{demo?.summary ? (
					<div className="text-sm" style={{ color: theme.colors.textMain }}>
						{demo.summary}
					</div>
				) : null}

				<div className="flex flex-wrap gap-3 text-xs" style={{ color: theme.colors.textDim }}>
					<span>{demo?.stepCount || 0} steps</span>
					{durationLabel ? <span>{durationLabel}</span> : null}
					{demo ? <span>{new Date(demo.createdAt).toLocaleString()}</span> : null}
				</div>

				<div className="flex flex-col gap-3">
					{demo?.steps.map((step, index) => (
						<div
							key={step.id}
							className="rounded-xl border p-3"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: `${theme.colors.bgMain}cc`,
							}}
						>
							<div
								className="mb-1 text-[11px] uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								Step {index + 1}
							</div>
							<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
								{step.title}
							</div>
							{step.description ? (
								<div className="mt-1 text-sm" style={{ color: theme.colors.textDim }}>
									{step.description}
								</div>
							) : null}
							{stepImages[step.id] ? (
								<img
									src={stepImages[step.id]}
									alt={step.title}
									style={{
										width: '100%',
										marginTop: '12px',
										borderRadius: '14px',
										border: `1px solid ${theme.colors.border}`,
									}}
								/>
							) : null}
						</div>
					))}
				</div>
			</div>
		</Modal>
	);
}
