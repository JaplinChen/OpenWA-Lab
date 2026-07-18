import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionApi, type Session } from '../services/api';

export interface QrData {
  sessionId: string;
  sessionName: string;
  qrCode: string;
}

interface QrPairingOptions {
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  fetchSessions: () => Promise<Session[]>;
}

export function useQrPairing({ sessions, sessionsRef, fetchSessions }: QrPairingOptions) {
  const { t } = useTranslation();
  const [qrData, setQrData] = useState<QrData | null>(null);
  const [pairingMode, setPairingMode] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [requestingPairing, setRequestingPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const qrRefreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentSessionName = useRef<string>('');

  const fetchQR = useCallback(
    async (sessionId: string) => {
      // Guard: if session is already connected, stop polling immediately. Read the ref (not `sessions`)
      // so fetchQR keeps a stable identity — otherwise the polling interval is torn down and restarted on
      // every sessions update.
      const currentSession = sessionsRef.current.find(s => s.id === sessionId);
      if (currentSession?.status === 'ready') {
        setQrData(null);
        currentSessionName.current = '';
        return;
      }
      try {
        const qr = await sessionApi.getQR(sessionId);
        setQrData({ sessionId, sessionName: currentSessionName.current, qrCode: qr.qrCode });
        if (qr.status === 'ready') {
          setQrData(null);
          currentSessionName.current = '';
          fetchSessions();
        }
      } catch {
        // Keep qrData alive so the polling interval keeps retrying until the QR
        // is ready. Only stop polling if the session itself has failed. 'authenticating' is included so
        // the modal (and the pairing-code panel mounted in it) survives the brief post-link handshake
        // instead of being torn down mid-pairing — it closes on the real 'ready'/'failed' transition.
        const updated = await sessionApi.get(sessionId).catch(() => null);
        const stillInitializing =
          updated && ['initializing', 'connecting', 'qr_ready', 'authenticating'].includes(updated.status);
        if (!stillInitializing) {
          setQrData(null);
          currentSessionName.current = '';
          fetchSessions();
        }
      }
    },
    [sessionsRef, fetchSessions],
  );

  useEffect(() => {
    if (qrData) {
      currentSessionName.current = qrData.sessionName;
      qrRefreshInterval.current = setInterval(() => {
        fetchQR(qrData.sessionId);
      }, 5000);
    }
    return () => {
      if (qrRefreshInterval.current) clearInterval(qrRefreshInterval.current);
    };
  }, [qrData, fetchQR]);

  const handleCloseQRModal = useCallback(() => {
    setQrData(null);
    setPairingMode(false);
    setPhoneNumber('');
    setPairingCode(null);
    setPairingError(null);
  }, []);

  const handleGeneratePairingCode = async () => {
    // Guard against a second concurrent request: the button is disabled while in flight, but the
    // input's Enter handler is not, so a rapid double-Enter would otherwise fire overlapping POSTs.
    if (requestingPairing) return;
    if (!qrData || !phoneNumber.trim()) return;
    if (!/^[0-9]{6,15}$/.test(phoneNumber.trim())) {
      setPairingError(t('sessions.pairing.invalidPhone'));
      return;
    }
    try {
      setRequestingPairing(true);
      setPairingError(null);
      const res = await sessionApi.requestPairingCode(qrData.sessionId, phoneNumber.trim());
      setPairingCode(res.pairingCode);
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : t('common.errorGeneric'));
    } finally {
      setRequestingPairing(false);
    }
  };

  const handleShowQR = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    // Nothing to show for an already-connected session.
    if (session?.status === 'ready') return;
    const sessionName = session?.name || '';
    // Reset any pairing sub-state from a previous open so a freshly opened modal never shows a
    // stale code/phone belonging to a different session.
    setPairingMode(false);
    setPhoneNumber('');
    setPairingCode(null);
    setPairingError(null);
    // Show loading state immediately so the modal opens and polling starts
    // even before Chromium has finished initializing.
    setQrData({ sessionId: id, sessionName, qrCode: '' });
    currentSessionName.current = sessionName;
    try {
      const qr = await sessionApi.getQR(id);
      setQrData({ sessionId: id, sessionName, qrCode: qr.qrCode });
    } catch (err) {
      console.error('Failed to get QR:', err);
      // Do not clear qrData here — keep the loading modal open so the
      // polling interval (every 5 s) retries until the QR becomes available.
    }
  };

  const closeForSession = (id: string) => {
    if (qrData?.sessionId === id) setQrData(null);
  };

  return {
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
    handleShowQR,
    closeForSession,
  };
}
