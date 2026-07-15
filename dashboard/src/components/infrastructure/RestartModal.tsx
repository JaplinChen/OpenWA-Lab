import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, CheckCircle, Download } from 'lucide-react';

interface RestartModalProps {
  status: 'idle' | 'restarting' | 'waiting' | 'success' | 'error';
  countdown: number;
  dbSwitch: boolean;
  storageSwitch: boolean;
  migrating: boolean;
  onExportBackup: () => void;
  onRestart: () => void;
  onClose: () => void;
  onReloadPage: () => void;
}

export function RestartModal({
  status,
  countdown,
  dbSwitch,
  storageSwitch,
  migrating,
  onExportBackup,
  onRestart,
  onClose,
  onReloadPage,
}: RestartModalProps) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: '500px', textAlign: 'center' }}>
        <div className="modal-header" style={{ justifyContent: 'center', borderBottom: 'none' }}>
          <h2>
            {status === 'idle' && t('infrastructure.restart.idleTitle')}
            {status === 'restarting' && t('infrastructure.restart.restartingTitle')}
            {status === 'waiting' && t('infrastructure.restart.waitingTitle')}
            {status === 'success' && t('infrastructure.restart.successTitle')}
            {status === 'error' && t('infrastructure.restart.errorTitle')}
          </h2>
        </div>
        <div className="modal-body" style={{ padding: '2rem' }}>
          {status === 'idle' && (
            <>
              <p style={{ fontSize: '1rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                <Trans i18nKey="infrastructure.restart.idleDesc" components={{ code: <code />, br: <br /> }} />
              </p>
              {(dbSwitch || storageSwitch) && (
                <div className="migration-warning">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>{t('infrastructure.migration.title')}</strong>
                    {dbSwitch && <p>{t('infrastructure.migration.dbWarning')}</p>}
                    {storageSwitch && <p>{t('infrastructure.migration.storageWarning')}</p>}
                    {dbSwitch && (
                      <button className="btn-secondary btn-sm" onClick={onExportBackup} disabled={migrating}>
                        {migrating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                        {t('infrastructure.migration.downloadBackup')}
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                <button className="btn-secondary" onClick={onClose}>
                  {t('infrastructure.restart.later')}
                </button>
                <button className="btn-primary" onClick={onRestart}>
                  {t('infrastructure.restart.now')}
                </button>
              </div>
            </>
          )}

          {(status === 'restarting' || status === 'waiting') && (
            <>
              <div style={{ marginBottom: '1.5rem' }}>
                <Loader2 className="animate-spin" size={48} style={{ color: 'var(--success)', marginBottom: '1rem' }} />
                <p style={{ fontSize: '1.125rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                  {countdown > 0
                    ? t('infrastructure.restart.restartingMsg', { count: countdown })
                    : t('infrastructure.restart.checking')}
                </p>
              </div>
              <div
                style={{
                  width: '100%',
                  height: '8px',
                  background: 'var(--border)',
                  borderRadius: '4px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: countdown > 0 ? `${((30 - countdown) / 30) * 100}%` : '100%',
                    height: '100%',
                    background: 'linear-gradient(90deg, #22C55E, #10B981)',
                    transition: 'width 1s linear',
                  }}
                />
              </div>
              <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                {t('infrastructure.restart.dontClose')}
              </p>
            </>
          )}

          {status === 'success' && (
            <>
              <CheckCircle size={48} style={{ color: 'var(--success)', marginBottom: '1rem' }} />
              <p style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>
                {t('infrastructure.restart.successMsg')}
              </p>
            </>
          )}

          {status === 'error' && (
            <>
              <p style={{ fontSize: '1rem', color: 'var(--error)', marginBottom: '1rem' }}>
                {t('infrastructure.restart.errorMsg')}
              </p>
              <button className="btn-primary" onClick={onReloadPage}>
                {t('infrastructure.restart.reload')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
