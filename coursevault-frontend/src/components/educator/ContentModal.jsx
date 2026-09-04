import React, { useState, useEffect, useRef } from 'react';
import { X, UploadCloud, Video, FileText, CheckCircle2, AlertTriangle, Film } from 'lucide-react';
import Button from '../ui/Button.jsx';
import { BASE_URL, uploadVideoWithProgress } from '../../services/api.js';
import { uploadVideoChunked } from '../../services/chunkedUpload.js';
import { formatSize } from '../../utils/format.js';
/*
 * Imported rather than declared here.
 *
 * These were local constants annotated "matches the backend's videoUpload
 * limit" — a claim nothing checked. The same number was written out in four
 * backend files and this one, so raising the ceiling meant finding all five,
 * and missing this one would have meant the browser refusing a file the server
 * would have accepted, with the dialog stating a limit that was no longer real.
 *
 * The "up to N GB" line below is derived from MAX_VIDEO_BYTES, so the text and
 * the rule cannot disagree.
 */
import { MAX_VIDEO_BYTES, MAX_FILE_BYTES, CHUNKED_THRESHOLD } from '../../constants/uploadLimits.js';


export default function ContentModal({ isOpen, onClose, moduleId, folderId, onSave, initialTab = 'video' }) {
  const isVideo = initialTab === 'video';
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDescription('');
      setFile(null);
      setPreview(false);
      setProgress(0);
      setError('');
      setIsDragging(false);
      setIsUploading(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const acceptAttr = isVideo ? 'video/*' : 'application/pdf';

  const selectFile = (chosen) => {
    if (!chosen) return;

    const looksRight = isVideo
      ? chosen.type.startsWith('video/')
      : chosen.type === 'application/pdf';

    if (!looksRight) {
      setError(isVideo ? 'That file is not a video.' : 'That file is not a PDF.');
      return;
    }

    // Checked here as well as server-side: rejecting a 4GB file after it has
    // finished uploading wastes a long wait for something knowable up front.
    if (chosen.size > maxBytes) {
      setError(`That file is ${formatSize(chosen.size)} — the limit is ${formatSize(maxBytes)}.`);
      return;
    }

    setError('');
    setFile(chosen);
    // Save the educator retyping what is usually the filename.
    if (!title.trim()) {
      setTitle(chosen.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (!isUploading) selectFile(e.dataTransfer.files?.[0]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) {
      setError('Choose a file first.');
      return;
    }

    setIsUploading(true);
    setProgress(0);
    setError('');

    try {
      if (isVideo) {
        if (file.size >= CHUNKED_THRESHOLD) {
          // Chunked: survives a dropped connection, retries only the failed
          // piece, and sends several pieces at once.
          await uploadVideoChunked(
            file,
            { moduleId, title, description, preview, folderId },
            setProgress
          );
        } else {
          // XHR, not fetch: fetch cannot report upload progress, and a multi-
          // gigabyte video with no feedback is indistinguishable from a hang.
          await uploadVideoWithProgress(moduleId, file, title, description, setProgress, {
            preview,
            folderId,
          });
        }
      } else {
        const formData = new FormData();
        formData.append('title', title);
        formData.append('description', description);
        formData.append('file', file);
        formData.append('preview', preview ? 'true' : 'false');
        formData.append('content_type', 'pdf');
        if (folderId) formData.append('folder_id', folderId);

        const token = localStorage.getItem('token');
        const response = await fetch(`${BASE_URL}/content/upload?moduleId=${moduleId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });

        if (!response.ok) {
          // Read as text first: a 404 or a crash returns an HTML page, and
          // response.json() on that throws "Unexpected token <", hiding the
          // real status.
          const raw = await response.text();
          let message;
          try {
            message = JSON.parse(raw).error;
          } catch {
            message = `Upload failed (${response.status}).`;
          }
          throw new Error(message);
        }
      }

      setProgress(100);
      onSave();
      onClose();
    } catch (err) {
      console.error('[ContentModal] upload failed', err);
      setError(err.message || 'Upload failed.');
      setIsUploading(false);
    }
  };

  const Icon = isVideo ? Video : FileText;
  const stage = progress < 100 ? 'Uploading' : 'Handing off to the server';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm font-sans">
      <div className="relative w-full max-w-lg bg-white border-[3px] border-black rounded-2xl flex flex-col shadow-[8px_8px_0px_0px_#111] max-h-[92vh]">

        {/* Header */}
        <div className={`flex justify-between items-center p-4 border-b-[3px] border-black rounded-t-xl shrink-0 ${isVideo ? 'bg-[#87CEFA]' : 'bg-[#A7E2D1]'}`}>
          <h3 className="font-black text-lg uppercase flex items-center gap-2">
            <Icon size={20} strokeWidth={2.5} /> Add {isVideo ? 'Video' : 'PDF'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={isUploading}
            className="w-8 h-8 border-2 border-black bg-white rounded-full flex items-center justify-center hover:scale-105 transition-transform disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X size={16} strokeWidth={3} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 flex flex-col gap-4">

          {error && (
            <div className="flex items-start gap-2 border-2 border-red-400 bg-red-50 text-red-800 rounded-xl px-3 py-2 text-sm font-bold">
              <AlertTriangle size={16} strokeWidth={3} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); if (!isUploading) setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => !isUploading && fileInputRef.current?.click()}
            className={`relative border-[3px] border-dashed rounded-xl p-6 text-center transition-colors ${
              isUploading
                ? 'border-gray-300 bg-gray-50 cursor-not-allowed'
                : isDragging
                ? 'border-[#F26B4D] bg-[#FFF3EF] cursor-copy'
                : file
                ? 'border-green-600 bg-[#EAF7F2] cursor-pointer'
                : 'border-black bg-[#F4F4F4] hover:bg-gray-100 cursor-pointer'
            }`}
          >
            {file ? (
              <div className="flex items-center gap-3 text-left">
                <div className="w-11 h-11 shrink-0 rounded-full border-2 border-black bg-white flex items-center justify-center">
                  {isVideo ? <Film size={20} /> : <FileText size={20} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm truncate">{file.name}</div>
                  <div className="text-xs font-medium text-gray-600">
                    {formatSize(file.size)}
                    {!isUploading && ' • click to replace'}
                  </div>
                </div>
                {!isUploading && (
                  <CheckCircle2 size={20} strokeWidth={2.5} className="text-green-700 shrink-0" />
                )}
              </div>
            ) : (
              <>
                <UploadCloud className="mx-auto mb-2 text-gray-500" size={30} />
                <div className="font-bold text-sm">
                  Drop your {isVideo ? 'video' : 'PDF'} here, or click to browse
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {isVideo ? 'MP4, MOV, WebM' : 'PDF'} • up to {formatSize(maxBytes)}
                </div>
              </>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept={acceptAttr}
              className="hidden"
              disabled={isUploading}
              onChange={(e) => selectFile(e.target.files?.[0])}
            />
          </div>

          {/* Progress */}
          {isUploading && (
            <div className="border-2 border-black rounded-xl p-3 bg-[#FDF6E3]">
              <div className="flex justify-between items-center text-xs font-black uppercase tracking-wide mb-2">
                <span>{stage}</span>
                <span>{progress}%</span>
              </div>
              <div className="w-full h-4 border-2 border-black rounded-full bg-white overflow-hidden p-[2px]">
                <div
                  className="h-full rounded-full bg-[#F26B4D] transition-all duration-200 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              {isVideo && progress >= 100 && (
                <p className="text-[11px] font-medium text-gray-600 mt-2">
                  Upload finished. The server is transcoding in the background — you
                  can close this and the video will appear when it's ready.
                </p>
              )}
              {file && progress < 100 && (
                <p className="text-[11px] font-medium text-gray-600 mt-2">
                  {formatSize(Math.round((file.size * progress) / 100))} of {formatSize(file.size)}
                </p>
              )}
            </div>
          )}

          <div>
            <label className="font-bold text-sm mb-1 block">Title</label>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isUploading}
              className="w-full bg-white border-2 border-black rounded-xl px-3 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-[#F26B4D] disabled:bg-gray-100"
              placeholder="e.g. Chapter 1 Introduction"
            />
          </div>

          <div>
            <label className="font-bold text-sm mb-1 block">Description (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isUploading}
              rows={2}
              className="w-full bg-white border-2 border-black rounded-xl px-3 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-[#F26B4D] disabled:bg-gray-100"
            />
          </div>

          {/* The old numeric "Display Priority" input is gone — ordering is done
              with the Rearrange panel in the module, so asking for a number here
              was a second, conflicting way to set the same thing. */}

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={preview}
              onChange={(e) => setPreview(e.target.checked)}
              disabled={isUploading}
              className="w-5 h-5 border-2 border-black rounded cursor-pointer accent-[#F26B4D]"
            />
            <span className="font-bold text-sm">Mark as free preview</span>
          </label>

          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isUploading}
              className="px-5 py-2 border-2 border-black rounded-xl font-bold hover:bg-gray-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <Button
              type="submit"
              variant="primary"
              disabled={isUploading || !file}
              className="py-2 px-5 text-base rounded-xl border-2"
            >
              {isUploading ? `${progress}%` : `Upload ${isVideo ? 'Video' : 'PDF'}`}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
