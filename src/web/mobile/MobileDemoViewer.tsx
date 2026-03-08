import React, { useEffect, useMemo, useState } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type { DemoDetail } from '../../shared/demo-artifacts';
import { buildApiUrl } from '../utils/config';

interface MobileDemoViewerProps {
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

function artifactUrl(artifactId?: string | null): string | null {
	if (!artifactId) return null;
	return buildApiUrl(`/artifacts/${artifactId}/content`);
}

export function MobileDemoViewer({ demoId, onClose }: MobileDemoViewerProps) {
	const colors = useThemeColors();
	const [demo, setDemo] = useState<DemoDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		setIsLoading(true);
		setError(null);

		void fetch(buildApiUrl(`/demos/${demoId}`))
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(`Failed to load demo (${response.status})`);
				}
				return response.json();
			})
			.then((payload: { demo: DemoDetail }) => {
				if (!cancelled) {
					setDemo(payload.demo);
				}
			})
			.catch((fetchError: unknown) => {
				if (!cancelled) {
					setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [demoId]);

	const videoUrl = useMemo(() => artifactUrl(demo?.videoArtifact?.id), [demo?.videoArtifact?.id]);
	const posterUrl = useMemo(() => artifactUrl(demo?.posterArtifact?.id), [demo?.posterArtifact?.id]);

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 220,
				background: 'rgba(2, 6, 23, 0.62)',
				backdropFilter: 'blur(20px)',
				WebkitBackdropFilter: 'blur(20px)',
				display: 'flex',
				alignItems: 'stretch',
				justifyContent: 'center',
			}}
		>
			<button
				type="button"
				onClick={onClose}
				aria-label="Close demo viewer"
				style={{ position: 'absolute', inset: 0, border: 'none', background: 'transparent' }}
			/>
			<div
				style={{
					position: 'relative',
					width: '100%',
					height: '100%',
					maxWidth: '720px',
					background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
					color: colors.textMain,
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '16px 18px 12px',
						borderBottom: `1px solid ${colors.border}`,
					}}
				>
					<div style={{ minWidth: 0 }}>
						<div style={{ fontSize: '11px', letterSpacing: '0.08em', color: colors.textDim }}>
							DEMO
						</div>
						<div
							style={{
								fontSize: '18px',
								fontWeight: 700,
								whiteSpace: 'nowrap',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
							}}
						>
							{demo?.title || 'Loading demo'}
						</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						style={{
							border: `1px solid ${colors.border}`,
							background: `${colors.bgMain}cc`,
							color: colors.textMain,
							borderRadius: '999px',
							padding: '8px 12px',
							fontSize: '12px',
							fontWeight: 600,
							cursor: 'pointer',
						}}
					>
						Close
					</button>
				</div>

				<div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
					{isLoading && <div style={{ color: colors.textDim }}>Loading demo...</div>}
					{error && <div style={{ color: colors.error }}>{error}</div>}
					{demo && (
						<>
							{videoUrl ? (
								<video
									controls
									preload="metadata"
									poster={posterUrl || undefined}
									src={videoUrl}
									style={{
										width: '100%',
										borderRadius: '20px',
										background: '#020617',
										border: `1px solid ${colors.border}`,
									}}
								/>
							) : posterUrl ? (
								<img
									src={posterUrl}
									alt={demo.title}
									style={{
										width: '100%',
										borderRadius: '20px',
										border: `1px solid ${colors.border}`,
										display: 'block',
									}}
								/>
							) : null}

							<div
								style={{
									display: 'flex',
									flexWrap: 'wrap',
									gap: '8px',
									color: colors.textDim,
									fontSize: '12px',
								}}
							>
								<span>{demo.stepCount} steps</span>
								{formatDuration(demo.durationMs) && <span>{formatDuration(demo.durationMs)}</span>}
								<span>{new Date(demo.createdAt).toLocaleString()}</span>
							</div>

							{demo.summary && <div style={{ fontSize: '14px', lineHeight: 1.5 }}>{demo.summary}</div>}

							<div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
								{demo.steps.map((step, index) => {
									const screenshotUrl = artifactUrl(step.screenshotArtifact?.id);
									return (
										<div
											key={step.id}
											style={{
												border: `1px solid ${colors.border}`,
												borderRadius: '18px',
												padding: '14px',
												background: `${colors.bgMain}cc`,
												display: 'flex',
												flexDirection: 'column',
												gap: '10px',
											}}
										>
											<div style={{ fontSize: '12px', color: colors.textDim }}>
												Step {index + 1}
											</div>
											<div style={{ fontSize: '15px', fontWeight: 700 }}>{step.title}</div>
											{step.description && (
												<div style={{ fontSize: '13px', lineHeight: 1.5 }}>{step.description}</div>
											)}
											{screenshotUrl && (
												<img
													src={screenshotUrl}
													alt={step.title}
													style={{
														width: '100%',
														borderRadius: '16px',
														border: `1px solid ${colors.border}`,
														display: 'block',
													}}
												/>
											)}
										</div>
									);
								})}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

export default MobileDemoViewer;
