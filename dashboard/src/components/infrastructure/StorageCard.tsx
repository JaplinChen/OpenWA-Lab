import { useTranslation } from 'react-i18next';
import { HardDrive } from 'lucide-react';
import type { InfraStatus } from '../../services/api';
import { EnvPinNote } from './EnvPinNote';
import type { StorageConfig } from './types';
import folderIcon from '../../assets/icons/folder.svg';
import s3Icon from '../../assets/icons/s3.svg';

interface StorageCardProps {
  storageConfig: StorageConfig;
  updateStorageConfig: (key: keyof StorageConfig, value: string | boolean) => void;
  infraStatus: InfraStatus | undefined;
  pinnedByEnv: boolean;
}

export function StorageCard({ storageConfig, updateStorageConfig, infraStatus, pinnedByEnv }: StorageCardProps) {
  const { t } = useTranslation();
  return (
    <section className="infra-card">
      <div className="card-header">
        <div className="header-left">
          <HardDrive size={20} />
          <h2>{t('infrastructure.storage.title')}</h2>
        </div>
        {(() => {
          // S3 selected but the backend isn't reachable → warn instead of a misleading green.
          const s3Unreachable = storageConfig.type === 's3' && infraStatus?.storage.s3Available === false;
          const cls = storageConfig.type !== 's3' ? 'sqlite' : s3Unreachable ? 'disconnected' : 'connected';
          return (
            <span className={`status-indicator ${cls}`}>
              ● {storageConfig.type === 's3' ? (s3Unreachable ? t('infrastructure.storage.s3Unreachable') : 'S3') : 'Local'}
            </span>
          );
        })()}
      </div>
      <EnvPinNote pinned={pinnedByEnv} />

      <div className="radio-group">
        <label className={`radio-option ${storageConfig.type === 'local' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="storageType"
            checked={storageConfig.type === 'local'}
            onChange={() => updateStorageConfig('type', 'local')}
          />
          <img src={folderIcon} alt="" className="watermark-icon" />
          <span>{t('infrastructure.storage.local')}</span>
          <small>{t('infrastructure.storage.localDesc')}</small>
        </label>
        <label className={`radio-option ${storageConfig.type === 's3' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="storageType"
            checked={storageConfig.type === 's3'}
            onChange={() => updateStorageConfig('type', 's3')}
          />
          <img src={s3Icon} alt="" className="watermark-icon" />
          <span>{t('infrastructure.storage.s3')}</span>
          <small>{t('infrastructure.storage.s3Desc')}</small>
        </label>
      </div>

      <div className="config-form">
        {storageConfig.type === 'local' && (
          <div className="form-group">
            <label>{t('infrastructure.storage.storagePath')}</label>
            <input
              type="text"
              value={storageConfig.localPath}
              onChange={e => updateStorageConfig('localPath', e.target.value)}
            />
          </div>
        )}

        {storageConfig.type === 's3' && (
          <>
            <div className="toggle-row" style={{ marginTop: '1rem', marginBottom: '1rem' }}>
              <div className="toggle-info">
                <span>{t('infrastructure.storage.useBuiltIn')}</span>
                <small>{t('infrastructure.storage.builtInDesc')}</small>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={storageConfig.builtIn}
                  onChange={e => updateStorageConfig('builtIn', e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            {!storageConfig.builtIn && (
              <>
                <div className="form-row">
                  <div className="form-group">
                    <label>{t('infrastructure.storage.bucket')}</label>
                    <input
                      type="text"
                      value={storageConfig.s3Bucket}
                      onChange={e => updateStorageConfig('s3Bucket', e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label>{t('infrastructure.storage.region')}</label>
                    <input
                      type="text"
                      value={storageConfig.s3Region}
                      onChange={e => updateStorageConfig('s3Region', e.target.value)}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>{t('infrastructure.storage.accessKey')}</label>
                    <input
                      type="text"
                      value={storageConfig.s3AccessKey}
                      onChange={e => updateStorageConfig('s3AccessKey', e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label>{t('infrastructure.storage.secretKey')}</label>
                    <input
                      type="password"
                      value={storageConfig.s3SecretKey}
                      onChange={e => updateStorageConfig('s3SecretKey', e.target.value)}
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label>{t('infrastructure.storage.endpoint')}</label>
                  <input
                    type="text"
                    value={storageConfig.s3Endpoint}
                    onChange={e => updateStorageConfig('s3Endpoint', e.target.value)}
                    placeholder={t('infrastructure.storage.endpointHint')}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
