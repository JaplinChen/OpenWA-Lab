import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AtSign, Download } from 'lucide-react';
import { translateApi, type SenderEntry } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionsQuery } from '../hooks/queries';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { EditableKeyValueTable } from '../components/EditableKeyValueTable';
import '../components/EditableTable.css';

const READY_STATUSES = ['ready', 'connecting', 'qr_ready', 'idle'];

export function Senders() {
  const { t } = useTranslation();
  useDocumentTitle(t('senders.title'));
  const { canWrite } = useRole();
  const toast = useToast();

  const [entries, setEntries] = useState<SenderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState('');

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

  const fail = (err: unknown) =>
    toast.error(t('common.failed', { message: err instanceof Error ? err.message : 'unknown' }));

  const add = async (jid: string, name: string) => {
    setBusy(true);
    try {
      setEntries(await translateApi.addSender(jid, name));
      toast.success(t('senders.added'));
      return true;
    } catch (err) {
      fail(err);
      return false;
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
      toast.success(t('senders.imported', { added }));
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

  const saveEdit = async (original: string, jid: string, name: string) => {
    setBusy(true);
    try {
      // POST upserts on the jid, so an unchanged jid is a plain overwrite. A changed one writes a
      // new record, which leaves the old key behind until it is removed. The backend normalizes a
      // jid down to its digits (@200.../200...@c.us all collapse), so compare on digits: retyping
      // the same number in a different form must not delete the row that was just written.
      const digits = (v: string) => v.replace(/\D/g, '');
      let list = await translateApi.addSender(jid, name);
      if (digits(jid) !== digits(original)) list = await translateApi.removeSender(original);
      setEntries(list);
      toast.success(t('common.saved'));
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="etable-page etable-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="etable-page">
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

      <EditableKeyValueTable
        rows={entries}
        titleLabel={t('senders.entries')}
        keyLabel={t('senders.jid')}
        valLabel={t('senders.name')}
        addLabel={t('senders.add')}
        emptyIcon={<AtSign size={32} strokeWidth={1} />}
        emptyText={t('senders.empty')}
        canWrite={canWrite}
        busy={busy}
        resizeStorageKey="senders-col-src"
        initialSortKey="val"
        rowKey={e => e.jid}
        rowVal={e => e.name}
        rowCount={e => e.count ?? 0}
        renderKey={e => `@${e.jid}`}
        compareKey={(a, b) => a.jid.localeCompare(b.jid, undefined, { numeric: true })}
        compareVal={(a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })}
        tieBreak={(a, b) => a.name.localeCompare(b.name)}
        onAdd={add}
        onSaveEdit={saveEdit}
        onRemove={remove}
      />
    </div>
  );
}

export default Senders;
