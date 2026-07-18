import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { infraApi } from '../services/api';
import { useToast } from '../components/Toast';

export function useInfraRestart(pendingProfiles: string[], previousProfiles: string[]) {
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState(0);
  const [restartStatus, setRestartStatus] = useState<'idle' | 'restarting' | 'waiting' | 'success' | 'error'>('idle');

  const checkServerHealth = async (stopCountdown?: () => void) => {
    let attempts = 0;
    const maxAttempts = 60;

    const check = async () => {
      try {
        await infraApi.healthCheck();
        stopCountdown?.();
        setRestartCountdown(0);
        setRestartStatus('success');
        setTimeout(() => window.location.reload(), 2000);
      } catch {
        attempts++;
        if (attempts < maxAttempts) setTimeout(check, 1000);
        else setRestartStatus('error');
      }
    };

    setTimeout(check, 3000);
  };

  const handleRestart = async () => {
    setRestartStatus('restarting');
    setRestartCountdown(30);

    const profilesToRemove = previousProfiles.filter(p => !pendingProfiles.includes(p));

    try {
      const response = await infraApi.restart(pendingProfiles, profilesToRemove);
      if (response.estimatedTime) setRestartCountdown(response.estimatedTime);
    } catch {
      // Expected — server shutting down
    }

    setRestartStatus('waiting');
    let intervalRef: ReturnType<typeof setInterval> | null = null;
    const stopCountdown = () => {
      if (intervalRef) {
        clearInterval(intervalRef);
        intervalRef = null;
      }
    };

    intervalRef = setInterval(() => {
      setRestartCountdown(prev => {
        if (prev <= 1) {
          stopCountdown();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    checkServerHealth(stopCountdown);
  };

  return { showRestartModal, setShowRestartModal, restartCountdown, restartStatus, handleRestart };
}

export function useInfraBackup() {
  const { t } = useTranslation();
  const toast = useToast();
  const [migrating, setMigrating] = useState(false);

  // Download a JSON backup of all Data-DB tables. Called BEFORE a DB switch (while still on the old
  // database) so the data can be re-imported into the new one — switching otherwise starts empty (#488).
  const handleExportBackup = async () => {
    setMigrating(true);
    try {
      const dump = await infraApi.exportData();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `openwa-backup-${dump.exportedAt?.slice(0, 10) || 'data'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(t('infrastructure.migration.exportFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setMigrating(false);
    }
  };

  // Restore a previously-exported backup into the CURRENT database (use after switching + restart).
  // Import REPLACES all current data, so validate + confirm (showing the row count) before any call.
  const handleImportBackup = async (file: File) => {
    let parsed: { tables?: Record<string, unknown[]> };
    try {
      parsed = JSON.parse(await file.text()) as { tables?: Record<string, unknown[]> };
    } catch {
      toast.error(t('infrastructure.migration.importFailed'), t('infrastructure.migration.invalidFile'));
      return;
    }
    if (!parsed?.tables || typeof parsed.tables !== 'object') {
      toast.error(t('infrastructure.migration.importFailed'), t('infrastructure.migration.invalidFile'));
      return;
    }
    const rows = Object.values(parsed.tables).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
    if (!window.confirm(t('infrastructure.migration.importConfirm', { rows }))) return;
    setMigrating(true);
    try {
      const res = await infraApi.importData(parsed.tables);
      if (res.imported) toast.success(t('infrastructure.migration.importOk'));
      else toast.error(t('infrastructure.migration.importFailed'), (res.warnings || []).slice(0, 3).join('; ') || res.message);
    } catch (err) {
      // A large backup can exceed the request body cap (default 25mb) — give an actionable message
      // instead of a bare "Payload Too Large". The status is carried on the Error by the api client.
      const status = (err as { status?: number } | null)?.status;
      const detail =
        status === 413
          ? t('infrastructure.migration.importTooLarge')
          : err instanceof Error
            ? err.message
            : t('common.unknownError');
      toast.error(t('infrastructure.migration.importFailed'), detail);
    } finally {
      setMigrating(false);
    }
  };

  return { migrating, handleExportBackup, handleImportBackup };
}
