import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Smartphone, Search, Loader, LogOut, ChevronDown, ChevronUp } from 'lucide-react';
import { fetchAPI } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';

const card = 'border-2 border-black rounded-xl bg-white shadow-[2px_2px_0px_0px_#111]';
const btn = 'h-9 px-3 flex items-center gap-1.5 border-2 border-black rounded-xl font-bold text-xs shadow-[2px_2px_0px_0px_#111] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0px_0px_#111] transition-all disabled:opacity-60';

const when = (d) => (d ? new Date(d).toLocaleString() : '—');

/**
 * Admin → Device management.
 *
 * One number — how many devices a student may be signed in on at once — and a
 * list of students' signed-in devices so an admin can free a slot for someone
 * who lost a phone or hit the limit.
 */
export default function DeviceManagementPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [limit, setLimit] = useState('');
  const [savedLimit, setSavedLimit] = useState(null);
  const [max, setMax] = useState(20);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [open, setOpen] = useState(null);      // user id whose devices are shown
  const [devices, setDevices] = useState([]);
  const [busy, setBusy] = useState(null);       // id of the row being signed out

  const loadUsers = useCallback(async (q = '') => {
    try {
      const data = await fetchAPI(`/devices/users?q=${encodeURIComponent(q)}`);
      setUsers(data.users || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    fetchAPI('/devices/settings')
      .then((d) => {
        setSavedLimit(d.limit);
        setLimit(d.limit ? String(d.limit) : '');
        if (d.max) setMax(d.max);
      })
      .catch((err) => setError(err.message));
    loadUsers();
  }, [user, loadUsers]);

  // Search as the admin types, debounced.
  useEffect(() => {
    if (user?.role !== 'admin') return;
    const t = setTimeout(() => loadUsers(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query, user, loadUsers]);

  if (user && user.role !== 'admin') {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center">
        <p className="font-bold text-gray-600">Device management is available to admins only.</p>
        <button onClick={() => navigate('/dashboard')} className={`${btn} mx-auto mt-4 bg-[#A7E2D1]`}>
          Back to dashboard
        </button>
      </div>
    );
  }

  const saveLimit = async (value) => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const d = await fetchAPI('/devices/settings', {
        method: 'PUT',
        body: JSON.stringify({ limit: value === '' ? null : Number(value) }),
      });
      setSavedLimit(d.limit);
      setLimit(d.limit ? String(d.limit) : '');
      setNotice(d.limit
        ? `Saved. Students can now be signed in on up to ${d.limit} device${d.limit === 1 ? '' : 's'}.`
        : 'Saved. Students can sign in on any number of devices.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (u) => {
    if (open === u.id) { setOpen(null); return; }
    setOpen(u.id);
    setDevices([]);
    try {
      const d = await fetchAPI(`/devices/users/${u.id}`);
      setDevices(d.devices || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const signOutDevice = async (u, device) => {
    setBusy(device.id);
    try {
      await fetchAPI(`/devices/sessions/${device.id}`, { method: 'DELETE' });
      setDevices((list) => list.filter((d) => d.id !== device.id));
      setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, active_devices: Math.max(0, x.active_devices - 1) } : x)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const signOutAll = async (u) => {
    if (!window.confirm(`Sign ${u.name} out of every device?`)) return;
    setBusy(u.id);
    try {
      await fetchAPI(`/devices/users/${u.id}`, { method: 'DELETE' });
      if (open === u.id) setDevices([]);
      setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, active_devices: 0 } : x)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const dirty = (limit === '' ? null : Number(limit)) !== savedLimit;

  return (
    <div className="max-w-4xl mx-auto pb-20">
      <div className="mb-3">
        <h1 className="text-lg md:text-2xl font-black">Device Management</h1>
        <p className="text-[11px] md:text-sm font-bold text-gray-500">
          Control how many devices each student can be signed in on at the same time.
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-3 px-3 py-2 border-2 border-black rounded-xl bg-red-100 text-red-800 font-bold text-xs">
          {error}
        </div>
      )}

      {/* Limit */}
      <section className={`${card} p-4 mb-5`}>
        <h2 className="font-black text-sm mb-1">Device limit per student</h2>
        <p className="text-xs font-bold text-gray-500 mb-3">
          When a student signs in on a new device while already at the limit, the device they used least
          recently is signed out automatically. Teachers and admins are not limited.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            max={max}
            value={limit}
            onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="No limit"
            aria-label="Maximum devices per student"
            className="w-28 h-9 px-2 border-2 border-black rounded-xl text-sm font-bold"
          />
          <span className="text-xs font-bold text-gray-600">devices</span>
          <button
            onClick={() => saveLimit(limit)}
            disabled={saving || !dirty || (limit !== '' && (Number(limit) < 1 || Number(limit) > max))}
            className={`${btn} bg-[#A7E2D1]`}
          >
            {saving && <Loader size={13} className="animate-spin" />} Save
          </button>
          {savedLimit && (
            <button onClick={() => saveLimit('')} disabled={saving} className={`${btn} bg-white`}>
              Turn off limit
            </button>
          )}
        </div>
        <p className="mt-2 text-[11px] font-bold text-gray-600">
          Currently: {savedLimit ? `${savedLimit} device${savedLimit === 1 ? '' : 's'} per student` : 'no limit'}
        </p>
        {notice && <p className="mt-1 text-[11px] font-bold text-green-700">{notice}</p>}
      </section>

      {/* Students */}
      <section>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h2 className="font-black text-sm">Signed-in students</h2>
          <div className="relative w-full max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email or phone"
              className="w-full h-9 pl-8 pr-2 border-2 border-black rounded-xl text-xs font-bold"
            />
          </div>
        </div>

        {loading ? (
          <p className="text-center font-bold text-gray-400 py-8">Loading…</p>
        ) : users.length === 0 ? (
          <div className={`${card} p-6 text-center`}>
            <Smartphone size={26} className="mx-auto mb-2 text-gray-500" />
            <p className="font-bold text-sm text-gray-600">
              {query ? 'No students match that search.' : 'No students are signed in on any device yet.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {users.map((u) => {
              const atLimit = savedLimit && u.active_devices >= savedLimit;
              return (
                <div key={u.id} className={card}>
                  <div className="flex items-center gap-2 p-2.5">
                    <button onClick={() => toggle(u)} className="min-w-0 flex-1 flex items-center gap-2 text-left">
                      {open === u.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      <div className="min-w-0">
                        <p className="font-black text-sm truncate">{u.name}</p>
                        <p className="text-[11px] font-bold text-gray-500 truncate">{u.email || u.phone}</p>
                      </div>
                    </button>
                    <span className={`shrink-0 px-2 py-0.5 border-2 border-black rounded-full text-[11px] font-black ${atLimit ? 'bg-amber-200' : 'bg-gray-100'}`}>
                      {u.active_devices}{savedLimit ? ` / ${savedLimit}` : ''} device{u.active_devices === 1 ? '' : 's'}
                    </span>
                    <button
                      onClick={() => signOutAll(u)}
                      disabled={!u.active_devices || busy === u.id}
                      className={`${btn} bg-white text-red-600 shrink-0`}
                    >
                      <LogOut size={13} /> <span className="hidden sm:inline">Sign out all</span>
                    </button>
                  </div>

                  {open === u.id && (
                    <div className="border-t-2 border-black p-2.5 flex flex-col gap-1.5 bg-gray-50 rounded-b-xl">
                      {devices.length === 0 ? (
                        <p className="text-xs font-bold text-gray-500">Not signed in on any device.</p>
                      ) : devices.map((d) => (
                        <div key={d.id} className="flex items-center gap-2 text-xs">
                          <Smartphone size={14} className="shrink-0 text-gray-600" />
                          <div className="min-w-0 flex-1">
                            <p className="font-bold">{d.device_name || 'Unknown device'}</p>
                            <p className="text-[10px] font-bold text-gray-500">
                              Signed in {when(d.created_at)} · last active {when(d.last_seen_at)}{d.ip ? ` · ${d.ip}` : ''}
                            </p>
                          </div>
                          <button
                            onClick={() => signOutDevice(u, d)}
                            disabled={busy === d.id}
                            className={`${btn} h-7 bg-white text-red-600`}
                          >
                            Sign out
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
