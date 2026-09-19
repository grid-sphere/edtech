import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
/*
 * ?worker, not ?url.
 *
 * ?url emits the worker as a .mjs asset and lets the browser fetch it as a
 * module script. That requires the web server to send .mjs as JavaScript —
 * many send application/octet-stream, and Chrome then refuses it outright
 * ("Strict MIME type checking is enforced for module scripts"). pdf.js falls
 * back to a "fake worker", which then fails too, and nothing renders.
 *
 * ?worker makes Vite bundle it into an ordinary .js chunk and hands us a
 * Worker constructor, so the MIME type of .mjs stops mattering.
 */
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

// workerPort takes a live Worker; workerSrc takes a URL. Using the port avoids
// the fetch entirely.
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

/**
 * Render a PDF to canvases instead of handing it to the browser.
 *
 * An <iframe> only shows a document on platforms with a built-in PDF viewer.
 * Desktop Chrome has one; Android Chrome does not, and instead shows a stub
 * with the blob's UUID and an "Open" button — so the same code looked fine on a
 * laptop and broken on a phone, which is exactly where students read.
 *
 * Drawing the pages ourselves removes that dependency: identical output on
 * every device, and no native toolbar offering print or download.
 *
 * @param {ArrayBuffer} data raw PDF bytes
 */

/*
 * Zoom bounds. Below 0.5 the text is unreadable anyway; above 3 a large page at
 * 2x device pixel ratio is a canvas big enough to be refused on a mid-range
 * phone, and pdf.js fails with an opaque canvas error rather than anything a
 * student could act on.
 */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

export default function PdfCanvasViewer({ data, title }) {
  const containerRef = useRef(null);
  const [doc, setDoc] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [pageCount, setPageCount] = useState(0);
  /*
   * 1 means fit-to-width, which is where this started and where it stays until
   * the reader asks for more.
   *
   * Zoom re-renders rather than scaling the existing canvas with CSS. A
   * transform would enlarge the pixels already drawn, so the small print a
   * student zoomed in to read would get blurrier the closer they looked —
   * which is the one thing zoom exists to prevent.
   */
  const [zoom, setZoom] = useState(1);

  /*
   * The last destroy(), parked so the next load can wait for it.
   *
   * pdf.js caches one PDFWorker per port, and every document here shares the
   * single module-level worker. destroy() marks that cached worker
   * _pendingDestroy, and any getDocument() arriving before it settles throws
   * "PDFWorker.fromPort - the worker is being destroyed."
   *
   * So fire-and-forget cleanup breaks the *next* document rather than the one
   * being closed. That was already true — closing one PDF and opening another
   * quickly could fail — but zoom made it fire every time, because the old code
   * destroyed and reloaded the document on every zoom change.
   */
  const teardown = useRef(Promise.resolve());

  /* ------------------------------------------------------------------ load
   *
   * Keyed on the bytes alone. Zoom must not reload the document: re-parsing a
   * 200-page PDF on every press of "+" is slow, and doing it while the previous
   * destroy is still in flight is what produced the worker error.
   */
  useEffect(() => {
    if (!data) return;

    let cancelled = false;
    let task = null;

    (async () => {
      setStatus('loading');
      setDoc(null);
      try {
        await teardown.current;
        if (cancelled) return;

        // pdf.js takes ownership of the buffer it is given and detaches it, so
        // a copy is passed — otherwise re-opening the same document throws
        // "Cannot perform Construct on a detached ArrayBuffer".
        task = pdfjsLib.getDocument({ data: data.slice(0) });
        const loaded = await task.promise;

        if (cancelled) {
          teardown.current = task.destroy();
          return;
        }
        setPageCount(loaded.numPages);
        setDoc(loaded);
      } catch (err) {
        if (cancelled) return;
        console.error('[PdfCanvasViewer] load', err);
        setError(err?.message || 'Could not display this PDF.');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      // Recorded, not awaited — a cleanup function cannot be async, so the
      // promise is parked where the next load will wait on it.
      if (task) teardown.current = task.destroy();
    };
  }, [data]);

  /* ---------------------------------------------------------------- render
   *
   * Redraws every page at the current zoom. Separate from loading, so a zoom
   * change costs a redraw and not a re-parse.
   */
  useEffect(() => {
    if (!doc) return;

    let cancelled = false;

    (async () => {
      setStatus('loading');
      try {
        const container = containerRef.current;
        if (!container) {
          /*
           * Bailing silently here left status on 'loading' — set three lines
           * above and never cleared — so the reader sat on "Rendering
           * document..." indefinitely with nothing in the console. A spinner
           * that never resolves is the worst failure to be handed a bug report
           * about, because it looks identical to a large PDF still working.
           */
          setError('The viewer could not attach to the page.');
          setStatus('error');
          return;
        }
        container.innerHTML = '';

        const available = container.clientWidth || 800;

        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;

          const unscaled = page.getViewport({ scale: 1 });

          // Render above CSS size so text stays sharp on high-density screens,
          // but cap it — a 4x canvas of a large page exhausts mobile memory.
          const fit = available / unscaled.width;
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          /*
           * Total scale is capped as well as zoom. fit can already exceed 1 on
           * a wide screen with a small page, so fit x zoom x dpr can reach a
           * canvas area the browser refuses to allocate even within MAX_ZOOM.
           */
          const scale = Math.min(fit * zoom * dpr, 6);
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          /*
           * Width in percent of the container, so at zoom 1 the page fits
           * exactly as before and above 1 it overflows into the horizontal
           * scroll the wrapper provides. No `w-full` in the class list: a
           * Tailwind width utility would override this and pin every page back
           * to the container, which is what stopped zoom working at all.
           */
          canvas.style.width = `${100 * zoom}%`;
          canvas.style.height = 'auto';
          canvas.style.maxWidth = 'none';
          canvas.className =
            'block mb-3 rounded-lg border-2 border-black bg-white shadow-[2px_2px_0px_0px_#111]';
          container.appendChild(canvas);

          await page.render({
            canvasContext: canvas.getContext('2d'),
            viewport,
          }).promise;

          if (cancelled) return;

          // Show the first page as soon as it exists rather than waiting for a
          // 200-page document to finish.
          if (n === 1) setStatus('ready');
        }

        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        /*
         * A cancelled render throws, and that is not a failure the reader needs
         * to hear about — it happens whenever they press "+" while pages are
         * still drawing. Reporting it would replace the document with an error
         * screen mid-zoom.
         */
        if (err?.name === 'RenderingCancelledException') return;
        console.error('[PdfCanvasViewer] render', err);
        setError(err?.message || 'Could not display this PDF.');
        setStatus('error');
      }
    })();

    return () => { cancelled = true; };
  }, [doc, zoom]);

  const nudge = useCallback((delta) => {
    setZoom((z) => {
      const next = Math.round((z + delta) * 100) / 100;
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    });
  }, []);

  /* ----------------------------------------------------------------- pinch
   *
   * Two fingers scale the document, which is what a phone reader reaches for
   * before looking for buttons.
   *
   * The browser's own pinch-zoom does not help here: it magnifies the whole
   * page, and these canvases live inside a scrolling modal, so the page has
   * nowhere to go. touch-action: pan-x pan-y on the scroller tells the browser
   * to keep one-finger scrolling and hand two-finger gestures to us.
   *
   * During the gesture only a CSS transform is applied — cheap, and briefly
   * soft, because it is stretching pixels already drawn. On release the scale
   * is committed to `zoom`, which re-renders the pages at the new resolution
   * and makes the text crisp again. Re-rendering every page on every frame of a
   * pinch would drop the gesture to single figures on a mid-range phone.
   */
  const pointers = useRef(new Map());
  const pinchStart = useRef(0);
  const [gesture, setGesture] = useState(1);

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (e) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) pinchStart.current = spread();
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size !== 2 || !pinchStart.current) return;
    const ratio = spread() / pinchStart.current;
    /*
     * Clamped against the committed zoom, not against 1, so a pinch cannot
     * push the document past the bounds the buttons respect.
     */
    const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * ratio));
    setGesture(target / zoom);
  };

  const endPointer = (e) => {
    pointers.current.delete(e.pointerId);
    // Commit on the way down from two fingers to one, not at zero: lifting one
    // finger ends the pinch even though the other is still on the glass.
    if (pointers.current.size < 2 && gesture !== 1) {
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * gesture * 100) / 100)));
      setGesture(1);
      pinchStart.current = 0;
    }
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#F4F4F4]">
      {/*
        Controls stay put while the document scrolls under them. On a phone the
        alternative — pinch — is unavailable here: the canvases live inside a
        scrolling modal, and the browser gives pinch-zoom to the page rather
        than to a nested scroller, so without these buttons there is no way to
        magnify anything.

        Shown once a document exists rather than once rendering finishes, so
        they do not vanish on every zoom while the pages redraw.
      */}
      {doc && status !== 'error' && (
        <div className="shrink-0 flex items-center justify-center gap-1.5 px-2 py-1.5 border-b-2 border-black/10 bg-white/80 backdrop-blur-sm">
          <button
            type="button"
            onClick={() => nudge(-ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            className="w-8 h-8 flex items-center justify-center border-2 border-black rounded-lg bg-white shadow-[2px_2px_0px_0px_#111] disabled:opacity-40 disabled:shadow-none active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-all"
          >
            <ZoomOut size={14} strokeWidth={3} />
          </button>

          {/* Also the reset: tapping the number returns to fit-width, which is
              otherwise several taps away once someone has zoomed in. */}
          <button
            type="button"
            onClick={() => setZoom(1)}
            disabled={zoom === 1}
            aria-label="Fit to width"
            className="h-8 px-2.5 flex items-center gap-1 border-2 border-black rounded-lg bg-white text-xs font-black tabular-nums shadow-[2px_2px_0px_0px_#111] disabled:opacity-60 disabled:shadow-none"
          >
            <Maximize2 size={12} strokeWidth={3} />
            {Math.round(zoom * 100)}%
          </button>

          <button
            type="button"
            onClick={() => nudge(ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            className="w-8 h-8 flex items-center justify-center border-2 border-black rounded-lg bg-white shadow-[2px_2px_0px_0px_#111] disabled:opacity-40 disabled:shadow-none active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-all"
          >
            <ZoomIn size={14} strokeWidth={3} />
          </button>
        </div>
      )}

      {/* overflow-auto is what makes a zoomed page reachable — without it the
          part beyond the container edge is simply clipped away.

          touch-action keeps one-finger scrolling with the browser and gives us
          two-finger gestures; without it the browser swallows the pinch and
          zooms the page instead of the document. */}
      <div
        className="flex-1 min-h-0 overflow-auto p-2 md:p-4"
        style={{ touchAction: 'pan-x pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
      >
        {status === 'loading' && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 font-bold text-gray-500">
            <Loader className="animate-spin text-[#F26B4D]" size={28} strokeWidth={3} />
            Rendering {title || 'document'}...
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            <p className="font-bold text-red-600">Could not display this PDF.</p>
            <p className="text-sm text-gray-500">{error}</p>
          </div>
        )}

        {/*
          The live pinch scale. transformOrigin is the top-left so the document
          grows away from the corner the reader is already anchored to —
          scaling from the centre would slide the page under their fingers.
          At rest this is scale(1) and costs nothing.
        */}
        <div
          ref={containerRef}
          style={{
            transform: gesture === 1 ? undefined : `scale(${gesture})`,
            transformOrigin: '0 0',
            willChange: gesture === 1 ? undefined : 'transform',
          }}
        />

        {status === 'ready' && pageCount > 1 && (
          <p className="text-center text-xs font-bold text-gray-500 py-2">
            {pageCount} pages
          </p>
        )}
      </div>
    </div>
  );
}
