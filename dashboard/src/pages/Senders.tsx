import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Check, AlertTriangle, X, Search, Plus, Trash2, AtSign, Download } from 'lucide-react';
import { translateApi, type SenderEntry } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './Glossary.css';

const READY_STATUSES = ['ready', 'connecting', 'qr_ready', 'idle'];

export function Senders() {
  const { t } = useTranslation();
  useDocumentTitle(t('senders.title', { defaultValue: 'Senders' }));
  const { canWrite } = useRole();

  const [entries, setEntries] = useState<SenderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [jid, setJid] = useState('');
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

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
    if (!q) return entries;
    return entries.filter(e => `${e.jid}\n${e.name}`.toLowerCase().includes(q));
  }, [entries, filter]);

  const fail = (err: unknown) =>
    setToast({
      type: 'error',
      message: t('senders.saveFailed', {
        defaultValue: 'Failed: {{message}}',
        message: err instanceof Error ? err.message : 'unknown',
      }),
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
      setToast({ type: 'success', message: t('senders.added', { defaultValue: 'Sender added' }) });
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
        message: t('senders.imported', { defaultValue: 'Imported {{added}} contact(s)', added }),
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
        title={t('senders.title', { defaultValue: 'Senders (@提及 對照表)' })}
        subtitle={t('senders.subtitle', {
          defaultValue: 'Map an unresolved @mention JID to a display name used in translations.',
        })}
        actions={
          canWrite && (
            <div className="senders-import">
              <select
                aria-label={t('common.session')}
                value={sessionId}
                onChange={e => setSessionId(e.target.value)}
              >
                {sessions.length === 0 && (
                  <option value="">{t('senders.noSessions', { defaultValue: 'No sessions' })}</option>
                )}
                {sessions.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.status})
                  </option>
                ))}
              </select>
              <button className="btn-primary" onClick={importFromContacts} disabled={busy || !sessionId}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                {t('senders.import', { defaultValue: 'Import from contacts' })}
              </button>
            </div>
          )
        }
      />

      <section className="glossary-panel">
        <div className="glossary-head">
          <h3 className="glossary-panel-title">
            {t('senders.entries', { defaultValue: 'Overrides' })}
            <span className="glossary-count">{entries.length}</span>
          </h3>
        </div>

        {canWrite && (
          <div className="glossary-add">
            <input
              type="text"
              placeholder={t('senders.jid', { defaultValue: 'JID 或 @號碼' })}
              aria-label={t('senders.jid', { defaultValue: 'JID 或 @號碼' })}
              value={jid}
              onChange={e => setJid(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
            />
            <span className="glossary-arrow">→</span>
            <input
              type="text"
              placeholder={t('senders.name', { defaultValue: '顯示名稱' })}
              aria-label={t('senders.name', { defaultValue: '顯示名稱' })}
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
            />
            <button className="btn-primary" onClick={add} disabled={busy || !jid.trim() || !name.trim()}>
              <Plus size={16} />
              {t('senders.add', { defaultValue: 'Add' })}
            </button>
          </div>
        )}

        <div className="glossary-search">
          <Search size={16} className="glossary-search-icon" />
          <input
            type="text"
            placeholder={t('senders.search', { defaultValue: 'Search...' })}
            aria-label={t('senders.search', { defaultValue: 'Search...' })}
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>

        <div className="glossary-list">
          {filtered.length === 0 ? (
            <div className="glossary-empty">
              <AtSign size={32} strokeWidth={1} />
              <p>{t('senders.empty', { defaultValue: 'No sender overrides yet.' })}</p>
            </div>
          ) : (
            filtered.map(e => (
              <div key={e.jid} className="glossary-item">
                <span className="glossary-src">@{e.jid}</span>
                <span className="glossary-arrow">→</span>
                <span className="glossary-tgt">{e.name}</span>
                {canWrite && (
                  <button
                    className="glossary-del"
                    onClick={() => remove(e.jid)}
                    disabled={busy}
                    title={t('senders.remove', { defaultValue: 'Remove' })}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

export default Senders;
