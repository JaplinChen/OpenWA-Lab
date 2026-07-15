import { useTranslation } from 'react-i18next';
import { Server, ExternalLink } from 'lucide-react';
import { API_BASE_URL } from '../../services/api';
import { copyToClipboard } from '../../utils/clipboard';
import { useToast } from '../Toast';
import { EnvPinNote } from './EnvPinNote';
import type { RedisConfig, QueueStats } from './types';

interface RedisCardProps {
  redisEnabled: boolean;
  setRedisEnabled: (value: boolean) => void;
  redisConfig: RedisConfig;
  updateRedisConfig: (key: keyof RedisConfig, value: string | boolean) => void;
  queueEnabled: boolean;
  setQueueEnabled: (value: boolean) => void;
  queueStats: { webhooks: QueueStats };
  pinnedByEnv: boolean;
}

export function RedisCard({
  redisEnabled,
  setRedisEnabled,
  redisConfig,
  updateRedisConfig,
  queueEnabled,
  setQueueEnabled,
  queueStats,
  pinnedByEnv,
}: RedisCardProps) {
  const { t } = useTranslation();
  const toast = useToast();
  return (
    <section className="infra-card">
      <div className="card-header">
        <div className="header-left">
          <Server size={20} />
          <h2>{t('infrastructure.redis.title')}</h2>
        </div>
        <span
          className={`status-indicator ${redisEnabled && redisConfig.connected ? 'connected' : 'disconnected'}`}
        >
          ● {redisEnabled
            ? redisConfig.connected
              ? t('infrastructure.statusLabels.connected')
              : t('infrastructure.statusLabels.disconnected')
            : t('infrastructure.statusLabels.disabled')}
        </span>
      </div>
      <EnvPinNote pinned={pinnedByEnv} />

      <div
        className="toggle-row"
        style={{
          borderBottom: redisEnabled ? '1px solid var(--border)' : 'none',
          marginBottom: redisEnabled ? '1.5rem' : 0,
          paddingBottom: redisEnabled ? '1.25rem' : 0,
        }}
      >
        <div className="toggle-info">
          <span>{t('infrastructure.redis.enable')}</span>
          <small>{t('infrastructure.redis.enableDesc')}</small>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={redisEnabled}
            onChange={e => {
              setRedisEnabled(e.target.checked);
              if (!e.target.checked) setQueueEnabled(false);
            }}
          />
          <span className="toggle-slider"></span>
        </label>
      </div>

      {redisEnabled ? (
        <>
          <div className="toggle-row" style={{ marginBottom: '1rem' }}>
            <div className="toggle-info">
              <span>{t('infrastructure.redis.useBuiltIn')}</span>
              <small>{t('infrastructure.redis.builtInDesc')}</small>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={redisConfig.builtIn}
                onChange={e => updateRedisConfig('builtIn', e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {!redisConfig.builtIn && (
            <div className="config-form">
              <div className="form-row">
                <div className="form-group">
                  <label>{t('common.host')}</label>
                  <input
                    type="text"
                    value={redisConfig.host}
                    onChange={e => updateRedisConfig('host', e.target.value)}
                  />
                </div>
                <div className="form-group small">
                  <label>{t('common.port')}</label>
                  <input
                    type="text"
                    value={redisConfig.port}
                    onChange={e => updateRedisConfig('port', e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>{t('common.password')}</label>
                  <input
                    type="password"
                    value={redisConfig.password}
                    onChange={e => updateRedisConfig('password', e.target.value)}
                    placeholder={t('infrastructure.redis.passwordOptional')}
                  />
                </div>
              </div>
            </div>
          )}

          <div
            className="toggle-row"
            style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', marginTop: '0.5rem' }}
          >
            <div className="toggle-info">
              <span>{t('infrastructure.redis.queueTitle')}</span>
              <small>{t('infrastructure.redis.queueDesc')}</small>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={queueEnabled} onChange={e => setQueueEnabled(e.target.checked)} />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {queueEnabled && (
            <div className="queue-stats">
              <h3>{t('infrastructure.redis.statsTitle')}</h3>
              <div className="stats-row">
                <div className="queue-stat-card">
                  <h4>{t('infrastructure.redis.webhookQueue')}</h4>
                  <div className="stat-values">
                    <div className="stat-item pending">
                      <span className="value">{queueStats.webhooks.pending}</span>
                      <span className="label">{t('infrastructure.redis.pending')}</span>
                    </div>
                    <div className="stat-item completed">
                      <span className="value">{queueStats.webhooks.completed.toLocaleString()}</span>
                      <span className="label">{t('infrastructure.redis.completed')}</span>
                    </div>
                    <div className="stat-item failed">
                      <span className="value">{queueStats.webhooks.failed}</span>
                      <span className="label">{t('infrastructure.redis.failed')}</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="queue-actions">
                <button
                  className="btn-outline"
                  onClick={() => {
                    // The BullBoard route requires an ADMIN API key in the X-API-Key header — a plain
                    // browser tab can't send one, so copy the URL for use with an authenticated client
                    // / reverse proxy instead of opening a tab that 401s.
                    const base = API_BASE_URL.startsWith('http')
                      ? API_BASE_URL
                      : `${window.location.origin}${API_BASE_URL}`;
                    void copyToClipboard(`${base}/admin/queues`).then(ok => {
                      if (ok) {
                        toast.success(
                          t('infrastructure.redis.bullMqUrlCopied'),
                          t('infrastructure.redis.bullMqUrlHint'),
                        );
                      }
                    });
                  }}
                >
                  <ExternalLink size={16} />
                  {t('infrastructure.redis.viewBullMq')}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
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
          <Server size={32} style={{ color: 'var(--text-muted)', marginBottom: '1rem', opacity: 0.5 }} />
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9375rem', fontWeight: 500 }}>
            {t('infrastructure.redis.disabledTitle')}
          </p>
          <p style={{ margin: '0.5rem 0 0', color: 'var(--text-muted)', fontSize: '0.8125rem', lineHeight: 1.5 }}>
            {t('infrastructure.redis.disabledDesc')}
          </p>
        </div>
      )}
    </section>
  );
}
