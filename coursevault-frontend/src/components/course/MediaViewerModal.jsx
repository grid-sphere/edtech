import React, { useState, useEffect, useRef } from 'react';
import { X, Loader, FileDown } from 'lucide-react';
import { fetchAPI, BASE_URL, MEDIA_ORIGIN } from '../../services/api.js';
import Hls from 'hls.js';
import PdfCanvasViewer from './PdfCanvasViewer.jsx';

export default function MediaViewerModal({ content, courseId, isEnrolled, onClose }) {
  const [loading, setLoading] = useState(true);
  const [streamUrl, setStreamUrl] = useState(null);
  // A directly-stored MP4 plays natively; HLS.js must not touch it.
  const [isProgressive, setIsProgressive] = useState(false);
  // Raw bytes, not a blob URL: the canvas viewer needs the data itself.
  const [pdfData, setPdfData] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [error, setError] = useState(null);
  const [savedPosition, setSavedPosition] = useState(0);
  
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const currentPosRef = useRef(0);

  const targetContentId = content?.id;
  const rawContentType = content?.content_type || '';
  const type = String(rawContentType).toLowerCase();

  useEffect(() => {
    if (!targetContentId) return;
    
    let isCancelled = false;
    setLoading(true);
    setStreamUrl(null);
    setIsProgressive(false);
    setPdfData(null);
    setDownloadUrl(null);
    setError(null);

    const initMedia = async () => {
      try {
        if (type.includes('video')) {
          const streamData = await fetchAPI(`/content/${targetContentId}/stream?courseId=${courseId || ''}`);
          
          let initialPos = 0;
          if (courseId && isEnrolled) {
            try {
              const progressData = await fetchAPI(`/video/progress/${targetContentId}`);
              if (progressData.hasProgress) {
                initialPos = parseFloat(progressData.position);
              }
            } catch (_) {}
          }

          if (isCancelled) return;
          
          setSavedPosition(initialPos);
          currentPosRef.current = initialPos;

          const token = localStorage.getItem('token');
          // Resolved the same way every other request is. The old inline
          // fallback was localhost:3000, which is the phone on a phone.
          const backendDomain = MEDIA_ORIGIN;

          if (streamData.mp4Url) {
            // Stored without transcoding — the browser plays it directly and
            // seeks with range requests.
            setIsProgressive(true);
            setStreamUrl(`${backendDomain}${streamData.mp4Url}?token=${token}`);
            setLoading(false);
          } else if (streamData.hlsUrl) {
            setIsProgressive(false);
            setStreamUrl(`${backendDomain}${streamData.hlsUrl}&token=${token}`);
            setLoading(false);
          } else {
            throw new Error(streamData.message || 'Video processing is pending.');
          }

        } else if (type.includes('pdf') || type.includes('document')) {
          const token = localStorage.getItem('token');

          /*
           * BASE_URL, not a hand-rolled fallback.
           *
           * This read import.meta.env.VITE_API_URL and fell back to
           * localhost:3000/api. There is no VITE_API_URL in this project, so the
           * fallback was always what ran — the backend on a laptop, and the
           * phone itself on a phone. The request never resolved and the modal
           * sat on "Mounting secure media stream" until the student gave up.
           */
          const response = await fetch(`${BASE_URL}/content/${targetContentId}/pdf?courseId=${courseId || ''}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to fetch PDF');
          }

          const rawBlob = await response.blob();
          if (isCancelled) return;

          // A zero-byte body used to become a valid blob URL and render as an
          // empty frame — a blank grey box with no error, which reads as a
          // broken viewer rather than a missing file.
          if (rawBlob.size === 0) {
            throw new Error('That file came back empty. It may not have finished uploading.');
          }

          // Trust the server's type instead of forcing application/pdf. A
          // .docx relabelled as a PDF makes the browser open its PDF viewer on
          // bytes that are not a PDF, which draws nothing at all.
          const serverType = (response.headers.get('content-type') || '').split(';')[0].trim();
          const blobType = serverType || rawBlob.type || 'application/octet-stream';
          const objectUrl = URL.createObjectURL(new Blob([rawBlob], { type: blobType }));

          if (blobType === 'application/pdf') {
            // Rendered by us rather than the browser — see PdfCanvasViewer.
            URL.revokeObjectURL(objectUrl);
            setPdfData(await rawBlob.arrayBuffer());
          } else {
            // Browsers cannot render Word/PowerPoint inline. Offer the file
            // rather than showing an empty viewer.
            setDownloadUrl(objectUrl);
          }
          setLoading(false);
          
        } else {
          throw new Error(`Unknown content type configuration: "${rawContentType}"`);
        }
      } catch (err) {
        if (!isCancelled) {
          console.error('Failed to load media:', err);
          setError(err.message || 'Failed to load content');
          setLoading(false);
        }
      }
    };

    initMedia();
    
    return () => {
      isCancelled = true;
    };
  }, [targetContentId, type, courseId, isEnrolled]);

  useEffect(() => {
    if (!streamUrl || !videoRef.current || !type.includes('video')) return;

    const videoEl = videoRef.current;

    // Progressive MP4: assign the source and let the browser do the rest.
    // Routing it through HLS.js would fail — there is no manifest to parse.
    if (isProgressive) {
      videoEl.src = streamUrl;
      const syncProgressive = () => { currentPosRef.current = videoEl.currentTime; };
      const seekOnce = () => {
        if (savedPosition > 0) videoEl.currentTime = savedPosition;
        videoEl.play().catch(e => console.log("Auto-play blocked:", e));
      };
      videoEl.addEventListener('timeupdate', syncProgressive);
      videoEl.addEventListener('loadedmetadata', seekOnce);
      return () => {
        videoEl.removeEventListener('timeupdate', syncProgressive);
        videoEl.removeEventListener('loadedmetadata', seekOnce);
      };
    }
    const syncTime = () => {
      currentPosRef.current = videoEl.currentTime;
    };
    videoEl.addEventListener('timeupdate', syncTime);

    if (Hls.isSupported()) {
      const hls = new Hls({ maxMaxBufferLength: 30 });
      hlsRef.current = hls;

      hls.loadSource(streamUrl);
      hls.attachMedia(videoEl);
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (savedPosition > 0) videoEl.currentTime = savedPosition;
        videoEl.play().catch(e => console.log("Auto-play blocked:", e));
      });

      return () => {
        videoEl.removeEventListener('timeupdate', syncTime);
        hls.destroy();
      };
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = streamUrl;
      
      const handleMetadata = () => {
        if (savedPosition > 0) videoEl.currentTime = savedPosition;
        videoEl.play().catch(e => console.log("Auto-play blocked:", e));
      };
      
      videoEl.addEventListener('loadedmetadata', handleMetadata);
      return () => {
        videoEl.removeEventListener('timeupdate', syncTime);
        videoEl.removeEventListener('loadedmetadata', handleMetadata);
      };
    }
  }, [streamUrl, savedPosition, type, isProgressive]);

  useEffect(() => {
    if (!targetContentId || !type.includes('video') || !courseId || !isEnrolled) return;

    const saveProgressToDB = async (posToSave) => {
      const currentPos = Math.round(posToSave);
      if (currentPos <= 0) return;

      try {
        await fetchAPI('/video/progress', {
          method: 'POST',
          body: JSON.stringify({ contentId: targetContentId, courseId, position: currentPos }),
        });
      } catch (err) {
        console.error(`Analytics sync failure:`, err.message);
      }
    };

    const intervalId = setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) {
        saveProgressToDB(currentPosRef.current);
      }
    }, 5000);

    return () => {
      clearInterval(intervalId);
      if (currentPosRef.current > 0) {
        saveProgressToDB(currentPosRef.current);
      }
    };
  }, [targetContentId, type, courseId, isEnrolled]);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  if (!content || !content.id) return null;
  
  const isVideo = type.includes('video');
  const isPdf = type.includes('pdf') || type.includes('document');

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-0 md:p-4 bg-black/60 backdrop-blur-sm">
      <div className="relative w-full h-full md:h-auto max-w-5xl bg-white border-0 md:border-[3px] border-black rounded-none md:rounded-[24px] shadow-none md:shadow-[8px_8px_0px_0px_#111] overflow-hidden flex flex-col max-h-full md:max-h-[90vh]">
        
        <div className="flex justify-between items-center p-3 md:p-4 border-b-2 md:border-b-[3px] border-black bg-[#A7E2D1]">
          <h3 className="font-black text-sm md:text-xl tracking-tight uppercase line-clamp-1 pr-2">
            {content.title || 'Viewing Asset File'}
          </h3>
          <button
            onClick={onClose}
            className="flex-shrink-0 w-8 h-8 md:w-10 md:h-10 border-2 md:border-[3px] border-black bg-[#F26B4D] rounded-full flex items-center justify-center hover:scale-105 transition-transform shadow-[2px_2px_0px_0px_#111] outline-none"
          >
            <X size={16} strokeWidth={3} className="md:w-5 md:h-5" />
          </button>
        </div>
        
        <div className="flex-1 bg-[#F4F4F4] relative overflow-hidden flex items-center justify-center min-h-0 md:min-h-[60vh]">
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center font-bold text-gray-500 gap-3 bg-[#F4F4F4] z-50 text-sm md:text-base text-center px-4">
              <Loader className="animate-spin text-[#F26B4D]" size={32} strokeWidth={3} />
              Mounting secure media stream...
            </div>
          )}
          
          {error && !loading && (
            <div className="flex flex-col items-center justify-center font-bold text-red-500 gap-2 md:gap-3 p-6 md:p-8 text-center">
              <p className="text-sm md:text-base">Failed to load content.</p>
              <p className="text-xs md:text-sm font-normal text-gray-500">{error}</p>
            </div>
          )}
          
          {!loading && !error && isVideo && streamUrl && (
            <video
              ref={videoRef}
              controls
              controlsList="nodownload" 
              className="w-full h-full max-h-full md:max-h-[75vh] object-contain bg-black outline-none"
            />
          )}
          
          {!loading && !error && downloadUrl && (
            <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
              <FileDown size={40} strokeWidth={2} className="text-[#F26B4D]" />
              <p className="font-bold text-sm md:text-base">
                This file type can't be previewed in the browser.
              </p>
              <a
                href={downloadUrl}
                download={content.file_name || content.title}
                className="inline-flex items-center gap-2 px-5 h-11 font-bold text-sm border-2 border-black rounded-xl bg-[#F9E076] shadow-[3px_3px_0px_0px_#111] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111] transition-all"
              >
                <FileDown size={16} strokeWidth={2.5} /> Download to open
              </a>
            </div>
          )}

          {/* Drawn to canvas rather than handed to an <iframe>: Android Chrome
              has no built-in PDF viewer and shows a download stub instead, so
              the iframe worked on a laptop and failed on a phone. */}
          {!loading && !error && isPdf && pdfData && (
            <div className="w-full flex-1 self-stretch" style={{ minHeight: '70vh' }}>
              <PdfCanvasViewer data={pdfData} title={content.title} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}