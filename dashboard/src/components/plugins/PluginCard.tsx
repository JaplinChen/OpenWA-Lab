import { useTranslation } from 'react-i18next';
import {
  Puzzle,
  Power,
  PowerOff,
  Settings,
  CheckCircle,
  Loader2,
  Cpu,
  Database,
  Server,
  Shield,
  Zap,
  Trash2,
} from 'lucide-react';
import type { Plugin } from '../../services/api';
import { localizePlugin } from '../../utils/localizePlugin';

type PluginType = 'engine' | 'storage' | 'queue' | 'auth' | 'extension';

const pluginTypeIcons: Record<PluginType, typeof Puzzle> = {
  engine: Cpu,
  storage: Database,
  queue: Server,
  auth: Shield,
  extension: Zap,
};

interface PluginCardProps {
  plugin: Plugin;
  isLoading: boolean;
  onToggle: (plugin: Plugin) => void;
  onHealthCheck: (pluginId: string) => void;
  onOpenConfig: (plugin: Plugin) => void;
  onUninstall: (plugin: Plugin) => void;
}

export function PluginCard({ plugin, isLoading, onToggle, onHealthCheck, onOpenConfig, onUninstall }: PluginCardProps) {
  const { t, i18n } = useTranslation();
  const TypeIcon = pluginTypeIcons[plugin.type as PluginType] || Puzzle;
  const lz = localizePlugin(plugin, i18n.language);

  return (
    <div className="plugin-card">
      <div className={`plugin-card-header type-${plugin.type}`}>
        <div className="plugin-info">
          <div className="plugin-icon-wrapper">
            <TypeIcon size={20} />
          </div>
          <div>
            <h3 className="plugin-name">{lz.name}</h3>
            <span className="plugin-version">v{plugin.version}</span>
          </div>
        </div>
        {plugin.builtIn && <span className="plugin-builtin-badge">{t('plugins.builtIn')}</span>}
      </div>

      <div className="plugin-card-body">
        <p className="plugin-description">{lz.description || t('plugins.noDescription')}</p>

        <div className="plugin-status-row">
          <div className="plugin-status">
            <span className={`status-dot ${plugin.status}`} />
            <span className="status-text">{plugin.status}</span>
          </div>
          <span className="plugin-type-label">{plugin.type}</span>
        </div>

        {plugin.error && (
          <div className="plugin-error">
            <p className="plugin-error-text">{plugin.error}</p>
          </div>
        )}

        {plugin.provides && plugin.provides.length > 0 && (
          <div className="plugin-provides">
            {plugin.provides.map(item => (
              <span key={item} className="provides-tag">
                {item}
              </span>
            ))}
          </div>
        )}

        <div className="plugin-actions">
          <button
            onClick={() => onToggle(plugin)}
            disabled={isLoading}
            className={`btn-toggle ${plugin.status === 'enabled' ? 'disable' : 'enable'}`}
          >
            {isLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : plugin.status === 'enabled' ? (
              <>
                <PowerOff size={16} />
                {t('plugins.disable')}
              </>
            ) : (
              <>
                <Power size={16} />
                {t('plugins.enable')}
              </>
            )}
          </button>

          <button
            onClick={() => onHealthCheck(plugin.id)}
            disabled={isLoading}
            className="btn-action"
            title={t('plugins.healthCheck')}
          >
            <CheckCircle size={16} />
          </button>

          <button className="btn-action" title={t('plugins.configure')} onClick={() => onOpenConfig(plugin)}>
            <Settings size={16} />
          </button>

          {!plugin.builtIn && (
            <button
              className="btn-action btn-action-danger"
              title={t('plugins.uninstall', 'Uninstall')}
              onClick={() => onUninstall(plugin)}
              disabled={isLoading}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
