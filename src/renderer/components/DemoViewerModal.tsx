import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, Expand, X } from 'lucide-react';
import type { Theme } from '../types';
import type { DemoDetail } from '../../shared/demo-artifacts';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useModalLayer } from '../hooks/ui/useModalLayer';

interface DemoViewerModalProps {
	theme: Theme;
	demoId: string;
	onClose: () => void;
}

interface DesktopDemoMediaItem {
	id: string;
	artifactId: string;
	kind: 'image' | 'video';
	src: string;
	alt: string;
	filename: string;
	posterSrc?: string | null;
}

function formatDuration(durationMs?: number | null): string | null {
	if (!durationMs || durationMs <= 0) return null;
	const totalSeconds = Math.round(durationMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function buildArtifactFilters(
	filename: string
): Array<{ name: string; extensions: string[] }> | undefined {
	const extension = filename.split('.').pop()?.trim().toLowerCase();
	if (!extension) {
		return undefined;
	}
	return [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }];
}

function DemoMediaLightbox({
	items,
	activeIndex,
	onNavigate,
	onClose,
}: {
	items: DesktopDemoMediaItem[];
	activeIndex: number;
	onNavigate: (nextIndex: number) => void;
	onClose: () => void;
}) {
	const item = items[activeIndex];
	const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

	useEffect(() => {
		setSaveState('idle');
	}, [item?.id]);

	const handleSave = useCallback(async () => {
		if (!item) {
			return;
		}

		const destinationPath = await window.maestro.dialog.saveFile({
			defaultPath: item.filename,
			filters: buildArtifactFilters(item.filename),
			title: 'Save demo media',
		});
		if (!destinationPath) {
			return;
		}

		setSaveState('saving');
		const result = await window.maestro.artifacts.exportArtifact(item.artifactId, destinationPath);
		setSaveState(result.success ? 'saved' : 'error');
		window.setTimeout(() => setSaveState('idle'), result.success ? 1800 : 2400);
	}, [item]);

	if (!item) {
		return null;
	}

	const canNavigate = items.length > 1 && item.kind === 'image';

	return createPortal(
		<div
			className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/95"
			onClick={onClose}
		>
			{canNavigate ? (
				<button
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						onNavigate(Math.max(0, activeIndex - 1));
					}}
					disabled={activeIndex === 0}
					className="absolute left-5 top-1/2 z-[2] -translate-y-1/2 rounded-full p-3 transition-colors"
					style={{
						border: '1px solid rgba(255, 255, 255, 0.16)',
						background: 'rgba(15, 23, 42, 0.58)',
						color: '#fff',
						opacity: activeIndex === 0 ? 0.42 : 1,
						cursor: activeIndex === 0 ? 'default' : 'pointer',
					}}
					aria-label="Previous image"
				>
					<ChevronLeft className="h-5 w-5" />
				</button>
			) : null}

			<div
				className="absolute top-5 left-5 right-5 z-[2] flex items-center justify-between gap-3"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="min-w-0">
					<div className="truncate text-sm font-semibold text-white">{item.alt}</div>
					<div className="mt-1 text-xs text-white/60">
						{item.kind === 'image' && canNavigate
							? `Image ${activeIndex + 1} of ${items.length}`
							: item.kind === 'video'
								? 'Video preview'
								: 'Image preview'}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={handleSave}
						className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors"
						style={{
							border: '1px solid rgba(255, 255, 255, 0.16)',
							background: 'rgba(15, 23, 42, 0.58)',
							color: '#fff',
						}}
					>
						<Download className="h-4 w-4" />
						{saveState === 'saving'
							? 'Saving...'
							: saveState === 'saved'
								? 'Saved'
								: saveState === 'error'
									? 'Retry'
									: 'Save'}
					</button>
					<button
						type="button"
						onClick={onClose}
						className="rounded-full p-3 transition-colors"
						style={{
							border: '1px solid rgba(255, 255, 255, 0.16)',
							background: 'rgba(15, 23, 42, 0.58)',
							color: '#fff',
						}}
						aria-label="Close media preview"
					>
						<X className="h-5 w-5" />
					</button>
				</div>
			</div>

			<div
				className="relative z-[1] flex h-full w-full items-center justify-center px-20 py-24"
				onClick={(event) => event.stopPropagation()}
			>
				{item.kind === 'video' ? (
					<video
						controls
						autoPlay
						preload="metadata"
						poster={item.posterSrc || undefined}
						src={item.src}
						style={{
							maxWidth: '100%',
							maxHeight: '100%',
							borderRadius: '24px',
							backgroundColor: '#020617',
							boxShadow: '0 24px 64px rgba(0, 0, 0, 0.38)',
						}}
					/>
				) : (
					<img
						src={item.src}
						alt={item.alt}
						style={{
							maxWidth: '100%',
							maxHeight: '100%',
							borderRadius: '24px',
							objectFit: 'contain',
							boxShadow: '0 24px 64px rgba(0, 0, 0, 0.38)',
						}}
					/>
				)}
			</div>

			{canNavigate ? (
				<button
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						onNavigate(Math.min(items.length - 1, activeIndex + 1));
					}}
					disabled={activeIndex >= items.length - 1}
					className="absolute right-5 top-1/2 z-[2] -translate-y-1/2 rounded-full p-3 transition-colors"
					style={{
						border: '1px solid rgba(255, 255, 255, 0.16)',
						background: 'rgba(15, 23, 42, 0.58)',
						color: '#fff',
						opacity: activeIndex >= items.length - 1 ? 0.42 : 1,
						cursor: activeIndex >= items.length - 1 ? 'default' : 'pointer',
					}}
					aria-label="Next image"
				>
					<ChevronRight className="h-5 w-5" />
				</button>
			) : null}
		</div>,
		document.body
	);
}

export function DemoViewerModal({ theme, demoId, onClose }: DemoViewerModalProps) {
	const [demo, setDemo] = useState<DemoDetail | null>(null);
	const [posterDataUrl, setPosterDataUrl] = useState<string | null>(null);
	const [videoSrc, setVideoSrc] = useState<string | null>(null);
	const [stepImages, setStepImages] = useState<Record<string, string>>({});
	const [lightbox, setLightbox] = useState<{ items: DesktopDemoMediaItem[]; index: number } | null>(
		null
	);
	const overlayRef = useRef<HTMLDivElement>(null);

	const handleEscape = useCallback(() => {
		if (lightbox) {
			setLightbox(null);
			return;
		}
		onClose();
	}, [lightbox, onClose]);

	useModalLayer(MODAL_PRIORITIES.SAVE_MARKDOWN, demo?.title || 'Demo viewer', handleEscape, {
		focusTrap: 'lenient',
	});

	useEffect(() => {
		requestAnimationFrame(() => {
			overlayRef.current?.focus();
		});
	}, []);

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
		void window.maestro.artifacts.loadArtifact(videoArtifactId).then((dataUrl) => {
			if (!cancelled) {
				setVideoSrc(dataUrl);
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

	const imageItems = useMemo(() => {
		if (!demo) {
			return [] as DesktopDemoMediaItem[];
		}

		const items: DesktopDemoMediaItem[] = [];
		const seenArtifactIds = new Set<string>();
		const pushImage = (
			artifactId: string,
			filename: string,
			alt: string,
			src: string | null | undefined
		) => {
			if (!src || seenArtifactIds.has(artifactId)) {
				return;
			}
			seenArtifactIds.add(artifactId);
			items.push({
				id: artifactId,
				artifactId,
				kind: 'image',
				src,
				alt,
				filename,
			});
		};

		if (demo.posterArtifact?.id) {
			pushImage(demo.posterArtifact.id, demo.posterArtifact.filename, demo.title, posterDataUrl);
		}

		for (const step of demo.steps) {
			if (step.screenshotArtifact?.id) {
				pushImage(
					step.screenshotArtifact.id,
					step.screenshotArtifact.filename,
					step.title,
					stepImages[step.id]
				);
			}
		}

		return items;
	}, [demo, posterDataUrl, stepImages]);

	const videoItem = useMemo(() => {
		if (!demo?.videoArtifact?.id || !videoSrc) {
			return null;
		}
		return {
			id: demo.videoArtifact.id,
			artifactId: demo.videoArtifact.id,
			kind: 'video' as const,
			src: videoSrc,
			alt: demo.title,
			filename: demo.videoArtifact.filename,
			posterSrc: posterDataUrl,
		};
	}, [demo, posterDataUrl, videoSrc]);

	const openImageGallery = useCallback(
		(artifactId: string) => {
			const index = imageItems.findIndex((item) => item.id === artifactId);
			if (index >= 0) {
				setLightbox({ items: imageItems, index });
			}
		},
		[imageItems]
	);

	const openVideoPreview = useCallback(() => {
		if (videoItem) {
			setLightbox({ items: [videoItem], index: 0 });
		}
	}, [videoItem]);

	return createPortal(
		<div
			ref={overlayRef}
			className="fixed inset-0 z-[10000] outline-none"
			tabIndex={-1}
			role="dialog"
			aria-modal="true"
			aria-label={demo?.title || 'Demo viewer'}
			onKeyDown={(event) => event.stopPropagation()}
		>
			<div className="absolute inset-0 bg-slate-950/80 backdrop-blur-xl" onClick={onClose} />
			<div className="relative flex h-full w-full items-center justify-center p-6">
				<div
					className="flex h-full max-h-[92vh] w-full max-w-[1120px] flex-col overflow-hidden rounded-[28px] border shadow-2xl"
					style={{
						background: `linear-gradient(180deg, ${theme.colors.bgSidebar} 0%, ${theme.colors.bgMain} 100%)`,
						borderColor: theme.colors.border,
					}}
					onClick={(event) => event.stopPropagation()}
				>
					<div
						className="flex items-center justify-between gap-4 border-b px-6 py-5"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="min-w-0">
							<div
								className="text-[11px] font-semibold uppercase tracking-[0.18em]"
								style={{ color: theme.colors.textDim }}
							>
								Demo
							</div>
							<div
								className="truncate text-xl font-semibold"
								style={{ color: theme.colors.textMain }}
							>
								{demo?.title || 'Loading demo'}
							</div>
						</div>
						<button
							type="button"
							onClick={onClose}
							className="rounded-full p-3 transition-colors hover:bg-white/10"
							style={{ color: theme.colors.textMain }}
							aria-label="Close demo viewer"
						>
							<X className="h-5 w-5" />
						</button>
					</div>

					<div className="flex-1 overflow-y-auto px-6 py-5">
						<div className="mx-auto flex w-full max-w-[920px] flex-col gap-4">
							{videoItem ? (
								<div
									className="relative overflow-hidden rounded-[20px]"
									style={{
										border: `1px solid ${theme.colors.border}`,
										backgroundColor: '#020617',
									}}
								>
									<video
										controls
										preload="metadata"
										poster={posterDataUrl || undefined}
										src={videoSrc || undefined}
										style={{
											width: '100%',
											maxHeight: 'min(56vh, 520px)',
											display: 'block',
											objectFit: 'contain',
											backgroundColor: '#020617',
										}}
									/>
									<button
										type="button"
										onClick={openVideoPreview}
										className="absolute right-4 bottom-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
										style={{
											background: 'rgba(15, 23, 42, 0.72)',
											color: '#fff',
											border: '1px solid rgba(255, 255, 255, 0.14)',
										}}
									>
										<Expand className="h-4 w-4" />
										Open full screen
									</button>
								</div>
							) : posterDataUrl && demo?.posterArtifact?.id ? (
								<button
									type="button"
									onClick={() => openImageGallery(demo.posterArtifact!.id)}
									className="relative block w-full cursor-zoom-in overflow-hidden rounded-[20px] p-0"
									style={{
										background: '#020617',
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									<img
										src={posterDataUrl}
										alt={demo?.title || 'Demo'}
										style={{
											width: '100%',
											maxHeight: 'min(56vh, 520px)',
											display: 'block',
											objectFit: 'contain',
										}}
									/>
									<div
										className="absolute right-4 bottom-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
										style={{
											background: 'rgba(15, 23, 42, 0.72)',
											color: '#fff',
											border: '1px solid rgba(255, 255, 255, 0.14)',
										}}
									>
										<Expand className="h-4 w-4" />
										Click to zoom
									</div>
								</button>
							) : null}

							{demo?.summary ? (
								<div className="text-sm leading-6" style={{ color: theme.colors.textMain }}>
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
										className="rounded-2xl border p-4"
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
										{stepImages[step.id] && step.screenshotArtifact?.id ? (
											<button
												type="button"
												onClick={() => openImageGallery(step.screenshotArtifact!.id)}
												className="relative mt-3 block w-full cursor-zoom-in overflow-hidden rounded-2xl p-0"
												style={{ background: 'transparent' }}
											>
												<img
													src={stepImages[step.id]}
													alt={step.title}
													style={{
														width: '100%',
														borderRadius: '16px',
														border: `1px solid ${theme.colors.border}`,
													}}
												/>
												<div
													className="absolute right-3 bottom-3 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold"
													style={{
														background: 'rgba(15, 23, 42, 0.72)',
														color: '#fff',
														border: '1px solid rgba(255, 255, 255, 0.14)',
													}}
												>
													<Expand className="h-3.5 w-3.5" />
													Zoom
												</div>
											</button>
										) : null}
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>

			{lightbox ? (
				<DemoMediaLightbox
					items={lightbox.items}
					activeIndex={lightbox.index}
					onNavigate={(index) =>
						setLightbox((current) => (current ? { ...current, index } : current))
					}
					onClose={() => setLightbox(null)}
				/>
			) : null}
		</div>,
		document.body
	);
}
