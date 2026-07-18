import { useTranslation } from 'react-i18next';
import { X, Check } from 'lucide-react';
import type { Webhook, WebhookFilters, Session, Chat } from '../../services/api';
import { FilterBuilder } from '../FilterBuilder';
import { availableEventNames, supportsFilters } from './webhook-events';

export type NewWebhookState = {
  url: string;
  events: string[];
  sessionId: string;
  filters: WebhookFilters | null;
};

export function CreateWebhookModal({
  newWebhook,
  setNewWebhook,
  sessions,
  chats,
  onClose,
  onCreate,
  onToggleEvent,
}: {
  newWebhook: NewWebhookState;
  setNewWebhook: React.Dispatch<React.SetStateAction<NewWebhookState>>;
  sessions: Session[];
  chats: Chat[];
  onClose: () => void;
  onCreate: () => void;
  onToggleEvent: (event: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('webhooks.createTitle')}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <label>{t('webhooks.session')}</label>
          <select
            value={newWebhook.sessionId}
            onChange={e => setNewWebhook({ ...newWebhook, sessionId: e.target.value })}
          >
            <option value="">{t('webhooks.selectSession')}</option>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <label>{t('common.url')}</label>
          <input
            type="url"
            placeholder="https://..."
            value={newWebhook.url}
            onChange={e => setNewWebhook({ ...newWebhook, url: e.target.value })}
          />
          <label>{t('webhooks.events')}</label>
          <div className="event-tags">
            {availableEventNames.map(name => {
              const isSelected = newWebhook.events.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  className={`event-tag ${isSelected ? 'selected' : ''}`}
                  onClick={() => onToggleEvent(name)}
                >
                  {isSelected && <Check size={12} className="tag-check-icon" />}
                  {name}
                </button>
              );
            })}
          </div>
          {supportsFilters(newWebhook.events) && (
            <FilterBuilder
              filters={newWebhook.filters}
              onChange={filters => setNewWebhook(prev => ({ ...prev, filters }))}
              chats={chats}
            />
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={onCreate}>
            {t('common.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditWebhookModal({
  editWebhook,
  setEditWebhook,
  chats,
  onClose,
  onSave,
  onToggleEvent,
}: {
  editWebhook: Webhook;
  setEditWebhook: React.Dispatch<React.SetStateAction<Webhook | null>>;
  chats: Chat[];
  onClose: () => void;
  onSave: () => void;
  onToggleEvent: (event: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('webhooks.editTitle')}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <label>{t('common.url')}</label>
          <input
            type="url"
            value={editWebhook.url}
            onChange={e => setEditWebhook({ ...editWebhook, url: e.target.value })}
          />
          <label>{t('webhooks.events')}</label>
          <div className="event-tags">
            {availableEventNames.map(name => {
              const isSelected = editWebhook.events.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  className={`event-tag ${isSelected ? 'selected' : ''}`}
                  onClick={() => onToggleEvent(name)}
                >
                  {isSelected && <Check size={12} className="tag-check-icon" />}
                  {name}
                </button>
              );
            })}
          </div>
          {supportsFilters(editWebhook.events) && (
            <FilterBuilder
              filters={editWebhook.filters}
              onChange={filters => setEditWebhook(prev => (prev ? { ...prev, filters } : prev))}
              chats={chats}
            />
          )}
          <div className="toggle-group">
            <span className="toggle-label">{t('common.status')}</span>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={editWebhook.active}
                onChange={e => setEditWebhook({ ...editWebhook, active: e.target.checked })}
              />
              <span className="toggle-slider"></span>
            </label>
            <span className={`toggle-status ${editWebhook.active ? 'active' : 'inactive'}`}>
              {editWebhook.active ? t('common.active') : t('common.inactive')}
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={onSave}>
            {t('webhooks.saveChanges')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeleteWebhookModal({
  url,
  onClose,
  onDelete,
}: {
  url: string;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('webhooks.deleteTitle')}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <p>{t('webhooks.deleteConfirm')}</p>
          <code className="webhook-delete-url">{url}</code>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-danger" onClick={onDelete}>
            {t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
