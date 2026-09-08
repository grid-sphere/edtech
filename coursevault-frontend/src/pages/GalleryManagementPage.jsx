import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, UploadCloud, ChevronUp, ChevronDown, Link2, Loader, ImageOff } from 'lucide-react';
import { fetchAPI, resolveMediaUrl, BASE_URL } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import BannerCropper from '../components/educator/BannerCropper.jsx';

/**
 * Admin → Gallery Management.
 *
 * The home carousel used to be assembled from courses: every published class
 * that happened to have a cover image, newest first. It filled the space, but
 * nobody chose it — the most prominent surface in the app changed whenever a
 * teacher uploaded a thumbnail, and an admin who wanted something else there
 * had no way to say so.
 *
 * These banners are their own records. A banner may point at a class, but it is
 * never derived from one.
 */
export default function GalleryManagementPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [images, setImages] = useState([]);
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  /*
   * The picked file waits here until it has been cropped.
   *
   * Uploading straight from the picker was the bug: the carousel draws every
   * banner into a 5:2 box with object-cover, so a tall image lost its top and
   * bottom to a rule the admin never saw and could not adjust.
   */
  const [pending, setPending] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [gallery, courseList] = await Promise.all([
        fetchAPI('/gallery'),
        fetchAPI('/courses'),
      ]);
      setImages(gallery.images || []);
      /*
       * Only top-level classes are offerable as a destination, matching what
       * tapping a banner actually opens — the class view with its subjects.
       */
      setClasses((courseList.courses || []).filter((c) => !c.parent_course_id));
    } catch (err) {
      setError(err.message || 'Could not load the gallery.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /*
   * Guarded here as well as on the server.
   *
   * The server rejects a non-admin outright, so this is not the security
   * boundary — it exists so a teacher who reaches the URL reads a sentence
   * instead of an empty page decorated with 403s.
   */
  if (user && user.role !== 'admin') {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center">
        <p className="font-bold text-gray-600">
          Gallery management is available to admins only.
        </p>
        <button
          onClick={() => navigate('/home')}
          className="mt-4 px-4 py-2 rounded-full border-2 border-black bg-[#A7E2D1] font-bold text-xs shadow-[2px_2px_0px_0px_#111]"
        >
          Back to home
        </button>
      </div>
    );
  }

  /**
   * Upload, then record.
   *
   * The bytes go through /content/upload-image, which already stores to R2 and
   * returns a URL — reusing it means one upload path to keep working rather
   * than a second one that drifts.
   */
  const onPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';           // so re-picking the same file fires onChange
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.');
      return;
    }
    // Banners are stored and served as-is; the memory-upload route caps at 50MB.
    if (file.size > 10 * 1024 * 1024) {
      setError('Please use an image under 10MB — a banner this large is slow to load on a phone.');
      return;
    }

    // Crop first; upload happens once the frame is confirmed.
    setError('');
    setPending(file);
  };

  const upload = async (file) => {
    setPending(null);
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${BASE_URL}/content/upload-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      /*
       * `imageUrl` exactly, not a guess-chain of plausible field names. The
       * route returns { success, imageUrl, key }, where imageUrl points at
       * /content/stream-image so the R2 bucket can stay private. Accepting
       * whichever of three names happened to be present would store undefined
       * as a URL the day that shape changed, and the failure would surface as a
       * blank banner rather than an error.
       */
      if (!data.imageUrl) throw new Error('The upload did not return an image URL.');

      await fetchAPI('/gallery', {
        method: 'POST',
        body: JSON.stringify({ imageUrl: data.imageUrl }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not upload that image.');
    } finally {
      setUploading(false);
    }
  };

  const patch = async (id, body) => {
    try {
      await fetchAPI(`/gallery/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      await load();
    } catch (err) {
      setError(err.message || 'Could not save that change.');
    }
  };

  const remove = async (img) => {
    if (!window.confirm('Remove this banner from the home screen?')) return;
    try {
      await fetchAPI(`/gallery/${img.id}`, { method: 'DELETE' });
      setImages((prev) => prev.filter((i) => i.id !== img.id));
    } catch (err) {
      setError(err.message || 'Could not delete that image.');
    }
  };

  /*
   * The whole order is sent, not one move — the server stores positions, so the
   * final arrangement is the unambiguous thing to send. Computed from `images`
   * directly rather than inside a setState updater, which React may call twice
   * in development and would swap the pair back while still sending the request.
   */
  const move = async (id, dir) => {
    const i = images.findIndex((x) => x.id === id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i === -1 || j < 0 || j >= images.length) return;

    const next = [...images];
    [next[i], next[j]] = [next[j], next[i]];
    setImages(next);
    try {
      await fetchAPI('/gallery/reorder/all', {
        method: 'PUT',
        body: JSON.stringify({ ids: next.map((x) => x.id) }),
      });
    } catch (err) {
      setImages(images);   // put it back rather than show an order students are not getting
      setError(err.message || 'Could not save the new order.');
    }
  };

  if (loading) return <div className="text-center font-bold py-20 text-gray-400">Loading...</div>;

  return (
    <div className="max-w-4xl mx-auto pb-20">
      {pending && (
        <BannerCropper
          file={pending}
          onCancel={() => setPending(null)}
          onCropped={upload}
        />
      )}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h1 className="text-lg md:text-2xl font-black">Gallery Management</h1>
          <p className="text-[11px] md:text-sm font-bold text-gray-500">
            These images are the banner on every student&apos;s home screen.
          </p>
        </div>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="shrink-0 h-10 px-3 flex items-center gap-2 border-2 border-black rounded-xl bg-[#A7E2D1] font-bold text-sm shadow-[3px_3px_0px_0px_#111] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111] transition-all disabled:opacity-60"
        >
          {uploading ? <Loader size={15} className="animate-spin" /> : <UploadCloud size={15} strokeWidth={3} />}
          {uploading ? 'Uploading…' : 'Add image'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" onChange={onPick} className="hidden" />
      </div>

      {error && (
        <div role="alert" className="mb-3 px-3 py-2 border-2 border-black rounded-xl bg-red-100 text-red-800 font-bold text-xs">
          {error}
        </div>
      )}

      {images.length === 0 ? (
        /*
         * Says what the consequence is, not just that the list is empty. With
         * no banners the home screen falls back to its plain panel, and an
         * admin should know that before wondering where the carousel went.
         */
        <div className="border-2 border-black rounded-xl bg-white p-6 text-center shadow-[2px_2px_0px_0px_#111]">
          <ImageOff size={28} strokeWidth={2} className="mx-auto mb-2 text-gray-500" />
          <p className="font-bold text-sm text-gray-600">
            No banners yet — the home screen is showing its plain panel.
          </p>
          <p className="text-xs font-bold text-gray-500 mt-1">
            Add an image to start the carousel.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {images.map((img, i) => (
            <div key={img.id} className="flex gap-2.5 p-2 border-2 border-black rounded-xl bg-white shadow-[2px_2px_0px_0px_#111]">
              <div className="shrink-0 flex flex-col justify-center gap-0.5">
                <button
                  onClick={() => move(img.id, 'up')}
                  disabled={i === 0}
                  aria-label="Move up"
                  className="w-6 h-6 flex items-center justify-center border-2 border-black rounded bg-white disabled:opacity-30"
                >
                  <ChevronUp size={13} strokeWidth={3} />
                </button>
                <button
                  onClick={() => move(img.id, 'down')}
                  disabled={i === images.length - 1}
                  aria-label="Move down"
                  className="w-6 h-6 flex items-center justify-center border-2 border-black rounded bg-white disabled:opacity-30"
                >
                  <ChevronDown size={13} strokeWidth={3} />
                </button>
              </div>

              {/* 5:2, the aspect the carousel actually crops to, so what the
                  admin approves here is what a student sees. */}
              <div className="shrink-0 w-28 md:w-40 aspect-[5/2] rounded-lg border-2 border-black overflow-hidden bg-gray-100">
                <img src={resolveMediaUrl(img.image_url)} alt="" className="w-full h-full object-cover" />
              </div>

              <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                <input
                  defaultValue={img.caption || ''}
                  onBlur={(e) => e.target.value !== (img.caption || '') && patch(img.id, { caption: e.target.value })}
                  placeholder="Caption (optional)"
                  className="w-full h-8 px-2 border-2 border-black rounded-lg text-xs font-bold"
                />
                <div className="flex items-center gap-1.5">
                  <Link2 size={13} strokeWidth={3} className="shrink-0 text-gray-500" />
                  <select
                    value={img.link_course_id || ''}
                    onChange={(e) => patch(img.id, { linkCourseId: e.target.value || null })}
                    className="min-w-0 flex-1 h-8 px-1.5 border-2 border-black rounded-lg text-xs font-bold bg-white"
                  >
                    <option value="">No link — decorative</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                </div>
                {/*
                  A banner whose class was deleted keeps its image and loses its
                  link, rather than vanishing. Saying so explains a select that
                  has quietly reset itself to "No link".
                */}
                {img.link_course_id && !img.link_course_title && (
                  <p className="text-[10px] font-bold text-amber-700">
                    The linked class no longer exists — pick another or leave it decorative.
                  </p>
                )}
              </div>

              <div className="shrink-0 flex flex-col justify-center gap-1">
                <button
                  onClick={() => patch(img.id, { isActive: !img.is_active })}
                  className={`h-7 px-2 border-2 border-black rounded-lg text-[10px] font-bold ${
                    img.is_active ? 'bg-[#A7E2D1]' : 'bg-gray-200 text-gray-600'
                  }`}
                >
                  {img.is_active ? 'Visible' : 'Hidden'}
                </button>
                <button
                  onClick={() => remove(img)}
                  aria-label="Delete image"
                  className="h-7 flex items-center justify-center border-2 border-black rounded-lg bg-white text-red-500 hover:bg-red-50"
                >
                  <Trash2 size={13} strokeWidth={2.5} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
