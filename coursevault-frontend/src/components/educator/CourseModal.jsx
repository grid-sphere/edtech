import React, { useState, useEffect } from 'react';
import { X, UploadCloud, Image as ImageIcon, Trash2 } from 'lucide-react';
import Button from '../ui/Button';
import { fetchAPI, BASE_URL, resolveMediaUrl } from '../../services/api';
import { slugifyCategory } from '../../constants/courseCategories';
import { useCategories } from '../../hooks/useCategories';

export default function CourseModal({ isOpen, onClose, course = null, onSave, parentCourseId = null }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState(0);
  const [status, setStatus] = useState('draft');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  // '' means uncategorised, which is a valid choice rather than a missing one.
  const [category, setCategory] = useState('');
  /*
   * The label typed into the "new category" box.
   *
   * Separate from `category` because the two answer different questions: this
   * is what the teacher wants it called, `category` is which existing one is
   * selected. Keeping them in one field would mean guessing which was meant.
   */
  const [newCategory, setNewCategory] = useState('');
  const { categories } = useCategories();

  /*
   * A sentinel option rather than a separate "add" button.
   *
   * The teacher is already in the dropdown deciding where this course belongs;
   * "None of these" is one of the answers, and it belongs in the same list
   * rather than beside it as a control they have to notice.
   */
  const NEW_CATEGORY = '__new__';
  const creatingCategory = category === NEW_CATEGORY;
  const [validityMonths, setValidityMonths] = useState(''); // blank = lifetime
  // 'months' for real courses, 'minutes' purely to verify the lockout works.
  const [validityUnit, setValidityUnit] = useState('months');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);

  useEffect(() => {
    if (course) {
      setTitle(course.title);
      setDescription(course.description || '');
      setPrice(course.price || 0);
      setStatus(course.status || 'draft');
      setThumbnailUrl(course.thumbnail_url || '');
      setCategory(course.category || '');
      setNewCategory('');
      // A course saved in test minutes reopens in test minutes, rather than
      // silently showing a blank month field that would wipe it on save.
      if (course.access_duration_minutes) {
        setValidityUnit('minutes');
        setValidityMonths(course.access_duration_minutes);
      } else {
        setValidityUnit('months');
        setValidityMonths(course.access_duration_months ?? '');
      }
    } else {
      setTitle('');
      setDescription('');
      setPrice(0);
      setStatus('draft');
      setThumbnailUrl('');
      setCategory('');
      setValidityMonths('');
      setValidityUnit('months');
    }
  }, [course, isOpen]);

  if (!isOpen) return null;

  const modalHeading = course ? 'Edit Course' : parentCourseId ? 'Add Course' : 'Create Course';
  const submitLabel = course ? 'Save Course' : parentCourseId ? 'Save Course' : 'Save Course';

  // 🌟 Handle Thumbnail Upload to R2
  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      return alert('Please select a valid image file (PNG, JPG, WEBP).');
    }

    setIsUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const token = localStorage.getItem('token');
      const response = await fetch(`${BASE_URL}/content/upload-image?folder=thumbnails`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData,
      });

      if (!response.ok) {
        // A 404 here means the server has no upload-image route — surface that
        // plainly instead of "Unexpected token < in JSON", which is what
        // response.json() throws when the body is an HTML error page.
        const raw = await response.text();
        let message;
        try {
          message = JSON.parse(raw).error;
        } catch {
          message = response.status === 404
            ? 'Upload endpoint not found. Restart the backend to pick up the new route.'
            : `Upload failed (${response.status}).`;
        }
        throw new Error(message);
      }

      const data = await response.json();
      setThumbnailUrl(data.imageUrl);
    } catch (err) {
      alert(err.message || 'Failed to upload image');
    } finally {
      setIsUploadingImage(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    const trimmedValidity = String(validityMonths).trim();
    const usingMinutes = validityUnit === 'minutes';
    const maxValue = usingMinutes ? 1440 : 120;

    if (trimmedValidity !== '') {
      const value = Number(trimmedValidity);
      if (!Number.isInteger(value) || value < 1 || value > maxValue) {
        setIsSubmitting(false);
        return alert(
          usingMinutes
            ? 'Test duration must be a whole number of minutes between 1 and 1440 (24 hours).'
            : 'Validity must be a whole number of months between 1 and 120, or left blank for lifetime access.'
        );
      }
    }

    const data = { 
      title, 
      description, 
      price: parseFloat(price), 
      status,
      thumbnail_url: thumbnailUrl,
      // Sent even when blank: the server reads null as "clear it", which is how
      // a category gets removed once set.
      category: creatingCategory ? null : (category || null),
      /*
       * Only present when a new one is being created. The server takes its
       * presence as the instruction to create-and-assign, so sending an empty
       * string on every save would turn each one into a failed validation.
       */
      ...(creatingCategory ? { category_label: newCategory.trim() } : {}),
      // Blank means lifetime; the server stores null. Only one of the two is
      // ever set — minutes wins server-side, so sending both would be
      // ambiguous about which the teacher actually chose.
      access_duration_months:
        trimmedValidity === '' || usingMinutes ? null : Number(trimmedValidity),
      access_duration_minutes:
        trimmedValidity === '' || !usingMinutes ? null : Number(trimmedValidity),
    };

    if (!course && parentCourseId) {
      data.parent_course_id = parentCourseId;
    }

    try {
      if (course) {
        await fetchAPI(`/courses/${course.id}`, { method: 'PUT', body: JSON.stringify(data) });
      } else {
        await fetchAPI('/courses', { method: 'POST', body: JSON.stringify(data) });
      }
      onSave();
      onClose();
    } catch (err) {
      alert(err.message || 'Failed to save course');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="relative w-full max-w-lg bg-[#F4DFD8] border-[3px] border-black rounded-2xl flex flex-col shadow-[8px_8px_0px_0px_#111] max-h-[90vh] overflow-hidden">
        <div className="flex justify-between items-center p-4 border-b-[3px] border-black bg-white rounded-t-xl shrink-0">
          <h3 className="font-bold text-xl">{modalHeading}</h3>
          <button onClick={onClose} className="w-8 h-8 border-[3px] border-black bg-[#F26B4D] rounded-full flex items-center justify-center font-bold hover:scale-110">
            <X size={16} strokeWidth={3} />
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="flex-1 min-h-0 p-4 md:p-6 flex flex-col gap-4 bg-white rounded-b-xl overflow-y-auto">
          <div>
            <label className="font-bold text-sm ml-1 mb-1 block">Course Title</label>
            <input required value={title} onChange={e => setTitle(e.target.value)} className="w-full bg-[#F4F4F4] border-2 border-black rounded-xl px-4 py-2 font-medium focus:outline-none focus:shadow-[4px_4px_0px_0px_#F26B4D]" />
          </div>

          <div>
            <label className="font-bold text-sm ml-1 mb-1 block">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} className="w-full bg-[#F4F4F4] border-2 border-black rounded-xl px-4 py-2 font-medium focus:outline-none focus:shadow-[4px_4px_0px_0px_#F26B4D]" />
          </div>

          {/* 🌟 Neo-Brutalist Thumbnail Uploader */}
          <div>
            <label className="font-bold text-sm ml-1 mb-1 block">Course Thumbnail</label>
            {thumbnailUrl ? (
              <div className="relative border-2 border-black rounded-xl overflow-hidden group bg-gray-100 h-40 flex items-center justify-center shadow-[4px_4px_0px_0px_#111]">
                {/* resolveMediaUrl is required here too: upload-image returns a
                    relative /api/content/stream-image URL, which in dev resolves
                    against Vite on :5173 instead of the API on :3000 — so the
                    preview showed a broken-image icon. */}
                <img
                  src={resolveMediaUrl(thumbnailUrl)}
                  alt="Thumbnail preview"
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    console.warn('[CourseModal] thumbnail preview failed to load', {
                      stored: thumbnailUrl,
                      resolved: resolveMediaUrl(thumbnailUrl),
                    });
                    e.currentTarget.style.display = 'none';
                  }}
                />
                <button
                  type="button"
                  onClick={() => setThumbnailUrl('')}
                  className="absolute top-2 right-2 bg-red-400 border-2 border-black p-1.5 rounded-lg text-black hover:bg-red-500 hover:scale-105 transition-all shadow-[2px_2px_0px_0px_#000]"
                  title="Remove image"
                >
                  <Trash2 size={16} strokeWidth={3} />
                </button>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-black border-dashed rounded-xl cursor-pointer bg-[#F4F4F4] hover:bg-gray-100 transition-colors relative">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  {isUploadingImage ? (
                    <div className="font-black text-sm text-[#F26B4D] animate-pulse">Uploading to R2 Cloud...</div>
                  ) : (
                    <>
                      <UploadCloud className="w-8 h-8 mb-2 text-gray-500" />
                      <p className="mb-1 text-sm font-bold text-black">Click to upload thumbnail</p>
                      <p className="text-xs text-gray-500 font-medium">PNG, JPG or WEBP (Max 5MB)</p>
                    </>
                  )}
                </div>
                <input 
                  type="file" 
                  className="hidden" 
                  accept="image/*"
                  disabled={isUploadingImage}
                  onChange={handleImageUpload} 
                />
              </label>
            )}
          </div>

          <div>
            <label className="font-bold text-sm ml-1 mb-1 block">Category</label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="w-full bg-[#F4F4F4] border-2 border-black rounded-xl px-4 py-2 font-medium focus:outline-none focus:shadow-[4px_4px_0px_0px_#F26B4D]"
            >
              <option value="">No category</option>
              {categories.map(c => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
              <option value={NEW_CATEGORY}>+ New category…</option>
            </select>

            {creatingCategory ? (
              <div className="mt-2">
                <input
                  autoFocus
                  value={newCategory}
                  onChange={e => setNewCategory(e.target.value)}
                  maxLength={40}
                  placeholder="e.g. Rajasthan Board"
                  aria-label="New category name"
                  className="w-full bg-white border-2 border-black rounded-xl px-4 py-2 font-medium focus:outline-none focus:shadow-[4px_4px_0px_0px_#F26B4D]"
                />
                {/*
                  The id is shown before saving, not after.

                  "HP Board" and "hp board" become the same category, and that
                  is the whole reason custom names are safe — but it is
                  surprising unless you can see it happening. Showing the slug
                  is also how a teacher notices they are about to recreate a
                  category that already exists under another spelling.
                */}
                {newCategory.trim() && (
                  <p className="text-xs font-medium mt-1 text-gray-600">
                    Saved as <span className="font-mono font-bold">{slugifyCategory(newCategory) || '—'}</span>
                    {categories.some(c => c.id === slugifyCategory(newCategory)) && (
                      <span className="text-amber-700"> — this matches an existing category, and will be filed under it.</span>
                    )}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-gray-500 font-medium mt-1">
                Decides which filter students find this course under on their home
                screen. Leave blank and it shows under "All" only.
              </p>
            )}
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="font-bold text-sm ml-1 mb-1 block">Price (₹)</label>
              <input type="number" min="0" required value={price} onChange={e => setPrice(e.target.value)} className="w-full bg-[#F4F4F4] border-2 border-black rounded-xl px-4 py-2 font-medium focus:outline-none focus:shadow-[4px_4px_0px_0px_#F26B4D]" />
            </div>
            <div className="flex-1">
              <label className="font-bold text-sm ml-1 mb-1 block">Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)} className="w-full bg-[#F4F4F4] border-2 border-black rounded-xl px-4 py-2 font-medium focus:outline-none focus:shadow-[4px_4px_0px_0px_#F26B4D]">
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </div>
          </div>

          <div>
            <label className="font-bold text-sm ml-1 mb-1 block">Access validity</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                max={validityUnit === 'minutes' ? 1440 : 120}
                step="1"
                value={validityMonths}
                onChange={e => setValidityMonths(e.target.value)}
                placeholder="Lifetime"
                className="w-28 bg-[#F4F4F4] border-2 border-black rounded-xl px-4 py-2 font-medium focus:outline-none focus:shadow-[4px_4px_0px_0px_#F26B4D]"
              />
              <select
                value={validityUnit}
                onChange={e => setValidityUnit(e.target.value)}
                className="bg-[#F4F4F4] border-2 border-black rounded-xl px-3 py-2 font-bold text-sm focus:outline-none focus:shadow-[4px_4px_0px_0px_#F26B4D]"
              >
                <option value="months">months</option>
                <option value="minutes">minutes (testing)</option>
              </select>
            </div>
            {validityUnit === 'minutes' && (
              <p className="text-xs font-bold text-amber-800 bg-amber-50 border-2 border-amber-400 rounded-lg px-2 py-1.5 mt-2">
                Testing mode — access really will expire this fast. Switch back
                to months before students buy this course.
              </p>
            )}
            <p className="text-xs text-gray-500 font-medium mt-1">
              How long a student keeps access after buying. Leave blank for
              lifetime access.
              {course && ' Changing this affects future purchases only — students who have already paid keep the validity they bought.'}
            </p>
          </div>

          <div className="flex justify-end gap-3 mt-2">
            <button type="button" onClick={onClose} className="px-6 py-2 border-[3px] border-black rounded-xl font-bold hover:bg-gray-100 transition-colors">Cancel</button>
            <Button type="submit" variant="primary" className="py-2" disabled={isSubmitting || isUploadingImage}>
              {isSubmitting ? 'Saving...' : submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}