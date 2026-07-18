import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, BookMarked } from 'lucide-react';
import { translateApi, type GlossaryTerm, type PendingGlossaryTerm } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { EditableKeyValueTable } from '../components/EditableKeyValueTable';
import { GlossaryPending } from './GlossaryPending';
import '../components/EditableTable.css';

export function Glossary() {
  const { t } = useTranslation();
  useDocumentTitle(t('glossary.title'));
  const { canWrite } = useRole();
  const toast = useToast();

  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [pending, setPending] = useState<PendingGlossaryTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    translateApi
      .getGlossary()
      .then(list => active && setTerms(list))
      .catch(err => active && fail(err))
      .finally(() => active && setLoading(false));
    translateApi
      .getPendingGlossary()
      .then(list => active && setPending(list))
      .catch(err => active && fail(err));
    return () => {
      active = false;
    };
  }, []);

  const fail = (err: unknown) =>
    toast.error(t('common.failed', { message: err instanceof Error ? err.message : 'unknown' }));

  const add = async (zh: string, vi: string) => {
    setBusy(true);
    try {
      setTerms(await translateApi.addGlossaryTerm(zh, vi));
      toast.success(t('glossary.added'));
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (term: string) => {
    setBusy(true);
    try {
      setTerms(await translateApi.removeGlossaryTerm(term));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (original: string, zh: string, vi: string) => {
    setBusy(true);
    try {
      // POST upserts on the source key, so an unchanged source is a plain overwrite. A changed
      // one writes a new record, which leaves the old key behind until it is removed.
      let list = await translateApi.addGlossaryTerm(zh, vi);
      if (zh !== original) list = await translateApi.removeGlossaryTerm(original);
      setTerms(list);
      toast.success(t('common.saved'));
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const refetch = async () => {
    const [list, pend] = await Promise.all([
      translateApi.getGlossary(),
      translateApi.getPendingGlossary(),
    ]);
    setTerms(list);
    setPending(pend);
  };

  const approve = async (id: number) => {
    setBusy(true);
    try {
      await translateApi.approvePendingGlossary(id);
      await refetch();
      toast.success(t('glossary.approved'));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id: number) => {
    setBusy(true);
    try {
      await translateApi.rejectPendingGlossary(id);
      setPending(await translateApi.getPendingGlossary());
      toast.success(t('glossary.rejected'));
    } catch (err) {
      fail(err);
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
        title={t('glossary.title')}
        subtitle={t('glossary.subtitle')}
      />

      <GlossaryPending
        pending={pending}
        canWrite={canWrite}
        busy={busy}
        onApprove={approve}
        onReject={reject}
      />

      {/* The glossary maps 中文 to Tiếng Việt, so the key/val labels name the languages themselves
          and are written in their own script, as a language picker would. */}
      <EditableKeyValueTable
        rows={terms}
        titleLabel={t('glossary.terms')}
        keyLabel="中文"
        valLabel="Tiếng Việt"
        addLabel={t('glossary.add')}
        emptyIcon={<BookMarked size={32} strokeWidth={1} />}
        emptyText={t('glossary.empty')}
        canWrite={canWrite}
        busy={busy}
        resizeStorageKey="glossary-col-src"
        initialSortKey="key"
        rowKey={g => g.source}
        rowVal={g => g.target}
        rowCount={g => g.count ?? 0}
        compareKey={(a, b) => a.source.localeCompare(b.source)}
        compareVal={(a, b) => a.target.localeCompare(b.target)}
        tieBreak={(a, b) => a.source.localeCompare(b.source)}
        onAdd={add}
        onSaveEdit={saveEdit}
        onRemove={remove}
      />
    </div>
  );
}

export default Glossary;
