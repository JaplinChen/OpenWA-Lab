import { useTranslation } from 'react-i18next';
import { Cpu } from 'lucide-react';
import type { InfraStatus, Engine } from '../../services/api';
import type { EngineConfig } from './types';

interface EngineCardProps {
  engineConfig: EngineConfig;
  updateEngineConfig: (key: keyof EngineConfig, value: string | boolean) => void;
  engines: Engine[];
  currentEngine: string;
  infraStatus: InfraStatus | undefined;
}

export function EngineCard({
  engineConfig,
  updateEngineConfig,
  engines,
  currentEngine,
  infraStatus,
}: EngineCardProps) {
  const { t } = useTranslation();
  return (
    <section className="infra-card">
      <div className="card-header">
        <div className="header-left">
          <Cpu size={20} />
          <h2>{t('infrastructure.engine.title')}</h2>
        </div>
        <span className="status-indicator connected">● {currentEngine || engineConfig.type}</span>
      </div>

      <div className="radio-group">
        {engines.map(engine => (
          <label key={engine.id} className={`radio-option ${engineConfig.type === engine.id ? 'selected' : ''}`}>
            <input
              type="radio"
              name="engineType"
              checked={engineConfig.type === engine.id}
              onChange={() => updateEngineConfig('type', engine.id)}
            />
            <Cpu className="watermark-icon" />
            <span>{engine.name}</span>
            <small>
              {engine.library
                ? `${engine.library.name} ${engine.library.version}`
                : t('infrastructure.engine.builtIn')}
            </small>
          </label>
        ))}
      </div>

      {/* The actual WhatsApp Web build in use — distinct from the library version above (#488). */}
      {infraStatus?.engine.webVersion !== undefined && (
        <p className="engine-web-version">
          {t('infrastructure.engine.webVersion')}:{' '}
          <code>{infraStatus.engine.webVersion ?? t('infrastructure.engine.webVersionNative')}</code>
          {infraStatus.engine.webVersionSource && (
            <span className="muted">
              {' '}
              ({t(`infrastructure.engine.webVersionSource.${infraStatus.engine.webVersionSource}`)})
            </span>
          )}
        </p>
      )}

      {engineConfig.type === 'whatsapp-web.js' ? (
        <div className="config-form">
          <div className="toggle-row">
            <div className="toggle-info">
              <span>{t('infrastructure.engine.headless')}</span>
              <small>{t('infrastructure.engine.headlessDesc')}</small>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={engineConfig.headless}
                onChange={e => updateEngineConfig('headless', e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
          <div className="form-group">
            <label>{t('infrastructure.engine.sessionDataPath')}</label>
            <input
              type="text"
              value={engineConfig.sessionDataPath}
              onChange={e => updateEngineConfig('sessionDataPath', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>{t('infrastructure.engine.browserArgs')}</label>
            <input
              type="text"
              value={engineConfig.browserArgs}
              onChange={e => updateEngineConfig('browserArgs', e.target.value)}
              placeholder="--no-sandbox --disable-gpu"
            />
          </div>
        </div>
      ) : (
        <p style={{ margin: '0.5rem 0 0', color: 'var(--text-muted)', fontSize: '0.8125rem', lineHeight: 1.5 }}>
          {t('infrastructure.engine.noBrowser')}
        </p>
      )}

      <p style={{ margin: '1rem 0 0', color: 'var(--text-muted)', fontSize: '0.8125rem', lineHeight: 1.5 }}>
        {t('infrastructure.engine.restartNote')}
      </p>
    </section>
  );
}
