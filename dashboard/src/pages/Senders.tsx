import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Check, AlertTriangle, X, Search, Plus, Trash2, AtSign, Download, Pencil } from 'lucide-react';
import { translateApi, type SenderEntry } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useResizableCol } from '../hooks/useResizableCol';
import { useRole } from '../hooks/useRole';
import { useSessionsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { pageWindow } from '../utils/pageWindow';
import './Glossary.css';

const PAGE_SIZE = 50;

const READY_STATUSES = ['ready', 'connecting', 'qr_ready', 'idle'];

export function Senders() {
  const { t } = useTranslation();
  useDocumentTitle(t('senders.title'));
  const { canWrite } = useRole();

  const [entries, setEntries] = useState<SenderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [jid, setJid] = useState('');
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<'jid' | 'name' | 'count'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  // The jid is the record's key, so the row being edited is tracked by its original jid; renaming
  // one has to drop the old key, which `editing` still holds.
  const [editing, setEditing] = useState<string | null>(null);
  const [editJid, setEditJid] = useState('');
  const [editName, setEditName] = useState('');

  const { data: sessions = [] } = useSessionsQuery();

  useEffect(() => {
    if (sessionId || sessions.length === 0) return;
    const ready = sessions.find(s => READY_STATUSES.includes(s.status)) ?? sessions[0];
    setSessionId(ready.id);
  }, [sessions, sessionId]);

  useEffect(() => {
    let active = true;
    translateApi
      .getSenders()
      .then(list => active && setEntries(list))
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? entries.filter(e => `${e.jid}\n${e.name}`.toLowerCase().includes(q)) : [...entries];
    const dir = sortDir === 'asc' ? 1 : -1;
    return list.sort((a, b) =>
      sortKey === 'count'
        ? ((a.count ?? 0) - (b.count ?? 0)) * dir || a.name.localeCompare(b.name)
        : a[sortKey].localeCompare(b[sortKey], undefined, { numeric: true }) * dir,
    );
  }, [entries, filter, sortKey, sortDir]);

  const toggleSort = (key: 'jid' | 'name' | 'count') => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'count' ? 'desc' : 'asc');
    }
  };

  const sortMark = (key: 'jid' | 'name' | 'count') =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const { ref: panelRef, onResizeStart } = useResizableCol('senders-col-src');

  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const paged = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const fail = (err: unknown) =>
    setToast({
      type: 'error',
      message: t('common.failed', { message: err instanceof Error ? err.message : 'unknown' }),
    });

  const add = async () => {
    const j = jid.trim();
    const n = name.trim();
    if (!j || !n) return;
    setBusy(true);
    try {
      setEntries(await translateApi.addSender(j, n));
      setJid('');
      setName('');
      setToast({ type: 'success', message: t('senders.added') });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const importFromContacts = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const { added, entries: next } = await translateApi.importSenders(sessionId);
      setEntries(next);
      setToast({
        type: 'success',
        message: t('senders.imported', { added }),
      });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setBusy(true);
    try {
      setEntries(await translateApi.removeSender(target));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (entry: SenderEntry) => {
    setEditing(entry.jid);
    setEditJid(entry.jid);
    setEditName(entry.name);
  };

  const cancelEdit = () => setEditing(null);

  const saveEdit = async (original: string) => {
    const j = editJid.trim();
    const n = editName.trim();
    if (!j || !n) return;
    if (j === original && n === entries.find(entry => entry.jid === original)?.name) {
      setEditing(null);
      return;
    }
    setBusy(true);
    try {
      // POST upserts on the jid, so an unchanged jid is a plain overwrite. A changed one writes a
      // new record, which leaves the old key behind until it is removed. The backend normalizes a
      // jid down to its digits (@200.../200...@c.us all collapse), so compare on digits: retyping
      // the same number in a different form must not delete the row that was just written.
      const digits = (v: string) => v.replace(/\D/g, '');
      let list = await translateApi.addSender(j, n);
      if (digits(j) !== digits(original)) list = await translateApi.removeSender(original);
      setEntries(list);
      setEditing(null);
      setToast({ type: 'success', message: t('common.saved') });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="glossary-page glossary-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="glossary-page">
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      <PageHeader
        title={t('senders.title')}
        subtitle={t('senders.subtitle')}
        actions={
          canWrite && (
            <div className="senders-import">
              <select
                aria-label={t('common.session')}
                value={sessionId}
                onChange={e => setSessionId(e.target.value)}
              >
                {sessions.length === 0 && (
                  <option value="">{t('senders.noSessions')}</option>
                )}
                {sessions.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.status})
                  </option>
                ))}
              </select>
              <button className="btn-primary" onClick={importFromContacts} disabled={busy || !sessionId}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                {t('senders.import')}
              </button>
            </div>
          )
        }
      />

      <section className="glossary-panel" ref={panelRef as React.RefObject<HTMLElement>}>
        <div className="glossary-head">
          <h3 className="glossary-panel-title">
            {t('senders.entries')}
            <span className="glossary-count">{entries.length}</span>
          </h3>
        </div>

        {canWrite && (
          <div className="glossary-add">
            <input
              type="text"
              placeholder={t('senders.jid')}
              aria-label={t('senders.jid')}
              value={jid}
              onChange={e => setJid(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
            />
            <span className="glossary-arrow">→</span>
            <input
              type="text"
              placeholder={t('senders.name')}
              aria-label={t('senders.name')}
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
            />
            <button className="btn-primary" onClick={add} disabled={busy || !jid.trim() || !name.trim()}>
              <Plus size={16} />
              {t('senders.add')}
            </button>
          </div>
        )}

        <div className="glossary-search">
          <Search size={16} className="glossary-search-icon" />
          <input
            type="text"
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>

        {filtered.length > 0 && (
          <div className="glossary-cols">
            <button className="glossary-col-sort" onClick={() => toggleSort('jid')}>
              {t('senders.jid')}{sortMark('jid')}
            </button>
            <span className="glossary-col-resize" aria-hidden="true" onMouseDown={onResizeStart}>→</span>
            <button className="glossary-col-sort" onClick={() => toggleSort('name')}>
              {t('senders.name')}{sortMark('name')}
            </button>
            <button className="glossary-col-sort glossary-col-sort--num" onClick={() => toggleSort('count')}>
              {t('common.usageCount')}{sortMark('count')}
            </button>
            {canWrite && <span className="glossary-col-label">{t('common.actions')}</span>}
          </div>
        )}
        <div className="glossary-list">
          {filtered.length === 0 ? (
            <div className="glossary-empty">
              <AtSign size={32} strokeWidth={1} />
              <p>{t('senders.empty')}</p>
            </div>
          ) : (
            paged.map(e =>
              editing === e.jid ? (
                <div key={e.jid} className="glossary-item glossary-item--editing">
                  <input
                    className="glossary-edit"
                    value={editJid}
                    aria-label={t('senders.jid')}
                    autoFocus
                    onChange={ev => setEditJid(ev.target.value)}
                    onKeyDown={ev => {
                      if (ev.key === 'Enter') void saveEdit(e.jid);
                      if (ev.key === 'Escape') cancelEdit();
                    }}
                  />
                  <span className="glossary-arrow">→</span>
                  <input
                    className="glossary-edit"
                    value={editName}
                    aria-label={t('senders.name')}
                    onChange={ev => setEditName(ev.target.value)}
                    onKeyDown={ev => {
                      if (ev.key === 'Enter') void saveEdit(e.jid);
                      if (ev.key === 'Escape') cancelEdit();
                    }}
                  />
                  <div className="glossary-row-actions">
                    <button
                      className="glossary-del"
                      onClick={() => void saveEdit(e.jid)}
                      disabled={busy || !editJid.trim() || !editName.trim()}
                      title={t('common.save')}
                    >
                      <Check size={16} />
                    </button>
                    <button className="glossary-del" onClick={cancelEdit} disabled={busy} title={t('common.cancel')}>
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <div key={e.jid} className="glossary-item">
                  <span className="glossary-src">@{e.jid}</span>
                  <span className="glossary-arrow">→</span>
                  <span className="glossary-tgt">{e.name}</span>
                  <span className="glossary-usage" title={t('common.usageCount')}>{e.count ?? 0}</span>
                  {canWrite && (
                    <div className="glossary-row-actions">
                      <button
                        className="glossary-del"
                        onClick={() => startEdit(e)}
                        disabled={busy}
                        title={t('common.edit')}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="glossary-del"
                        onClick={() => remove(e.jid)}
                        disabled={busy}
                        title={t('common.delete')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )}
                </div>
              ),
            )
          )}
        </div>

        {totalPages > 1 && (
          <div className="pagination">
            <button disabled={current === 1} onClick={() => setPage(current - 1)}>
              {t('common.previous')}
            </button>
            <span className="page-numbers">
              {pageWindow(current, totalPages).map(p => (
                <button key={p} className={p === current ? 'active' : ''} onClick={() => setPage(p)}>
                  {p}
                </button>
              ))}
            </span>
            <button disabled={current >= totalPages} onClick={() => setPage(current + 1)}>
              {t('common.next')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default Senders;
