'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { useConnectionStore } from '@/stores/connection';
import { switchToSession } from '@/lib/gateway';

interface Session {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export function SessionSwitcher() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const sessionId = useConnectionStore((s) => s.sessionId);

  const fetchSessions = useCallback(async () => {
    try {
      const resp = await fetch('/api/sessions');
      if (resp.ok) {
        const data = await resp.json() as { sessions?: Session[] };
        setSessions(data.sessions ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (open) fetchSessions();
  }, [open, fetchSessions]);

  const currentSession = sessions.find((s) => s.id === sessionId);

  const handleSwitch = useCallback((id: string) => {
    setOpen(false);
    if (id === sessionId) return;
    switchToSession(id);
  }, [sessionId]);

  const createSession = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Session ${new Date().toLocaleString()}` }),
      });
      if (resp.ok) {
        const data = await resp.json() as { id?: string };
        if (data.id) {
          setOpen(false);
          switchToSession(data.id);
        }
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  const deleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      if (id === sessionId) {
        await createSession();
      } else {
        await fetchSessions();
      }
    } catch { /* ignore */ }
  }, [sessionId, fetchSessions, createSession]);

  const startRename = useCallback((id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenaming(id);
    setRenameValue(name);
  }, []);

  const submitRename = useCallback(async (id: string) => {
    try {
      await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameValue }),
      });
      await fetchSessions();
    } catch { /* ignore */ }
    finally { setRenaming(null); }
  }, [renameValue, fetchSessions]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
        title="Switch session"
      >
        <span className="max-w-[110px] truncate">
          {currentSession?.name ?? (sessionId ? 'Session' : 'No session')}
        </span>
        <ChevronDown size={9} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
            <div className="max-h-60 overflow-y-auto p-1">
              {sessions.length === 0 && (
                <p className="px-3 py-2 text-xs text-zinc-600">No sessions found</p>
              )}
              {sessions.map((s) => (
                <div
                  key={s.id}
                  onClick={() => handleSwitch(s.id)}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-zinc-800 ${s.id === sessionId ? 'text-zinc-100' : 'text-zinc-400'}`}
                >
                  {renaming === s.id ? (
                    <>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void submitRename(s.id);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-100 outline-none ring-1 ring-zinc-600"
                      />
                      <button
                        onClick={(e) => { e.stopPropagation(); void submitRename(s.id); }}
                        className="text-zinc-400 hover:text-zinc-100"
                      >
                        <Check size={10} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setRenaming(null); }}
                        className="text-zinc-400 hover:text-zinc-100"
                      >
                        <X size={10} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 truncate">{s.name}</span>
                      {s.id === sessionId && (
                        <span className="text-[9px] text-zinc-600">active</span>
                      )}
                      <button
                        onClick={(e) => startRename(s.id, s.name, e)}
                        className="hidden text-zinc-600 hover:text-zinc-300 group-hover:block"
                        title="Rename"
                      >
                        <Pencil size={10} />
                      </button>
                      {sessions.length > 1 && (
                        <button
                          onClick={(e) => void deleteSession(s.id, e)}
                          className="hidden text-zinc-600 hover:text-red-400 group-hover:block"
                          title="Delete"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="border-t border-zinc-800 p-1">
              <button
                onClick={() => void createSession()}
                disabled={loading}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
              >
                <Plus size={10} />
                New session
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
