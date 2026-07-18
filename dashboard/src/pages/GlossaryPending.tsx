import { useTranslation } from 'react-i18next';
import { Check, Trash2 } from 'lucide-react';
import type { PendingGlossaryTerm } from '../services/api';

interface Props {
  pending: PendingGlossaryTerm[];
  canWrite: boolean;
  busy: boolean;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
}

export function GlossaryPending({ pending, canWrite, busy, onApprove, onReject }: Props) {
  const { t } = useTranslation();
  if (pending.length === 0) return null;
  return (
    <section className="glossary-panel glossary-panel--pending">
      <h3 className="glossary-panel-title">
        {t('glossary.pendingTitle')}
        <span className="glossary-count">{pending.length}</span>
      </h3>
      <div className="glossary-list">
        {pending.map(p => (
          <div key={p.id} className="glossary-item glossary-item--pending">
            <span className="glossary-src">{p.zh}</span>
            <span className="glossary-arrow">→</span>
            <span className="glossary-tgt">{p.vi}</span>
            <span className="glossary-pending-meta">
              {t('glossary.suggestedBy', { name: p.suggestedBy })}
              {' · '}
              {new Date(p.at).toLocaleString()}
            </span>
            {canWrite && (
              <div className="glossary-row-actions">
                <button
                  className="glossary-del"
                  onClick={() => onApprove(p.id)}
                  disabled={busy}
                  title={t('glossary.approve')}
                >
                  <Check size={16} />
                </button>
                <button
                  className="glossary-del"
                  onClick={() => onReject(p.id)}
                  disabled={busy}
                  title={t('glossary.reject')}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
