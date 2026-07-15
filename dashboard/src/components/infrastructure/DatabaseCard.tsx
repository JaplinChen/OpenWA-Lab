import { useTranslation } from 'react-i18next';
import { Database, CheckCircle, Loader2, Download, Upload } from 'lucide-react';
import { EnvPinNote } from './EnvPinNote';
import type { DatabaseConfig } from './types';
import sqliteIcon from '../../assets/icons/sqlite.svg';
import postgresIcon from '../../assets/icons/postgresql.svg';

interface DatabaseCardProps {
  dbConfig: DatabaseConfig;
  updateDbConfig: (key: keyof DatabaseConfig, value: string | number | boolean) => void;
  pinnedByEnv: boolean;
  migrating: boolean;
  onExportBackup: () => void;
  onImportBackup: (file: File) => void;
}

export function DatabaseCard({
  dbConfig,
  updateDbConfig,
  pinnedByEnv,
  migrating,
  onExportBackup,
  onImportBackup,
}: DatabaseCardProps) {
  const { t } = useTranslation();
  return (
    <section className="infra-card">
      <div className="card-header">
        <div className="header-left">
          <Database size={20} />
          <h2>{t('infrastructure.database.title')}</h2>
        </div>
        <span className={`status-indicator ${dbConfig.type === 'postgres' ? 'connected' : 'sqlite'}`}>
          ● {dbConfig.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}
        </span>
      </div>
      <EnvPinNote pinned={pinnedByEnv} />

      <div className="radio-group">
        <label className={`radio-option ${dbConfig.type === 'sqlite' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="dbType"
            checked={dbConfig.type === 'sqlite'}
            onChange={() => updateDbConfig('type', 'sqlite')}
          />
          <img src={sqliteIcon} alt="" className="watermark-icon" />
          <span>{t('infrastructure.database.sqlite')}</span>
          <small>{t('infrastructure.database.sqliteDesc')}</small>
        </label>
        <label className={`radio-option ${dbConfig.type === 'postgres' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="dbType"
            checked={dbConfig.type === 'postgres'}
            onChange={() => updateDbConfig('type', 'postgres')}
          />
          <img src={postgresIcon} alt="" className="watermark-icon" />
          <span>{t('infrastructure.database.postgres')}</span>
          <small>{t('infrastructure.database.postgresDesc')}</small>
        </label>
      </div>

      {dbConfig.type === 'postgres' && (
        <>
          <div className="toggle-row" style={{ marginTop: '1rem', marginBottom: '1rem' }}>
            <div className="toggle-info">
              <span>{t('infrastructure.database.useBuiltIn')}</span>
              <small>{t('infrastructure.database.builtInDesc')}</small>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={dbConfig.builtIn}
                onChange={e => updateDbConfig('builtIn', e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {!dbConfig.builtIn && (
            <div className="config-form">
              <div className="form-row">
                <div className="form-group">
                  <label>{t('common.host')}</label>
                  <input type="text" value={dbConfig.host} onChange={e => updateDbConfig('host', e.target.value)} />
                </div>
                <div className="form-group small">
                  <label>{t('common.port')}</label>
                  <input type="text" value={dbConfig.port} onChange={e => updateDbConfig('port', e.target.value)} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>{t('common.username')}</label>
                  <input
                    type="text"
                    value={dbConfig.username}
                    onChange={e => updateDbConfig('username', e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>{t('common.password')}</label>
                  <input
                    type="password"
                    value={dbConfig.password}
                    onChange={e => updateDbConfig('password', e.target.value)}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>{t('infrastructure.database.dbName')}</label>
                  <input
                    type="text"
                    value={dbConfig.database}
                    onChange={e => updateDbConfig('database', e.target.value)}
                  />
                </div>
                <div className="form-group small">
                  <label>{t('infrastructure.database.poolSize')}</label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={dbConfig.poolSize}
                    onChange={e => updateDbConfig('poolSize', parseInt(e.target.value))}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>{t('infrastructure.database.schema')}</label>
                  <input
                    type="text"
                    value={dbConfig.schema}
                    onChange={e => updateDbConfig('schema', e.target.value)}
                    placeholder="public"
                  />
                  <small>{t('infrastructure.database.schemaDesc')}</small>
                </div>
              </div>
              <div className="toggle-row">
                <div className="toggle-info">
                  <span>{t('infrastructure.database.ssl')}</span>
                  <small>{t('infrastructure.database.sslDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={dbConfig.sslEnabled}
                    onChange={e => updateDbConfig('sslEnabled', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
              {dbConfig.sslEnabled && (
                <div className="toggle-row">
                  <div className="toggle-info">
                    <span>{t('infrastructure.database.sslRejectUnauthorized')}</span>
                    <small>{t('infrastructure.database.sslRejectUnauthorizedDesc')}</small>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={dbConfig.sslRejectUnauthorized}
                      onChange={e => updateDbConfig('sslRejectUnauthorized', e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div
        className="empty-state-card"
        style={{
          padding: '2.5rem',
          textAlign: 'center',
          background: 'var(--bg-light)',
          borderRadius: '12px',
          border: '1px dashed var(--border)',
          marginTop: '1rem',
        }}
      >
        <Database size={32} style={{ color: 'var(--success)', marginBottom: '1rem', opacity: 0.7 }} />
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9375rem', fontWeight: 500 }}>
          {t('infrastructure.database.migrationsTitle')}
        </p>
        <p
          style={{
            margin: '0.75rem 0 0',
            color: 'var(--success)',
            fontSize: '0.875rem',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.375rem',
          }}
        >
          <CheckCircle size={16} />
          {t('infrastructure.database.migrationsStatus')}
        </p>
        <p style={{ margin: '0.5rem 0 0', color: 'var(--text-muted)', fontSize: '0.8125rem', lineHeight: 1.5 }}>
          {t('infrastructure.database.migrationsHint')}
        </p>
      </div>

      {/* Data backup / restore — used to carry data across a database switch (#488). */}
      <div className="data-migration-row">
        <div>
          <strong>{t('infrastructure.migration.backupTitle')}</strong>
          <small>{t('infrastructure.migration.backupHint')}</small>
        </div>
        <div className="data-migration-actions">
          <button className="btn-secondary btn-sm" onClick={onExportBackup} disabled={migrating}>
            {migrating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {t('infrastructure.migration.export')}
          </button>
          <label className="btn-secondary btn-sm" style={{ cursor: migrating ? 'default' : 'pointer' }}>
            <Upload size={14} />
            {t('infrastructure.migration.import')}
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              disabled={migrating}
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) void onImportBackup(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </div>
    </section>
  );
}
