import { useTranslation } from 'react-i18next';
import { QrCode, RefreshCw, Trash2, Eye, Play, Square, Skull } from 'lucide-react';
import type { Session } from '../../services/api';

interface SessionCardProps {
  session: Session;
  canWrite: boolean;
  onView: (session: Session) => void;
  onShowQR: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onKill: (id: string) => void;
}

export function SessionCard({ session, canWrite, onView, onShowQR, onStart, onStop, onDelete, onKill }: SessionCardProps) {
  const { t } = useTranslation();

  const formatLastActive = (date?: string) => {
    if (!date) return t('common.never');
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return t('common.justNow');
    if (diff < 3600000) return t('common.minAgo', { count: Math.floor(diff / 60000) });
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });

  return (
    <div className="session-card">
      <div className="card-header">
        <h3 title={session.name}>{session.name}</h3>
        <span className={`status-pill ${session.status}`}>{formatStatus(session.status)}</span>
      </div>

      {session.status === 'initializing' || session.status === 'connecting' || session.status === 'qr_ready' ? (
        <div className="qr-placeholder">
          <QrCode size={80} className="qr-icon" />
          <p>{session.status === 'qr_ready' ? t('sessions.qr.scanToConnect') : t('sessions.qr.preparing')}</p>
          <button className="btn-sm" onClick={() => onShowQR(session.id)} disabled={session.status !== 'qr_ready'}>
            {session.status === 'qr_ready' ? t('sessions.qr.showQr') : t('sessions.qr.loading')}
          </button>
        </div>
      ) : (
        <div className="session-info">
          <div className="info-row">
            <span className="info-label">{t('sessions.card.phone')}</span>
            <span className="info-value">{session.phone || '—'}</span>
          </div>
          <div className="info-row">
            <span className="info-label">{t('sessions.card.sessionId')}</span>
            <span className="info-value mono">{session.id.substring(0, 12)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">{t('sessions.card.lastActive')}</span>
            <span className="info-value">{formatLastActive(session.lastActive)}</span>
          </div>
          {session.status === 'failed' && session.lastError ? (
            <div className="info-row session-error">
              <span className="info-label">{t('sessions.card.error')}</span>
              <span className="info-value error-text" title={session.lastError}>
                {session.lastError}
              </span>
            </div>
          ) : null}
        </div>
      )}

      <div className="card-actions">
        <button className="btn-action" onClick={() => onView(session)}>
          <Eye size={16} />
          {t('sessions.actions.view')}
        </button>
        {canWrite &&
        (session.status === 'created' || session.status === 'idle' || session.status === 'disconnected') ? (
          <button className="btn-action" onClick={() => onStart(session.id)}>
            <Play size={16} />
            {t('sessions.actions.start')}
          </button>
        ) : canWrite && ['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) ? (
          <button className="btn-action" onClick={() => onStop(session.id)}>
            <Square size={16} />
            {t('sessions.actions.stop')}
          </button>
        ) : canWrite ? (
          <button className="btn-action" onClick={() => onStart(session.id)}>
            <RefreshCw size={16} />
            {t('sessions.actions.reconnect')}
          </button>
        ) : null}
        {canWrite && (
          <button className="btn-action danger" onClick={() => onDelete(session.id)}>
            <Trash2 size={16} />
            {t('sessions.actions.delete')}
          </button>
        )}
        {canWrite && session.status === 'failed' && (
          <button className="btn-action danger" onClick={() => onKill(session.id)}>
            <Skull size={16} />
            {t('sessions.actions.killStuck')}
          </button>
        )}
      </div>
    </div>
  );
}
