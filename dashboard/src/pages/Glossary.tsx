import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Check, AlertTriangle, X, Search, Plus, Trash2, BookMarked } from 'lucide-react';
import { translateApi, type GlossaryTerm } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import './Glossary.css';

export function Glossary() {
  const { t } = useTranslation();
  useDocumentTitle(t('glossary.title'));
  const { canWrite } = useRole();

  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [src, setSrc] = useState('');
  const [tgt, setTgt] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    translateApi
      .getGlossary()
      .then(list => active && setTerms(list))
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
    if (!q) return terms;
    return terms.filter(g => `${g.source}\n${g.target}`.toLowerCase().includes(q));
  }, [terms, filter]);

  const fail = (err: unknown) =>
    setToast({
      type: 'error',
      message: t('common.failed', { message: err instanceof Error ? err.message : 'unknown' }),
    });

  const add = async () => {
    const zh = src.trim();
    const vi = tgt.trim();
    if (!zh || !vi) return;
    setBusy(true);
    try {
      setTerms(await translateApi.addGlossaryTerm(zh, vi));
      setSrc('');
      setTgt('');
      setToast({ type: 'success', message: t('glossary.added') });
    } catch (err) {
      fail(err);
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
        title={t('glossary.title')}
        subtitle={t('glossary.subtitle')}
      />

      <section className="glossary-panel">
        <div className="glossary-head">
          <h3 className="glossary-panel-title">
            {t('glossary.terms')}
            <span className="glossary-count">{terms.length}</span>
          </h3>
        </div>

        {canWrite && (
          <div className="glossary-add">
            {/* The glossary maps 中文 to Tiếng Việt, so these two name the languages themselves and
                are written in their own script, as a language picker would. They were t() calls
                against keys that exist in no locale file, which read as translatable and never
                were. */}
            <input
              type="text"
              placeholder="中文"
              aria-label="中文"
              value={src}
              onChange={e => setSrc(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
            />
            <span className="glossary-arrow">→</span>
            <input
              type="text"
              placeholder="Tiếng Việt"
              aria-label="Tiếng Việt"
              value={tgt}
              onChange={e => setTgt(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
            />
            <button className="btn-primary" onClick={add} disabled={busy || !src.trim() || !tgt.trim()}>
              <Plus size={16} />
              {t('glossary.add')}
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

        <div className="glossary-list">
          {filtered.length === 0 ? (
            <div className="glossary-empty">
              <BookMarked size={32} strokeWidth={1} />
              <p>{t('glossary.empty')}</p>
            </div>
          ) : (
            filtered.map(g => (
              <div key={g.source} className="glossary-item">
                <span className="glossary-src">{g.source}</span>
                <span className="glossary-arrow">→</span>
                <span className="glossary-tgt">{g.target}</span>
                {canWrite && (
                  <button
                    className="glossary-del"
                    onClick={() => remove(g.source)}
                    disabled={busy}
                    title={t('common.delete')}
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

export default Glossary;
