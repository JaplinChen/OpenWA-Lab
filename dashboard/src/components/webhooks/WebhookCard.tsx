import { useTranslation } from 'react-i18next';
import { Edit, Trash2, Play, ExternalLink, Loader2 } from 'lucide-react';
import type { Webhook } from '../../services/api';
import { FilterBadge } from './FilterBadge';

export function WebhookCard({
  webhook,
  sessionName,
  canWrite,
  testing,
  onTest,
  onEdit,
  onDelete,
}: {
  webhook: Webhook;
  sessionName: string;
  canWrite: boolean;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="webhook-card">
      <div className="webhook-card-header">
        <div className="webhook-url-row">
          <ExternalLink size={16} className="webhook-url-icon" />
          <code className="webhook-url">{webhook.url}</code>
        </div>
        <div className="webhook-card-actions">
          <button className="icon-btn" title={t('webhooks.actions.test')} onClick={onTest} disabled={testing}>
            {testing ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          </button>
          {canWrite && (
            <>
              <button className="icon-btn" title={t('webhooks.actions.edit')} onClick={onEdit}>
                <Edit size={16} />
              </button>
              <button className="icon-btn danger" title={t('webhooks.actions.delete')} onClick={onDelete}>
                <Trash2 size={16} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="webhook-card-body">
        <div className="webhook-meta">
          <div className="webhook-meta-item">
            <span className="webhook-meta-label">{t('webhooks.columns.session')}</span>
            <span className="webhook-meta-value">{sessionName}</span>
          </div>
          <div className="webhook-meta-item">
            <span className="webhook-meta-label">{t('webhooks.columns.status')}</span>
            <span className={`status-badge ${webhook.active ? 'active' : 'inactive'}`}>
              {webhook.active ? t('common.active') : t('common.inactive')}
            </span>
          </div>
        </div>
        <div className="webhook-events">
          <span className="webhook-meta-label">{t('webhooks.columns.events')}</span>
          <div className="events-cell">
            {webhook.events.map((event: string) => (
              <span key={event} className="event-tag">
                {event}
              </span>
            ))}
            {webhook.filters?.conditions?.length ? <FilterBadge filters={webhook.filters} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
