import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle, Save } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useInfrastructureForm } from '../hooks/useInfrastructureForm';
import { PageHeader } from '../components/PageHeader';
import { PageLoader } from '../components/PageLoader';
import { DatabaseCard } from '../components/infrastructure/DatabaseCard';
import { EngineCard } from '../components/infrastructure/EngineCard';
import { RedisCard } from '../components/infrastructure/RedisCard';
import { StorageCard } from '../components/infrastructure/StorageCard';
import { RestartModal } from '../components/infrastructure/RestartModal';
import './Infrastructure.css';

export function Infrastructure() {
  const { t } = useTranslation();
  useDocumentTitle(t('infrastructure.title'));
  const {
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
  } = useInfrastructureForm();

  if (loading) {
    return (
      <PageLoader className="infrastructure-page" />
    );
  }

  // If the live infrastructure status can't be loaded, do NOT render the editable form: it would seed
  // from component defaults (sqlite/local/built-in:false) and a Save could flip a running backend to
  // external+empty. Show an error + retry instead. (#488 review)
  if (statusError || !infraStatus) {
    return (
      <div className="infrastructure-page">
        <PageHeader title={t('infrastructure.title')} subtitle={t('infrastructure.subtitle')} />
        <div className="infra-card" style={{ textAlign: 'center', padding: '2.5rem' }}>
          <AlertTriangle size={32} style={{ color: 'var(--warning, #d97706)', marginBottom: '1rem' }} />
          <p style={{ margin: 0 }}>{t('infrastructure.statusLoadError')}</p>
          <button className="btn-secondary" style={{ marginTop: '1.25rem' }} onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="infrastructure-page">
      <PageHeader title={t('infrastructure.title')} subtitle={t('infrastructure.subtitle')} />

      <div className="infra-sections">
        <DatabaseCard
          dbConfig={dbConfig}
          updateDbConfig={updateDbConfig}
          pinnedByEnv={dbPinnedByEnv}
          migrating={migrating}
          onExportBackup={handleExportBackup}
          onImportBackup={handleImportBackup}
        />

        <EngineCard
          engineConfig={engineConfig}
          updateEngineConfig={updateEngineConfig}
          engines={engines}
          currentEngine={currentEngine}
          infraStatus={infraStatus}
        />

        <RedisCard
          redisEnabled={redisEnabled}
          setRedisEnabled={setRedisEnabled}
          redisConfig={redisConfig}
          updateRedisConfig={updateRedisConfig}
          queueEnabled={queueEnabled}
          setQueueEnabled={setQueueEnabled}
          queueStats={queueStats}
          pinnedByEnv={redisPinnedByEnv}
        />

        <StorageCard
          storageConfig={storageConfig}
          updateStorageConfig={updateStorageConfig}
          infraStatus={infraStatus}
          pinnedByEnv={storagePinnedByEnv}
        />
      </div>

      {showRestartModal && (
        <RestartModal
          status={restartStatus}
          countdown={restartCountdown}
          dbSwitch={dbSwitch}
          storageSwitch={storageSwitch}
          migrating={migrating}
          onExportBackup={handleExportBackup}
          onRestart={handleRestart}
          onClose={() => setShowRestartModal(false)}
          onReloadPage={() => window.location.reload()}
        />
      )}

      <footer className="page-footer">
        <button className="btn-primary large" onClick={handleSaveConfig} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" size={20} /> : <Save size={20} />}
          {saving ? t('infrastructure.saving') : t('infrastructure.saveConfig')}
        </button>
      </footer>
    </div>
  );
}
