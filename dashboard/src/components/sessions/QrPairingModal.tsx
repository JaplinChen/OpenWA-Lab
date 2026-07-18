import { Trans, useTranslation } from 'react-i18next';
import { RefreshCw, Loader2, X } from 'lucide-react';
import type { useQrPairing } from '../../hooks/useQrPairing';

interface QrPairingModalProps {
  qr: ReturnType<typeof useQrPairing>;
}

export function QrPairingModal({ qr }: QrPairingModalProps) {
  const { t } = useTranslation();
  const {
    qrData,
    pairingMode,
    setPairingMode,
    phoneNumber,
    setPhoneNumber,
    pairingCode,
    setPairingCode,
    requestingPairing,
    pairingError,
    setPairingError,
    handleCloseQRModal,
    handleGeneratePairingCode,
  } = qr;

  if (!qrData) return null;

  return (
    <div className="modal-overlay" onClick={handleCloseQRModal}>
      <div className="modal qr-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <h2>{pairingMode ? t('sessions.pairing.tabPhone') : t('sessions.qr.title')}</h2>
            <span className="session-name">{qrData.sessionName}</span>
          </div>
          <button className="btn-close" onClick={handleCloseQRModal} aria-label={t('common.close')}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          {!pairingCode && (
            <div className="pairing-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={!pairingMode}
                className={`pairing-tab-btn ${!pairingMode ? 'active' : ''}`}
                onClick={() => {
                  setPairingMode(false);
                  setPairingError(null);
                }}
              >
                {t('sessions.pairing.tabQr')}
              </button>
              <button
                role="tab"
                aria-selected={pairingMode}
                className={`pairing-tab-btn ${pairingMode ? 'active' : ''}`}
                onClick={() => {
                  setPairingMode(true);
                  setPairingError(null);
                }}
              >
                {t('sessions.pairing.tabPhone')}
              </button>
            </div>
          )}

          {!pairingMode ? (
            // QR Code Content
            qrData.qrCode ? (
              <>
                <img src={qrData.qrCode} alt="QR" className="qr-image" />
                <div className="qr-instructions">
                  <p className="qr-step">
                    <Trans i18nKey="sessions.qr.step1" components={{ strong: <strong /> }} />
                  </p>
                  <p className="qr-step">
                    <Trans i18nKey="sessions.qr.step2" components={{ strong: <strong /> }} />
                  </p>
                  <p className="qr-step">
                    <Trans i18nKey="sessions.qr.step3" components={{ strong: <strong /> }} />
                  </p>
                </div>
                <p className="qr-auto-refresh">
                  <RefreshCw size={14} className="spin-slow" /> {t('sessions.qr.autoRefresh')}
                </p>
              </>
            ) : (
              <div className="qr-loading">
                <Loader2 className="animate-spin" size={48} />
                <p>{t('sessions.qr.generating')}</p>
              </div>
            )
          ) : (
            // Pairing Code Content
            <div className="pairing-container" role="tabpanel">
              {pairingError && <div className="pairing-error">{pairingError}</div>}

              {!pairingCode ? (
                <div className="pairing-form">
                  <label htmlFor="pairing-phone" className="pairing-label">
                    {t('sessions.pairing.phoneLabel')}
                  </label>
                  <input
                    id="pairing-phone"
                    className="pairing-input"
                    type="tel"
                    inputMode="numeric"
                    maxLength={15}
                    placeholder={t('sessions.pairing.phonePlaceholder')}
                    value={phoneNumber}
                    onChange={e => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={e => e.key === 'Enter' && handleGeneratePairingCode()}
                  />
                  <p className="input-hint pairing-phone-hint">{t('sessions.pairing.phoneHint')}</p>
                  <button
                    className="btn-primary pairing-generate-btn"
                    onClick={handleGeneratePairingCode}
                    disabled={requestingPairing || !/^[0-9]{6,15}$/.test(phoneNumber.trim())}
                  >
                    {requestingPairing ? (
                      <>
                        <Loader2 className="animate-spin" size={16} />
                        <span className="pairing-generating-label">{t('sessions.pairing.generating')}</span>
                      </>
                    ) : (
                      t('sessions.pairing.generateButton')
                    )}
                  </button>
                </div>
              ) : (
                <>
                  <label className="pairing-code-label">{t('sessions.pairing.codeLabel')}</label>
                  <div className="pairing-code-display">
                    {pairingCode.substring(0, 4)} - {pairingCode.substring(4)}
                  </div>

                  <div className="qr-instructions">
                    <p className="pairing-instructions-title">{t('sessions.pairing.instructions')}</p>
                    <p className="qr-step">
                      <Trans i18nKey="sessions.pairing.step1" components={{ strong: <strong /> }} />
                    </p>
                    <p className="qr-step">
                      <Trans i18nKey="sessions.pairing.step2" components={{ strong: <strong /> }} />
                    </p>
                    <p className="qr-step">
                      <Trans i18nKey="sessions.pairing.step3" components={{ strong: <strong /> }} />
                    </p>
                    <p className="qr-step">
                      <Trans i18nKey="sessions.pairing.step4" components={{ strong: <strong /> }} />
                    </p>
                  </div>

                  <div className="pairing-change-wrap">
                    <button
                      className="btn-secondary pairing-change-btn"
                      onClick={() => {
                        setPairingCode(null);
                        setPhoneNumber('');
                      }}
                    >
                      {t('sessions.pairing.changeNumber')}
                    </button>
                  </div>

                  <p className="qr-auto-refresh">
                    <RefreshCw size={14} className="spin-slow" /> {t('sessions.pairing.waitingConnection')}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
