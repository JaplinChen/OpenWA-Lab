import { Trans, useTranslation } from 'react-i18next';
import { X, Check, Copy, Loader2, AlertTriangle } from 'lucide-react';
import type { ConfirmAction } from './useApiKeyColumns';

const roleNames = ['admin', 'operator', 'viewer'] as const;
export { roleNames };

export function CreateKeyModal({
  createdKey,
  newKey,
  setNewKey,
  copied,
  creating,
  onClose,
  onCreate,
  onCopy,
}: {
  createdKey: string | null;
  newKey: { name: string; role: string };
  setNewKey: (key: { name: string; role: string }) => void;
  copied: string | null;
  creating: boolean;
  onClose: () => void;
  onCreate: () => void;
  onCopy: (text: string, id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{createdKey ? t('apiKeys.createdTitle') : t('apiKeys.modalTitle')}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          {createdKey ? (
            <div>
              <p className="created-key-hint">{t('apiKeys.createdHint')}</p>
              <div className="created-key-row">
                <code className="created-key-value">{createdKey}</code>
                <button className="btn-primary" onClick={() => onCopy(createdKey, 'modal')}>
                  {copied === 'modal' ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            </div>
          ) : (
            <>
              <label>{t('common.name')}</label>
              <input
                type="text"
                placeholder={t('apiKeys.namePlaceholder')}
                value={newKey.name}
                onChange={e => setNewKey({ ...newKey, name: e.target.value })}
              />
              <label>{t('common.role')}</label>
              <select value={newKey.role} onChange={e => setNewKey({ ...newKey, role: e.target.value })}>
                {roleNames.map(r => (
                  <option key={r} value={r}>
                    {t(`apiKeys.roles.${r}`)}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        {!createdKey && (
          <div className="modal-footer">
            <button className="btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button className="btn-primary" onClick={onCreate} disabled={creating || !newKey.name}>
              {creating ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConfirmActionModal({
  confirmAction,
  onClose,
  onConfirm,
}: {
  confirmAction: ConfirmAction;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {confirmAction.type === 'delete'
              ? t('apiKeys.confirm.deleteTitle')
              : t('apiKeys.confirm.revokeTitle')}
          </h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <div className="confirm-icon-wrapper">
            <AlertTriangle size={48} className="confirm-warning-icon" />
          </div>
          <p className="confirm-message">
            <Trans
              i18nKey={
                confirmAction.type === 'delete'
                  ? 'apiKeys.confirm.deleteMessage'
                  : 'apiKeys.confirm.revokeMessage'
              }
              values={{ name: confirmAction.name }}
              components={{ strong: <strong /> }}
            />
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-danger" onClick={onConfirm}>
            {confirmAction.type === 'delete'
              ? t('apiKeys.confirm.delete')
              : t('apiKeys.confirm.revoke')}
          </button>
        </div>
      </div>
    </div>
  );
}
