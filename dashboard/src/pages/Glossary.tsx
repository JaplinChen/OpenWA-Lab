import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, BookMarked } from 'lucide-react';
import { translateApi, type GlossaryTerm, type PendingGlossaryTerm, type TranslationCandidate, type PhraseCandidate } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { EditableKeyValueTable } from '../components/EditableKeyValueTable';
import { GlossaryPending } from './GlossaryPending';
import { MemoryCandidates } from './MemoryCandidates';
import '../components/EditableTable.css';

export function Glossary() {
  const { t } = useTranslation();
  useDocumentTitle(t('glossary.title'));
  const { canWrite } = useRole();
  const toast = useToast();

  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [pending, setPending] = useState<PendingGlossaryTerm[]>([]);
  const [candidates, setCandidates] = useState<TranslationCandidate[]>([]);
  const [phrases, setPhrases] = useState<PhraseCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [tab, setTab] = useState<'candidates' | 'phrases' | 'terms'>('candidates');

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
    translateApi
      .getMemoryCandidates()
      .then(list => active && setCandidates(list))
      .catch(err => active && fail(err));
    translateApi
      .getPhraseCandidates()
      .then(list => active && setPhrases(list))
      .catch(err => active && fail(err));
    return () => {
      active = false;
    };
  }, []);

  const scanPhrases = async () => {
    setScanning(true);
    try {
      setPhrases(await translateApi.scanPhraseCandidates());
    } catch (err) {
      fail(err);
    } finally {
      setScanning(false);
    }
  };

  const approvePhrase = async (id: number) => {
    setBusy(true);
    try {
      setPhrases(await translateApi.approvePhraseCandidate(id));
      setTerms(await translateApi.getGlossary());
      toast.success(t('glossary.candidateApproved'));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const dismissPhrase = async (id: number) => {
    setBusy(true);
    try {
      setPhrases(await translateApi.dismissPhraseCandidate(id));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const approveCandidate = async (id: number) => {
    setBusy(true);
    try {
      setCandidates(await translateApi.approveMemoryCandidate(id));
      setTerms(await translateApi.getGlossary());
      toast.success(t('glossary.candidateApproved'));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const dismissCandidate = async (id: number) => {
    setBusy(true);
    try {
      setCandidates(await translateApi.dismissMemoryCandidate(id));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const fail = (err: unknown) =>
    toast.error(t('common.failed', { message: err instanceof Error ? err.message : 'unknown' }));

  const add = async (zh: string, vi: string, category?: string) => {
    setBusy(true);
    try {
      setTerms(await translateApi.addGlossaryTerm(zh, vi, category));
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

  const saveEdit = async (original: string, zh: string, vi: string, category?: string) => {
    setBusy(true);
    try {
      // POST upserts on the source key, so an unchanged source is a plain overwrite. A changed
      // one writes a new record, which leaves the old key behind until it is removed.
      let list = await translateApi.addGlossaryTerm(zh, vi, category);
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

      <div className="etable-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'candidates'}
          className={`etable-tab ${tab === 'candidates' ? 'active' : ''}`}
          onClick={() => setTab('candidates')}
        >
          {t('glossary.candidatesTitle')}
          <span className="etable-count">{candidates.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'phrases'}
          className={`etable-tab ${tab === 'phrases' ? 'active' : ''}`}
          onClick={() => setTab('phrases')}
        >
          {t('glossary.phrasesTitle')}
          <span className="etable-count">{phrases.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'terms'}
          className={`etable-tab ${tab === 'terms' ? 'active' : ''}`}
          onClick={() => setTab('terms')}
        >
          {t('glossary.terms')}
          <span className="etable-count">{terms.length}</span>
        </button>
      </div>

      {tab === 'candidates' && (
        <MemoryCandidates
          candidates={candidates}
          canWrite={canWrite}
          busy={busy}
          onApprove={approveCandidate}
          onDismiss={dismissCandidate}
        />
      )}

      {tab === 'phrases' && (
        <>
          <section className="etable-panel">
            {/* No panel title: the glossary tab bar already shows this count. */}
            <p className="etable-empty">{t('glossary.phrasesHint')}</p>
            {canWrite && (
              <button className="etable-add" onClick={scanPhrases} disabled={scanning}>
                {scanning ? <Loader2 className="animate-spin" size={16} /> : null}
                {t('glossary.phrasesScan')}
              </button>
            )}
          </section>
          {/* Reuse the memory-candidate row UI: phrase maps onto the source column. */}
          <MemoryCandidates
            candidates={phrases.map(p => ({ id: p.id, pairKey: '', source: p.phrase, translated: p.translated, count: p.count, at: p.at }))}
            canWrite={canWrite}
            busy={busy}
            onApprove={approvePhrase}
            onDismiss={dismissPhrase}
          />
        </>
      )}

      {tab === 'terms' && (
        <>
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
            hideTitle
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
            categoryLabel={t('glossary.category.label')}
            categoryOptions={[
              { value: '', label: t('glossary.category.unset') },
              { value: 'name', label: t('glossary.category.name') },
              { value: 'dept', label: t('glossary.category.dept') },
              { value: 'term', label: t('glossary.category.term') },
              { value: 'asset', label: t('glossary.category.asset') },
              { value: 'phrase', label: t('glossary.category.phrase') },
              { value: 'other', label: t('glossary.category.other') },
            ]}
            rowCategory={g => g.category ?? ''}
            onAdd={add}
            onSaveEdit={saveEdit}
            onRemove={remove}
          />
        </>
      )}
    </div>
  );
}

export default Glossary;
