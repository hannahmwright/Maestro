import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Expand, X } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import type { DemoDetail } from '../../shared/demo-artifacts';
import { buildApiUrl } from '../utils/config';

interface MobileDemoViewerProps {
	demoId: string;
	onClose: () => void;
}

interface MobileDemoMediaItem {
	id: string;
	kind: 'image' | 'video';
	src: string;
	alt: string;
	filename: string;
	posterSrc?: string | null;
}

interface ZoomState {
	scale: number;
	offsetX: number;
	offsetY: number;
}

interface TouchGestureState {
	mode: 'none' | 'pan' | 'pinch';
	startScale: number;
	startOffsetX: number;
	startOffsetY: number;
	startDistance: number;
	startCenterX: number;
	startCenterY: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function getTouchDistance(touches: React.TouchList): number {
	if (touches.length < 2) return 0;
	const dx = touches[0].clientX - touches[1].clientX;
	const dy = touches[0].clientY - touches[1].clientY;
	return Math.hypot(dx, dy);
}

function getTouchCenter(touches: React.TouchList): { x: number; y: number } {
	if (touches.length === 0) {
		return { x: 0, y: 0 };
	}
	if (touches.length === 1) {
		return { x: touches[0].clientX, y: touches[0].clientY };
	}
	return {
		x: (touches[0].clientX + touches[1].clientX) / 2,
		y: (touches[0].clientY + touches[1].clientY) / 2,
	};
}

function clampZoomOffsets(
	nextScale: number,
	nextOffsetX: number,
	nextOffsetY: number,
	container: HTMLDivElement | null,
	image: HTMLImageElement | null
): { offsetX: number; offsetY: number } {
	if (!container || !image || nextScale <= 1) {
		return { offsetX: 0, offsetY: 0 };
	}

	const containerRect = container.getBoundingClientRect();
	const imageWidth = image.clientWidth;
	const imageHeight = image.clientHeight;
	const maxOffsetX = Math.max(0, (imageWidth * nextScale - containerRect.width) / 2);
	const maxOffsetY = Math.max(0, (imageHeight * nextScale - containerRect.height) / 2);

	return {
		offsetX: clamp(nextOffsetX, -maxOffsetX, maxOffsetX),
		offsetY: clamp(nextOffsetY, -maxOffsetY, maxOffsetY),
	};
}

function ZoomableImage({ src, alt }: { src: string; alt: string }) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const imageRef = useRef<HTMLImageElement | null>(null);
	const gestureRef = useRef<TouchGestureState>({
		mode: 'none',
		startScale: 1,
		startOffsetX: 0,
		startOffsetY: 0,
		startDistance: 0,
		startCenterX: 0,
		startCenterY: 0,
	});
	const lastTapRef = useRef<{ timestamp: number; x: number; y: number } | null>(null);
	const [zoom, setZoom] = useState<ZoomState>({
		scale: 1,
		offsetX: 0,
		offsetY: 0,
	});

	const updateZoom = useCallback((nextScale: number, nextOffsetX: number, nextOffsetY: number) => {
		const constrainedScale = clamp(nextScale, 1, 4);
		const constrainedOffsets = clampZoomOffsets(
			constrainedScale,
			nextOffsetX,
			nextOffsetY,
			containerRef.current,
			imageRef.current
		);
		setZoom({
			scale: constrainedScale,
			offsetX: constrainedOffsets.offsetX,
			offsetY: constrainedOffsets.offsetY,
		});
	}, []);

	useEffect(() => {
		setZoom({ scale: 1, offsetX: 0, offsetY: 0 });
		lastTapRef.current = null;
		gestureRef.current = {
			mode: 'none',
			startScale: 1,
			startOffsetX: 0,
			startOffsetY: 0,
			startDistance: 0,
			startCenterX: 0,
			startCenterY: 0,
		};
	}, [src]);

	const handleTouchStart = useCallback(
		(event: React.TouchEvent<HTMLDivElement>) => {
			event.stopPropagation();
			if (event.touches.length >= 2) {
				const center = getTouchCenter(event.touches);
				gestureRef.current = {
					mode: 'pinch',
					startScale: zoom.scale,
					startOffsetX: zoom.offsetX,
					startOffsetY: zoom.offsetY,
					startDistance: getTouchDistance(event.touches),
					startCenterX: center.x,
					startCenterY: center.y,
				};
				return;
			}

			if (event.touches.length === 1 && zoom.scale > 1) {
				const center = getTouchCenter(event.touches);
				gestureRef.current = {
					mode: 'pan',
					startScale: zoom.scale,
					startOffsetX: zoom.offsetX,
					startOffsetY: zoom.offsetY,
					startDistance: 0,
					startCenterX: center.x,
					startCenterY: center.y,
				};
			}
		},
		[zoom]
	);

	const handleTouchMove = useCallback(
		(event: React.TouchEvent<HTMLDivElement>) => {
			event.stopPropagation();
			if (event.touches.length >= 2) {
				event.preventDefault();
				const currentDistance = getTouchDistance(event.touches);
				const center = getTouchCenter(event.touches);
				const gesture = gestureRef.current;
				const nextScale = gesture.startDistance
					? gesture.startScale * (currentDistance / gesture.startDistance)
					: gesture.startScale;
				const nextOffsetX = gesture.startOffsetX + (center.x - gesture.startCenterX);
				const nextOffsetY = gesture.startOffsetY + (center.y - gesture.startCenterY);
				updateZoom(nextScale, nextOffsetX, nextOffsetY);
				return;
			}

			if (event.touches.length === 1 && gestureRef.current.mode === 'pan' && zoom.scale > 1) {
				event.preventDefault();
				const center = getTouchCenter(event.touches);
				const gesture = gestureRef.current;
				const nextOffsetX = gesture.startOffsetX + (center.x - gesture.startCenterX);
				const nextOffsetY = gesture.startOffsetY + (center.y - gesture.startCenterY);
				updateZoom(zoom.scale, nextOffsetX, nextOffsetY);
			}
		},
		[updateZoom, zoom.scale]
	);

	const handleTouchEnd = useCallback(
		(event: React.TouchEvent<HTMLDivElement>) => {
			event.stopPropagation();

			if (event.touches.length >= 2) {
				const center = getTouchCenter(event.touches);
				gestureRef.current = {
					mode: 'pinch',
					startScale: zoom.scale,
					startOffsetX: zoom.offsetX,
					startOffsetY: zoom.offsetY,
					startDistance: getTouchDistance(event.touches),
					startCenterX: center.x,
					startCenterY: center.y,
				};
				return;
			}

			if (event.touches.length === 1 && zoom.scale > 1) {
				const center = getTouchCenter(event.touches);
				gestureRef.current = {
					mode: 'pan',
					startScale: zoom.scale,
					startOffsetX: zoom.offsetX,
					startOffsetY: zoom.offsetY,
					startDistance: 0,
					startCenterX: center.x,
					startCenterY: center.y,
				};
				return;
			}

			if (event.changedTouches.length === 1) {
				const touch = event.changedTouches[0];
				const now = Date.now();
				const lastTap = lastTapRef.current;
				const withinDoubleTapWindow =
					lastTap &&
					now - lastTap.timestamp < 280 &&
					Math.abs(lastTap.x - touch.clientX) < 24 &&
					Math.abs(lastTap.y - touch.clientY) < 24;

				if (withinDoubleTapWindow) {
					if (zoom.scale > 1) {
						updateZoom(1, 0, 0);
					} else {
						updateZoom(2, 0, 0);
					}
					lastTapRef.current = null;
				} else {
					lastTapRef.current = {
						timestamp: now,
						x: touch.clientX,
						y: touch.clientY,
					};
				}
			}

			gestureRef.current = {
				mode: 'none',
				startScale: zoom.scale,
				startOffsetX: zoom.offsetX,
				startOffsetY: zoom.offsetY,
				startDistance: 0,
				startCenterX: 0,
				startCenterY: 0,
			};
		},
		[updateZoom, zoom]
	);

	return (
		<div
			ref={containerRef}
			onTouchStart={handleTouchStart}
			onTouchMove={handleTouchMove}
			onTouchEnd={handleTouchEnd}
			onTouchCancel={handleTouchEnd}
			style={{
				width: '100%',
				height: '100%',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				overflow: 'hidden',
				touchAction: 'none',
			}}
		>
			<img
				ref={imageRef}
				src={src}
				alt={alt}
				style={{
					maxWidth: '100%',
					maxHeight: '100%',
					borderRadius: '24px',
					objectFit: 'contain',
					boxShadow: '0 24px 64px rgba(0, 0, 0, 0.38)',
					transform: `translate3d(${zoom.offsetX}px, ${zoom.offsetY}px, 0) scale(${zoom.scale})`,
					transformOrigin: 'center center',
					transition: gestureRef.current.mode === 'none' ? 'transform 180ms ease-out' : 'none',
					willChange: 'transform',
				}}
			/>
		</div>
	);
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

async function downloadMediaItem(item: MobileDemoMediaItem): Promise<void> {
	const response = await fetch(item.src);
	if (!response.ok) {
		throw new Error(`Failed to download media (${response.status})`);
	}

	const blob = await response.blob();
	const objectUrl = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = objectUrl;
		link.download = item.filename;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

function MobileMediaLightbox({
	items,
	activeIndex,
	onNavigate,
	onClose,
}: {
	items: MobileDemoMediaItem[];
	activeIndex: number;
	onNavigate: (nextIndex: number) => void;
	onClose: () => void;
}) {
	const item = items[activeIndex];
	const [downloadState, setDownloadState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

	useEffect(() => {
		setDownloadState('idle');
	}, [item?.id]);

	const handleDownload = useCallback(async () => {
		if (!item) return;
		setDownloadState('saving');
		try {
			await downloadMediaItem(item);
			setDownloadState('saved');
			window.setTimeout(() => setDownloadState('idle'), 1800);
		} catch {
			setDownloadState('error');
			window.setTimeout(() => setDownloadState('idle'), 2400);
		}
	}, [item]);

	if (!item) {
		return null;
	}

	const canNavigate = items.length > 1 && item.kind === 'image';

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 1260,
				background: 'rgba(2, 6, 23, 0.94)',
				backdropFilter: 'blur(18px)',
				WebkitBackdropFilter: 'blur(18px)',
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			<div
				style={{
					position: 'relative',
					zIndex: 2,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: '12px',
					padding: 'calc(14px + env(safe-area-inset-top, 0px)) 16px 12px',
				}}
			>
				<button
					type="button"
					onClick={onClose}
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						gap: '8px',
						borderRadius: '999px',
						border: '1px solid rgba(255, 255, 255, 0.16)',
						background: 'rgba(15, 23, 42, 0.58)',
						color: '#fff',
						padding: '10px 14px',
						fontSize: '13px',
						fontWeight: 600,
						cursor: 'pointer',
					}}
				>
					<ArrowLeft size={16} />
					Back
				</button>
				<div
					style={{
						minWidth: 0,
						flex: 1,
						textAlign: 'center',
						color: '#fff',
						fontSize: '13px',
						fontWeight: 600,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					{item.alt}
				</div>
				<button
					type="button"
					onClick={handleDownload}
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						gap: '8px',
						borderRadius: '999px',
						border: '1px solid rgba(255, 255, 255, 0.16)',
						background: 'rgba(15, 23, 42, 0.58)',
						color: '#fff',
						padding: '10px 14px',
						fontSize: '13px',
						fontWeight: 600,
						cursor: 'pointer',
					}}
				>
					<Download size={16} />
					{downloadState === 'saving'
						? 'Saving...'
						: downloadState === 'saved'
							? 'Saved'
							: downloadState === 'error'
								? 'Retry'
								: 'Save'}
				</button>
			</div>

			<div
				style={{
					flex: 1,
					position: 'relative',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					padding: '12px 16px calc(24px + env(safe-area-inset-bottom, 0px))',
				}}
			>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close media preview"
					style={{ position: 'absolute', inset: 0, border: 'none', background: 'transparent' }}
				/>
				{canNavigate ? (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onNavigate(Math.max(0, activeIndex - 1));
						}}
						disabled={activeIndex === 0}
						aria-label="Previous image"
						style={{
							position: 'absolute',
							left: '10px',
							top: '50%',
							transform: 'translateY(-50%)',
							width: '42px',
							height: '42px',
							borderRadius: '999px',
							border: '1px solid rgba(255, 255, 255, 0.16)',
							background: 'rgba(15, 23, 42, 0.58)',
							color: '#fff',
							cursor: activeIndex === 0 ? 'default' : 'pointer',
							opacity: activeIndex === 0 ? 0.42 : 1,
							zIndex: 1,
						}}
					>
						<ChevronLeft size={18} />
					</button>
				) : null}
				<div
					onClick={(event) => event.stopPropagation()}
					style={{
						position: 'relative',
						zIndex: 1,
						width: '100%',
						height: '100%',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						overflow: 'auto',
						touchAction: item.kind === 'image' ? 'none' : 'pan-x pan-y pinch-zoom',
					}}
				>
					{item.kind === 'video' ? (
						<video
							controls
							autoPlay
							preload="metadata"
							poster={item.posterSrc || undefined}
							src={item.src}
							style={{
								width: '100%',
								maxHeight: '100%',
								borderRadius: '24px',
								background: '#020617',
								boxShadow: '0 24px 64px rgba(0, 0, 0, 0.38)',
							}}
						/>
					) : (
						<ZoomableImage src={item.src} alt={item.alt} />
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
						aria-label="Next image"
						style={{
							position: 'absolute',
							right: '10px',
							top: '50%',
							transform: 'translateY(-50%)',
							width: '42px',
							height: '42px',
							borderRadius: '999px',
							border: '1px solid rgba(255, 255, 255, 0.16)',
							background: 'rgba(15, 23, 42, 0.58)',
							color: '#fff',
							cursor: activeIndex >= items.length - 1 ? 'default' : 'pointer',
							opacity: activeIndex >= items.length - 1 ? 0.42 : 1,
							zIndex: 1,
						}}
					>
						<ChevronRight size={18} />
					</button>
				) : null}
			</div>

			<div
				style={{
					padding: '0 18px calc(16px + env(safe-area-inset-bottom, 0px))',
					color: 'rgba(255, 255, 255, 0.72)',
					fontSize: '12px',
					textAlign: 'center',
				}}
			>
				{item.kind === 'image'
					? canNavigate
						? `Image ${activeIndex + 1} of ${items.length}`
						: 'Pinch to zoom and drag • Double tap to reset • Tap Save to keep a copy'
					: 'Tap Save to keep a copy'}
			</div>
		</div>
	);
}

export function MobileDemoViewer({ demoId, onClose }: MobileDemoViewerProps) {
	const colors = useThemeColors();
	const [demo, setDemo] = useState<DemoDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [mediaViewer, setMediaViewer] = useState<{ items: MobileDemoMediaItem[]; index: number } | null>(
		null
	);

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
	const posterUrl = useMemo(
		() => artifactUrl(demo?.posterArtifact?.id),
		[demo?.posterArtifact?.id]
	);
	const hasStepScreenshots = useMemo(
		() => Boolean(demo?.steps.some((step) => step.screenshotArtifact?.id)),
		[demo]
	);
	const showPosterHero = Boolean(!videoUrl && posterUrl && demo?.posterArtifact?.id && !hasStepScreenshots);

	const imageItems = useMemo(() => {
		if (!demo) {
			return [] as MobileDemoMediaItem[];
		}

		const items: MobileDemoMediaItem[] = [];
		const seenArtifactIds = new Set<string>();
		const pushImage = (artifactId: string, filename: string, alt: string, src: string | null) => {
			if (!src || seenArtifactIds.has(artifactId)) {
				return;
			}
			seenArtifactIds.add(artifactId);
			items.push({
				id: artifactId,
				kind: 'image',
				src,
				alt,
				filename,
			});
		};

		if (showPosterHero && demo.posterArtifact?.id) {
			pushImage(demo.posterArtifact.id, demo.posterArtifact.filename, demo.title, posterUrl);
		}

		for (const step of demo.steps) {
			if (step.screenshotArtifact?.id) {
				pushImage(
					step.screenshotArtifact.id,
					step.screenshotArtifact.filename,
					step.title,
					artifactUrl(step.screenshotArtifact.id)
				);
			}
		}

		return items;
	}, [demo, posterUrl, showPosterHero]);

	const videoItem = useMemo(() => {
		if (!demo?.videoArtifact?.id || !videoUrl) {
			return null;
		}
		return {
			id: demo.videoArtifact.id,
			kind: 'video' as const,
			src: videoUrl,
			alt: demo.title,
			filename: demo.videoArtifact.filename,
			posterSrc: posterUrl,
		};
	}, [demo, posterUrl, videoUrl]);

	const posterArtifactId = demo?.posterArtifact?.id || null;

	const openImageGallery = useCallback(
		(artifactId: string) => {
			const index = imageItems.findIndex((item) => item.id === artifactId);
			if (index >= 0) {
				setMediaViewer({ items: imageItems, index });
			}
		},
		[imageItems]
	);

	const openVideoViewer = useCallback(() => {
		if (videoItem) {
			setMediaViewer({ items: [videoItem], index: 0 });
		}
	}, [videoItem]);

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 1220,
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
						gap: '12px',
						padding: 'calc(16px + env(safe-area-inset-top, 0px)) 18px 12px',
						borderBottom: `1px solid ${colors.border}`,
					}}
				>
					<button
						type="button"
						onClick={onClose}
						style={{
							display: 'inline-flex',
							alignItems: 'center',
							gap: '8px',
							border: `1px solid ${colors.border}`,
							background: `${colors.bgMain}cc`,
							color: colors.textMain,
							borderRadius: '999px',
							padding: '9px 13px',
							fontSize: '12px',
							fontWeight: 700,
							cursor: 'pointer',
							flexShrink: 0,
						}}
					>
						<ArrowLeft size={15} />
						Back to thread
					</button>
					<div style={{ minWidth: 0, flex: 1 }}>
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
						aria-label="Dismiss demo viewer"
						style={{
							width: '38px',
							height: '38px',
							border: `1px solid ${colors.border}`,
							background: `${colors.bgMain}cc`,
							color: colors.textMain,
							borderRadius: '999px',
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							cursor: 'pointer',
							flexShrink: 0,
						}}
					>
						<X size={17} />
					</button>
				</div>

				<div
					style={{
						flex: 1,
						overflowY: 'auto',
						padding: '16px 16px calc(24px + env(safe-area-inset-bottom, 0px))',
						display: 'flex',
						flexDirection: 'column',
						gap: '16px',
					}}
				>
					{isLoading && <div style={{ color: colors.textDim }}>Loading demo...</div>}
					{error && <div style={{ color: colors.error }}>{error}</div>}
					{demo && (
						<>
								{videoItem ? (
									<div style={{ position: 'relative' }}>
										<video
											controls
											preload="metadata"
										poster={posterUrl || undefined}
										src={videoUrl || undefined}
										style={{
											width: '100%',
											borderRadius: '20px',
												background: '#020617',
												border: `1px solid ${colors.border}`,
											}}
										/>
										<button
											type="button"
											onClick={openVideoViewer}
											style={{
												position: 'absolute',
												right: '14px',
											bottom: '14px',
											display: 'inline-flex',
											alignItems: 'center',
											gap: '6px',
											padding: '7px 10px',
											borderRadius: '999px',
											background: 'rgba(15, 23, 42, 0.72)',
												color: '#fff',
												fontSize: '12px',
												fontWeight: 700,
												cursor: 'pointer',
											}}
										>
											<Expand size={14} />
											Open full screen
										</button>
									</div>
								) : showPosterHero ? (
								<button
									type="button"
									onClick={() => openImageGallery(demo.posterArtifact!.id)}
									style={{
										position: 'relative',
										border: 'none',
										padding: 0,
										background: 'transparent',
										cursor: 'pointer',
									}}
									>
										<img
											src={posterUrl || undefined}
											alt={demo.title}
											style={{
											width: '100%',
											borderRadius: '20px',
											border: `1px solid ${colors.border}`,
											display: 'block',
										}}
									/>
									<div
										style={{
											position: 'absolute',
											right: '14px',
											bottom: '14px',
											display: 'inline-flex',
											alignItems: 'center',
											gap: '6px',
											padding: '7px 10px',
											borderRadius: '999px',
											background: 'rgba(15, 23, 42, 0.72)',
											color: '#fff',
											fontSize: '12px',
											fontWeight: 700,
											pointerEvents: 'none',
										}}
									>
										<Expand size={14} />
										Tap to zoom
									</div>
								</button>
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

							{demo.summary && (
								<div style={{ fontSize: '14px', lineHeight: 1.5 }}>{demo.summary}</div>
							)}

							<div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
								{demo.steps.map((step, index) => {
									const screenshotArtifactId = step.screenshotArtifact?.id;
									const screenshotUrl = artifactUrl(screenshotArtifactId);
									const shouldHideDuplicateScreenshot =
										showPosterHero &&
										!!posterArtifactId &&
										screenshotArtifactId === posterArtifactId;
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
											{screenshotUrl &&
												screenshotArtifactId &&
												!shouldHideDuplicateScreenshot && (
												<button
													type="button"
													onClick={() => openImageGallery(screenshotArtifactId)}
													style={{
														position: 'relative',
														border: 'none',
														padding: 0,
														background: 'transparent',
														cursor: 'pointer',
													}}
												>
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
													<div
														style={{
															position: 'absolute',
															right: '12px',
															bottom: '12px',
															display: 'inline-flex',
															alignItems: 'center',
															gap: '6px',
															padding: '7px 10px',
															borderRadius: '999px',
															background: 'rgba(15, 23, 42, 0.72)',
															color: '#fff',
															fontSize: '12px',
															fontWeight: 700,
															pointerEvents: 'none',
														}}
													>
														<Expand size={14} />
														Tap to zoom
													</div>
												</button>
											)}
										</div>
									);
								})}
							</div>
						</>
					)}
				</div>
			</div>

			{mediaViewer ? (
				<MobileMediaLightbox
					items={mediaViewer.items}
					activeIndex={mediaViewer.index}
					onNavigate={(index) =>
						setMediaViewer((current) => (current ? { ...current, index } : current))
					}
					onClose={() => setMediaViewer(null)}
				/>
			) : null}
		</div>
	);
}

export default MobileDemoViewer;
