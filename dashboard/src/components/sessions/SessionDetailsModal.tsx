import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { Session } from '../../services/api';

interface SessionDetailsModalProps {
  session: Session;
  onClose: () => void;
}

export function SessionDetailsModal({ session, onClose }: SessionDetailsModalProps) {
  const { t } = useTranslation();
  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('sessions.details.title')}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <div className="detail-grid">
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.name')}</span>
              <span className="detail-value">{session.name}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.status')}</span>
              <span className={`status-badge ${session.status}`}>{formatStatus(session.status)}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.sessionId')}</span>
              <span className="detail-value mono">{session.id}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.phone')}</span>
              <span className="detail-value">{session.phone || t('sessions.details.phoneNone')}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.created')}</span>
              <span className="detail-value">{new Date(session.createdAt).toLocaleString()}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.lastActive')}</span>
              <span className="detail-value">
                {session.lastActive ? new Date(session.lastActive).toLocaleString() : t('common.never')}
              </span>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
