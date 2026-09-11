import React, { useState, useEffect, useRef } from 'react';
import { Loader } from 'lucide-react';
import Hls from 'hls.js';
import { fetchAPI, BASE_URL, MEDIA_ORIGIN } from '../../services/api.js';

export default function InlineVideoPlayer({ content, courseId, isEnrolled }) {
  const [loading, setLoading] = useState(true);
  const [streamUrl, setStreamUrl] = useState(null);
  // Set when the video was stored as a plain MP4 rather than transcoded.
  const [isProgressive, setIsProgressive] = useState(false);
  const [error, setError] = useState(null);

  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  
  const savedPositionRef = useRef(0);
  const currentPosRef = useRef(0);
  const lastSavedPosRef = useRef(0);

  const targetContentId = content?.id;
  const isPreview = content?.preview === true;
  const shouldTrackProgress = isEnrolled || isPreview;

  // 1. Initial configuration and progress history lookup
  useEffect(() => {
    if (!targetContentId) return;
    
    let cancelled = false;
    setLoading(true);
    setStreamUrl(null);
    setError(null);

    const init = async () => {
      try {
        if (!courseId) {
          throw new Error("Initializing content configurations... missing course parameter mappings.");
        }

        const streamData = await fetchAPI(`/content/${targetContentId}/stream?courseId=${courseId}`);

        let initialPos = 0;
        if (shouldTrackProgress) {
          try {
            const progressData = await fetchAPI(`/video/progress/${targetContentId}?courseId=${courseId}`);
            if (progressData.hasProgress) {
              initialPos = parseFloat(progressData.position);
            }
          } catch (_) {
            // Default back to beginning gracefully
          }
        }

        if (cancelled) return;
        
        savedPositionRef.current = initialPos;
        currentPosRef.current = initialPos;
        lastSavedPosRef.current = initialPos;

        // 🚀 Handle Processing States vs Ready HLS Playback URLs
        if (streamData.status === 'processing') {
          setError('Video is still processing and transcoding. Please check back in a moment!');
        } else if (streamData.mp4Url || streamData.hlsUrl) {
          const token = localStorage.getItem('token');
          // Same resolution as every other request. The old fallback was
          // localhost:3000, which on a phone is the phone.
          const backendDomain = MEDIA_ORIGIN;

          if (streamData.mp4Url) {
            setIsProgressive(true);
            setStreamUrl(`${backendDomain}${streamData.mp4Url}?token=${token}`);
          } else {
            setIsProgressive(false);
            setStreamUrl(`${backendDomain}${streamData.hlsUrl}&token=${token}`);
          }
        } else {
          setError(streamData.message || 'Video processing has not completed yet.');
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to initialize system video pipelines.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    init();
    return () => { cancelled = true; };
  }, [targetContentId, courseId, shouldTrackProgress]);

  // 2. Bind player engine instances exactly ONCE per unique stream URL.
  useEffect(() => {
    if (!streamUrl || !videoRef.current) return;

    const videoEl = videoRef.current;

    const syncTime = () => {
      currentPosRef.current = videoEl.currentTime;
    };
    videoEl.addEventListener('timeupdate', syncTime);

    // Plain MP4: native playback. HLS.js would find no manifest here.
    if (isProgressive) {
      videoEl.src = streamUrl;
      const seekOnce = () => {
        if (savedPosition > 0) videoEl.currentTime = savedPosition;
      };
      videoEl.addEventListener('loadedmetadata', seekOnce);
      return () => {
        videoEl.removeEventListener('timeupdate', syncTime);
        videoEl.removeEventListener('loadedmetadata', seekOnce);
      };
    }

    const applyInitialSeek = () => {
      if (savedPositionRef.current > 0) {
        videoEl.currentTime = savedPositionRef.current;
        savedPositionRef.current = 0; 
      }
    };

    if (Hls.isSupported()) {
      const hls = new Hls({ maxMaxBufferLength: 30 });
      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(videoEl);
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applyInitialSeek();
      });

      return () => {
        videoEl.removeEventListener('timeupdate', syncTime);
        hls.destroy();
      };
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = streamUrl;
      videoEl.addEventListener('loadedmetadata', applyInitialSeek);
      
      return () => {
        videoEl.removeEventListener('timeupdate', syncTime);
        videoEl.removeEventListener('loadedmetadata', applyInitialSeek);
      };
    }
  }, [streamUrl, isProgressive]);

  // 3. Progress Sync Loop + Reliable Unmount Tracking
  useEffect(() => {
    if (!targetContentId || !courseId || !shouldTrackProgress) return;

    const saveProgress = async (positionToSave) => {
      const pos = Math.round(positionToSave);
      if (pos <= 0 || pos === Math.round(lastSavedPosRef.current)) return;

      try {
        await fetchAPI('/video/progress', {
          method: 'POST',
          body: JSON.stringify({ contentId: targetContentId, courseId, position: pos }),
        });
        lastSavedPosRef.current = pos;
      } catch (_) {}
    };

    const syncOnUnmount = () => {
      const finalPos = Math.round(currentPosRef.current);
      if (finalPos <= 0 || finalPos === Math.round(lastSavedPosRef.current)) return;

      const token = localStorage.getItem('token');
      // Progress was posted to localhost:3000 on every student's phone, so it
      // silently went nowhere — which is why watch progress only ever moved
      // when someone used a laptop.
      fetch(`${BASE_URL}/video/progress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ contentId: targetContentId, courseId, position: finalPos }),
        keepalive: true 
      }).catch(() => {});
    };

    const intervalId = setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) {
        saveProgress(currentPosRef.current);
      }
    }, 5000);

    return () => {
      clearInterval(intervalId);
      syncOnUnmount();
    };
  }, [targetContentId, courseId, shouldTrackProgress]);

  if (!content || !content.id) return null;

  return (
    <div className="mt-3 bg-black border-[3px] border-black rounded-xl overflow-hidden shadow-[4px_4px_0px_0px_#000]">
      {loading && (
        <div className="flex flex-col items-center justify-center gap-2 text-white font-bold py-16">
          <Loader className="animate-spin text-[#F26B4D]" size={28} strokeWidth={3} />
          Assembling Media Manifests...
        </div>
      )}
      
      {error && !loading && (
        <div className="text-center text-[#F26B4D] font-black uppercase tracking-wide py-16 px-4 bg-zinc-900 border-b-2 border-black">
          ❌ {error}
        </div>
      )}
      
      {!loading && !error && streamUrl && (
        <video
          ref={videoRef}
          controls
          controlsList="nodownload"
          className="w-full max-h-[60vh] bg-black block outline-none"
        />
      )}
    </div>
  );
}