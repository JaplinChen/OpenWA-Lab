import { useTranslation } from 'react-i18next';
import { Loader2, Trash2, X } from 'lucide-react';
import type { MessageTemplate } from '../../services/api';

export function TemplateDeleteModal({
  target,
  deleting,
  onClose,
  onDelete,
}: {
  target: MessageTemplate;
  deleting: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={event => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('templates.deleteTitle')}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <p>{t('templates.deleteConfirm', { name: target.name })}</p>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-danger" onClick={onDelete} disabled={deleting}>
            {deleting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
            {t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
