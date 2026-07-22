import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizePlugin } from '../utils/localizePlugin';
import { useQueryClient } from '@tanstack/react-query';
import { Puzzle, AlertCircle, RefreshCw, Upload } from 'lucide-react';
import { pluginsApi } from '../services/api';
import type { Plugin } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { usePluginsQuery, queryKeys } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { PageLoader } from '../components/PageLoader';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';
import { PluginCard } from '../components/plugins/PluginCard';
import { InstallModal } from '../components/plugins/InstallModal';
import { PluginConfigModal } from '../components/plugins/PluginConfigModal';
import './Plugins.css';

export default function Plugins() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('plugins.title'));
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: plugins = [], isLoading: loadingPlugins, error: queryError } = usePluginsQuery();
  const loading = loadingPlugins;
  const error = queryError instanceof Error ? queryError.message : null;
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configPluginId, setConfigPluginId] = useState<string | null>(null);
  // Derive the open plugin from the LIVE query so the modal (esp. the Sessions tab) reflects the
  // latest activeSessions/sessionConfig after a save + invalidate — not a stale open-time snapshot.
  const configPlugin = configPluginId ? (plugins.find(p => p.id === configPluginId) ?? null) : null;
  const [showInstallModal, setShowInstallModal] = useState(false);

  const refetchAll = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
  };

  const handleToggle = async (plugin: Plugin) => {
    setActionLoading(plugin.id);
    try {
      if (plugin.status === 'enabled') {
        await pluginsApi.disable(plugin.id);
      } else {
        await pluginsApi.enable(plugin.id);
      }
      refetchAll();
    } catch (err) {
      toast.error(
        t('plugins.toasts.errorTitle'),
        err instanceof Error ? err.message : t('plugins.toasts.errorDefault'),
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleHealthCheck = async (pluginId: string) => {
    setActionLoading(pluginId);
    try {
      const result = await pluginsApi.healthCheck(pluginId);
      if (result.healthy) {
        toast.success(t('plugins.toasts.healthOk'), result.message);
      } else {
        toast.warning(t('plugins.toasts.healthFail'), result.message);
      }
    } catch (err) {
      toast.error(t('plugins.toasts.healthError'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleOpenConfig = (plugin: Plugin) => {
    setConfigPluginId(plugin.id);
    setShowConfigModal(true);
  };

  const handleUninstall = async (plugin: Plugin) => {
    if (!window.confirm(t('plugins.uninstallConfirm', { name: localizePlugin(plugin, i18n.language).name }))) return;
    setActionLoading(plugin.id);
    try {
      await pluginsApi.uninstall(plugin.id);
      refetchAll();
      toast.success(t('plugins.toasts.uninstalled', 'Plugin uninstalled'), plugin.name);
    } catch (err) {
      toast.error(t('plugins.toasts.uninstallFailed', 'Uninstall failed'), err instanceof Error ? err.message : '');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <PageLoader className="plugins-page" />
    );
  }

  // Engines are configured under Infrastructure (Engine Configuration tile), not here — keep them
  // out of the plugin grid, the counts and the rail so the Plugins page is extensions-only.
  const visiblePlugins = plugins.filter(p => p.type !== 'engine');
  const enabledCount = visiblePlugins.filter(p => p.status === 'enabled').length;
  const activePlugins = visiblePlugins.filter(p => p.status === 'enabled');

  return (
    <div className="plugins-page">
      <PageHeader
        title={t('plugins.title')}
        subtitle={t('plugins.subtitle')}
        actions={
          <>
            <button className="btn-secondary" onClick={refetchAll}>
              <RefreshCw size={16} />
              {t('plugins.refresh')}
            </button>
            <button className="btn-primary" onClick={() => setShowInstallModal(true)}>
              <Upload size={16} />
              {t('plugins.install', 'Install plugin')}
            </button>
          </>
        }
      />

      {error && (
        <div className="error-banner">
          <AlertCircle size={20} />
          <span className="error-banner-text">{error}</span>
        </div>
      )}

      {visiblePlugins.length > 0 && (
      <div className="plugins-layout">
        <aside className="plugins-rail">
          <div className="rail-stats">
            <div className="rail-stat">
              <span className="rail-stat-num">{enabledCount}</span>
              <span className="rail-stat-label">{t('plugins.rail.enabled', 'enabled')}</span>
            </div>
            <div className="rail-stat">
              <span className="rail-stat-num">{visiblePlugins.length}</span>
              <span className="rail-stat-label">{t('plugins.rail.installed', 'installed')}</span>
            </div>
          </div>

          <div className="rail-section">
            <p className="rail-label">{t('plugins.rail.active', 'Active plugins')}</p>
            {activePlugins.length === 0 ? (
              <p className="rail-empty">{t('plugins.rail.none', 'None enabled yet')}</p>
            ) : (
              <ul className="rail-active-list">
                {activePlugins.map(p => (
                  <li key={p.id} className="rail-active-item">
                    <span className="status-dot enabled" />
                    <span className="rail-active-name">{localizePlugin(p, i18n.language).name}</span>
                    <span className="rail-active-type">{p.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <main className="plugins-main">
          <div className="plugins-grid">
            {visiblePlugins.map(plugin => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                isLoading={actionLoading === plugin.id}
                onToggle={plugin => void handleToggle(plugin)}
                onHealthCheck={id => void handleHealthCheck(id)}
                onOpenConfig={handleOpenConfig}
                onUninstall={plugin => void handleUninstall(plugin)}
              />
            ))}
          </div>
        </main>
      </div>
      )}

      {visiblePlugins.length === 0 && !loading && (
        <EmptyState
          icon={<Puzzle size={64} />}
          title={t('plugins.empty.title')}
          description={t('plugins.empty.description')}
        />
      )}

      {showInstallModal && (
        <InstallModal onClose={() => setShowInstallModal(false)} refetchAll={refetchAll} />
      )}

      {showConfigModal && configPlugin && (
        <PluginConfigModal
          key={configPlugin.id}
          plugin={configPlugin}
          onClose={() => setShowConfigModal(false)}
        />
      )}
    </div>
  );
}
