import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Check, ZoomIn, Loader } from 'lucide-react';

/**
 * Crop an image to the banner's shape before it is uploaded.
 *
 * The carousel draws every banner into a 5:2 box with object-cover, which keeps
 * the centre and throws away whatever does not fit. Upload a tall photo and the
 * subject is simply gone — cropped out by a rule nobody chose and nobody could
 * see. That is the "home is not hiding" problem: the image is not hidden, it is
 * silently trimmed to a shape the uploader never saw.
 *
 * So the crop happens here, against the same 5:2 frame, and what the admin
 * approves is exactly the pixels students get.
 *
 * Deliberately no cropping library. The interaction is drag-to-position plus a
 * zoom slider against one fixed aspect — a few dozen lines of arithmetic — and
 * a dependency for that is more code shipped to every student's phone than the
 * feature itself.
 */

/** Matches the carousel's aspect-[5/2]. Change both together or not at all. */
export const BANNER_ASPECT = 5 / 2;

/** Output width. 1600x640 is sharp on a desktop banner without being enormous. */
const OUT_WIDTH = 1600;

export default function BannerCropper({ file, onCancel, onCropped }) {
  const [img, setImg] = useState(null);
  const [zoom, setZoom] = useState(1);
  // Offset of the image centre from the frame centre, in displayed pixels.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const frameRef = useRef(null);
  const drag = useRef(null);
  /*
   * The frame's pixel size, in state rather than read from the ref at render
   * time.
   *
   * Reading frameRef.current during render is wrong twice over: it is null on
   * the first pass, so the preview opened at the image's natural size instead
   * of covering the frame, and a ref mutation never triggers the re-render that
   * would fix it — the crop only corrected itself if the admin happened to
   * drag. Measured in a layout effect and on resize, it is a value React knows
   * about and can render from.
   */
  const [frame, setFrame] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrame({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setImg(image);
    image.onerror = () => setError('That image could not be read.');
    image.src = url;
    // Revoked once decoded: the bitmap is retained by the Image object, so the
    // blob URL is not needed and leaks the file if left registered.
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /**
   * The scale at which the image exactly covers the frame.
   *
   * Everything else is expressed as a multiple of this, so zoom 1 always means
   * "no empty edges" whatever shape was uploaded, and the crop can never
   * include transparent space.
   */
  const coverScale = useCallback((frameW = frame.w, frameH = frame.h) => {
    if (!img || !frameW || !frameH) return 1;
    return Math.max(frameW / img.naturalWidth, frameH / img.naturalHeight);
  }, [img, frame.w, frame.h]);

  /*
   * Clamp the pan so an edge can never come inside the frame.
   *
   * Without it a drag leaves a strip of background in the banner, which reads
   * as a broken image rather than a crop.
   */
  const clamp = useCallback((next, frameW, frameH) => {
    if (!img) return next;
    const s = coverScale(frameW, frameH) * zoom;
    const maxX = Math.max(0, (img.naturalWidth * s - frameW) / 2);
    const maxY = Math.max(0, (img.naturalHeight * s - frameH) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, [img, zoom, coverScale]);

  // Re-clamp when zooming out, or the image would sit off-centre with a gap.
  useEffect(() => {
    if (!img || !frame.w) return;
    setOffset((o) => clamp(o, frame.w, frame.h));
  }, [zoom, img, frame.w, frame.h, clamp]);

  const pointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: offset };
  };
  const pointerMove = (e) => {
    if (!drag.current || !frame.w) return;
    const next = {
      x: drag.current.start.x + (e.clientX - drag.current.x),
      y: drag.current.start.y + (e.clientY - drag.current.y),
    };
    setOffset(clamp(next, frame.w, frame.h));
  };
  const pointerUp = () => { drag.current = null; };

  /**
   * Draw the visible region to a canvas at output resolution.
   *
   * The maths mirrors the preview exactly: the same cover scale, the same zoom,
   * the same offset, converted from displayed pixels to source pixels. If these
   * two ever disagree the admin approves one image and students get another.
   */
  const apply = async () => {
    if (!img || !frame.w) return;
    setBusy(true);
    setError('');
    try {
      const frameW = frame.w;
      const frameH = frame.h;
      const s = coverScale(frameW, frameH) * zoom;

      // Top-left of the frame in source-image coordinates.
      const sx = (img.naturalWidth * s - frameW) / 2 - offset.x;
      const sy = (img.naturalHeight * s - frameH) / 2 - offset.y;

      const canvas = document.createElement('canvas');
      canvas.width = OUT_WIDTH;
      canvas.height = Math.round(OUT_WIDTH / BANNER_ASPECT);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        img,
        sx / s, sy / s, frameW / s, frameH / s,   // source rect
        0, 0, canvas.width, canvas.height          // destination
      );

      /*
       * JPEG at 0.85. A banner is a photograph, so PNG would be several times
       * the size for no visible gain on a phone screen — and this file is
       * fetched by every student on every visit to the home page.
       */
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
      if (!blob) throw new Error('Could not produce the cropped image.');
      onCropped(new File([blob], 'banner.jpg', { type: 'image/jpeg' }));
    } catch (err) {
      setError(err.message || 'Could not crop that image.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-3">
      <div className="w-full max-w-2xl bg-white border-2 border-black rounded-2xl shadow-[4px_4px_0px_0px_#111] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b-2 border-black bg-[#A7E2D1]">
          <h2 className="font-black text-sm uppercase">Position the banner</h2>
          <button onClick={onCancel} aria-label="Cancel" className="w-7 h-7 flex items-center justify-center border-2 border-black rounded-full bg-white">
            <X size={14} strokeWidth={3} />
          </button>
        </div>

        <div className="p-3">
          <p className="text-[11px] font-bold text-gray-500 mb-2">
            Drag to move, slide to zoom. Everything inside the frame is what students see.
          </p>

          {/*
            The frame is the carousel's shape, so this preview is the crop —
            not an approximation of it.
          */}
          <div
            ref={frameRef}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            className="relative w-full aspect-[5/2] overflow-hidden rounded-xl border-2 border-black bg-gray-100 cursor-move touch-none select-none"
          >
            {img ? (
              <img
                src={img.src}
                alt=""
                draggable={false}
                className="absolute left-1/2 top-1/2 max-w-none"
                style={{
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                  transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${coverScale() * zoom})`,
                }}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center font-bold text-gray-400 text-sm">
                {error || 'Loading…'}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 mt-3">
            <ZoomIn size={15} strokeWidth={3} className="shrink-0 text-gray-500" />
            <input
              type="range"
              min="1" max="3" step="0.01"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label="Zoom"
              className="flex-1 accent-[#F26B4D]"
            />
          </div>

          {error && img && (
            <p role="alert" className="mt-2 text-xs font-bold text-red-600">{error}</p>
          )}

          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={onCancel}
              className="h-9 px-3 border-2 border-black rounded-xl bg-white font-bold text-sm shadow-[2px_2px_0px_0px_#111]"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={!img || busy}
              className="h-9 px-3 flex items-center gap-1.5 border-2 border-black rounded-xl bg-[#A7E2D1] font-bold text-sm shadow-[2px_2px_0px_0px_#111] disabled:opacity-60"
            >
              {busy ? <Loader size={14} className="animate-spin" /> : <Check size={14} strokeWidth={3} />}
              {busy ? 'Cropping…' : 'Use this'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
