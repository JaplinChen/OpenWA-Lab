import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { infraApi } from '../services/api';
import {
  useInfraStatusQuery,
  useInfraConfigQuery,
  useEnginesQuery,
  useCurrentEngineQuery,
} from './queries';
import { useToast } from '../components/Toast';
import type {
  DatabaseConfig,
  RedisConfig,
  StorageConfig,
  EngineConfig,
  QueueStats,
} from '../components/infrastructure/types';

export function useInfrastructureForm() {
  const { t } = useTranslation();
  const toast = useToast();
  const { data: infraStatus, isLoading: loading, isError: statusError } = useInfraStatusQuery();
  const { data: savedConfig } = useInfraConfigQuery();
  const { data: engines = [] } = useEnginesQuery();
  const { data: currentEngineData } = useCurrentEngineQuery();
  const currentEngine = currentEngineData?.engineType ?? '';
  const [saving, setSaving] = useState(false);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState(0);
  const [restartStatus, setRestartStatus] = useState<'idle' | 'restarting' | 'waiting' | 'success' | 'error'>('idle');

  const [dbConfig, setDbConfig] = useState<DatabaseConfig>({
    type: 'sqlite',
    builtIn: false,
    host: 'localhost',
    port: '5432',
    username: 'postgres',
    password: '',
    database: 'openwa',
    schema: 'public',
    poolSize: 10,
    sslEnabled: false,
    sslRejectUnauthorized: true,
  });

  const [redisConfig, setRedisConfig] = useState<RedisConfig>({
    builtIn: false,
    host: 'localhost',
    port: '6379',
    password: '',
    connected: false,
  });

  const [storageConfig, setStorageConfig] = useState<StorageConfig>({
    type: 'local',
    builtIn: false,
    localPath: './data/media',
    s3Bucket: '',
    s3Region: 'ap-southeast-1',
    s3AccessKey: '',
    s3SecretKey: '',
    s3Endpoint: '',
  });

  const [queueStats, setQueueStats] = useState({
    webhooks: { pending: 0, completed: 0, failed: 0 } as QueueStats,
  });

  const [engineConfig, setEngineConfig] = useState<EngineConfig>({
    type: 'whatsapp-web.js',
    headless: true,
    sessionDataPath: './data/sessions',
    browserArgs: '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu',
  });

  const [redisEnabled, setRedisEnabled] = useState(false);
  const [queueEnabled, setQueueEnabled] = useState(false);
  const [pendingProfiles, setPendingProfiles] = useState<string[]>([]);
  const [previousProfiles, setPreviousProfiles] = useState<string[]>([]);
  // Set when the just-saved config changes the DB or storage backend vs what's running, so the restart
  // modal can warn that the new backend starts empty and offer a data backup before switching (#488).
  const [dbSwitch, setDbSwitch] = useState(false);
  const [storageSwitch, setStorageSwitch] = useState(false);
  const [migrating, setMigrating] = useState(false);
  // After a successful save (before the restart reloads the page), /config holds the new value but
  // /status still holds the old one — so suppress the "pinned by environment" note, which infers a pin
  // from exactly that divergence and would otherwise mislabel a pending change.
  const [savePending, setSavePending] = useState(false);

  // Whether the editable form has been seeded from the server once. After that, a background refetch
  // (react-query refetchOnWindowFocus) must NOT re-seed the editable fields or it would wipe the
  // operator's in-progress, unsaved edits. A successful save restarts → full page reload, re-arming it.
  const formHydrated = useRef(false);

  // LIVE indicators (not editable) — always reflect the running process, every refetch.
  useEffect(() => {
    if (!infraStatus) return;
    setRedisConfig(prev => ({ ...prev, connected: infraStatus.redis.connected }));
    setQueueStats({ webhooks: infraStatus.queue.webhooks });
  }, [infraStatus]);

  // Seed the EDITABLE selections from live /status ONCE (the running selection), guarded so a refetch
  // can't clobber an unsaved edit. These are also the badge sources, so on first paint they show what's
  // actually running (#488 family).
  useEffect(() => {
    if (!infraStatus || formHydrated.current) return;
    setDbConfig(prev => ({
      ...prev,
      type: (infraStatus.database.type as 'sqlite' | 'postgres') || 'sqlite',
      host: infraStatus.database.host || 'localhost',
      // builtIn reflects whether OpenWA-Lab's bundled container is actually running (live), not saved intent.
      builtIn: infraStatus.database.builtIn,
    }));
    setRedisConfig(prev => ({
      ...prev,
      host: infraStatus.redis.host,
      port: String(infraStatus.redis.port),
      builtIn: infraStatus.redis.builtIn,
    }));
    setRedisEnabled(infraStatus.redis.enabled);
    setStorageConfig(prev => ({
      ...prev,
      type: infraStatus.storage.type,
      localPath: infraStatus.storage.path || './uploads',
      builtIn: infraStatus.storage.builtIn,
    }));
    setQueueEnabled(infraStatus.queue.enabled);
  }, [infraStatus]);

  // Hydrate the editable form from the saved config (data/.env.generated) ONCE — only the detail fields
  // /status does not expose (username, pool size, SSL flags, S3 details, host/port). The "what's
  // running" fields (type, redis enabled, storage type, built-in) are owned by the live /status effect
  // above. Secrets are never returned, so their inputs stay empty; an empty submit preserves the stored
  // secret on the backend (#226).
  useEffect(() => {
    if (!savedConfig || formHydrated.current) return;
    // NOTE: builtIn for db/redis/storage is owned by the live /status effect above (it reflects the
    // actually-running bundled container), so it is intentionally NOT set here from saved intent.
    setDbConfig(prev => ({
      ...prev,
      host: savedConfig.database.host || prev.host,
      port: savedConfig.database.port || prev.port,
      username: savedConfig.database.username || prev.username,
      database: savedConfig.database.database || prev.database,
      schema: savedConfig.database.schema || prev.schema,
      poolSize: savedConfig.database.poolSize,
      sslEnabled: savedConfig.database.sslEnabled,
      sslRejectUnauthorized: savedConfig.database.sslRejectUnauthorized,
    }));
    setRedisConfig(prev => ({
      ...prev,
      host: savedConfig.redis.host || prev.host,
      port: savedConfig.redis.port || prev.port,
    }));
    setStorageConfig(prev => ({
      ...prev,
      localPath: savedConfig.storage.localPath || prev.localPath,
      s3Bucket: savedConfig.storage.s3Bucket || prev.s3Bucket,
      s3Region: savedConfig.storage.s3Region || prev.s3Region,
      s3Endpoint: savedConfig.storage.s3Endpoint || prev.s3Endpoint,
    }));
    setEngineConfig(prev => ({
      ...prev,
      headless: savedConfig.engine.headless,
      sessionDataPath: savedConfig.engine.sessionDataPath || prev.sessionDataPath,
      browserArgs: savedConfig.engine.browserArgs || prev.browserArgs,
    }));
  }, [savedConfig]);

  // Lock the editable form once both sources have seeded it, so later background refetches only refresh
  // the live indicators above and never overwrite unsaved edits.
  useEffect(() => {
    if (infraStatus && savedConfig) formHydrated.current = true;
  }, [infraStatus, savedConfig]);

  // The active engine reflects what's actually running (honours a real-env ENGINE_TYPE override),
  // so seed the selected radio from it rather than the saved .env.generated value.
  useEffect(() => {
    if (currentEngine) setEngineConfig(prev => ({ ...prev, type: currentEngine }));
  }, [currentEngine]);

  const updateDbConfig = (key: keyof DatabaseConfig, value: string | number | boolean) =>
    setDbConfig(prev => ({ ...prev, [key]: value }));
  const updateRedisConfig = (key: keyof RedisConfig, value: string | boolean) =>
    setRedisConfig(prev => ({ ...prev, [key]: value }));
  const updateStorageConfig = (key: keyof StorageConfig, value: string | boolean) =>
    setStorageConfig(prev => ({ ...prev, [key]: value }));
  const updateEngineConfig = (key: keyof EngineConfig, value: string | boolean) =>
    setEngineConfig(prev => ({ ...prev, [key]: value }));

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const payload = {
        database: { ...dbConfig },
        redis: { enabled: redisEnabled, ...redisConfig },
        queue: { enabled: queueEnabled },
        storage: { ...storageConfig },
        engine: { ...engineConfig },
      };

      const result = await infraApi.saveConfig(payload);
      if (result.saved) {
        setSavePending(true);
        setPreviousProfiles(pendingProfiles);
        setPendingProfiles(result.profiles || []);
        // Flag a backend switch vs what's actually running so the restart modal can warn about the
        // empty-database / orphaned-media data move before it happens. A switch is: changing type;
        // flipping built-in↔external (different physical backend); OR retargeting an external Postgres
        // to a different host/port/database (also a different, empty DB). Host/port/db aren't all in
        // /status, so compare the edited form against the still-cached saved config.
        const dbExternalRetarget =
          dbConfig.type === 'postgres' &&
          !dbConfig.builtIn &&
          !!savedConfig &&
          (dbConfig.host !== savedConfig.database.host ||
            dbConfig.port !== savedConfig.database.port ||
            dbConfig.database !== savedConfig.database.database);
        setDbSwitch(
          !!infraStatus &&
            (dbConfig.type !== infraStatus.database.type ||
              (dbConfig.type === 'postgres' && dbConfig.builtIn !== infraStatus.database.builtIn) ||
              dbExternalRetarget),
        );
        // Scope: this warns on a backend-TYPE change (local↔s3) and a built-in↔external flip — the cases
        // that point at a different store. It does NOT warn on same-backend repointing (e.g. a new S3
        // bucket/endpoint or a new local path); region/endpoint aren't on /status to compare reliably.
        setStorageSwitch(
          !!infraStatus &&
            (storageConfig.type !== infraStatus.storage.type ||
              (storageConfig.type === 's3' && storageConfig.builtIn !== infraStatus.storage.builtIn)),
        );
        setShowRestartModal(true);
      } else {
        toast.error(t('infrastructure.toasts.saveFailed'), result.message);
      }
    } catch (err) {
      toast.error(t('infrastructure.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSaving(false);
    }
  };

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

  // A setting whose RUNNING value (/status) differs from the SAVED file (/config) is being pinned by a
  // host/.env environment variable, which wins at runtime — so a dashboard change to it won't apply
  // until that variable is unset. Surface that honestly instead of letting the control look effective.
  const dbPinnedByEnv =
    !savePending && !!infraStatus && !!savedConfig && infraStatus.database.type !== savedConfig.database.type;
  const redisPinnedByEnv =
    !savePending && !!infraStatus && !!savedConfig && infraStatus.redis.enabled !== savedConfig.redis.enabled;
  const storagePinnedByEnv =
    !savePending && !!infraStatus && !!savedConfig && infraStatus.storage.type !== savedConfig.storage.type;

  return {
    infraStatus,
    engines,
    currentEngine,
    loading,
    statusError,
    saving,
    showRestartModal,
    setShowRestartModal,
    restartCountdown,
    restartStatus,
    dbConfig,
    redisConfig,
    storageConfig,
    queueStats,
    engineConfig,
    redisEnabled,
    setRedisEnabled,
    queueEnabled,
    setQueueEnabled,
    dbSwitch,
    storageSwitch,
    migrating,
    updateDbConfig,
    updateRedisConfig,
    updateStorageConfig,
    updateEngineConfig,
    handleSaveConfig,
    handleExportBackup,
    handleImportBackup,
    handleRestart,
    dbPinnedByEnv,
    redisPinnedByEnv,
    storagePinnedByEnv,
  };
}
