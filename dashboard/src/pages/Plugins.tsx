import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { localizePlugin } from '../utils/localizePlugin';
import { emptyForField } from '../utils/pluginConfigForm';
import { useQueryClient } from '@tanstack/react-query';
import {
  Puzzle,
  Power,
  PowerOff,
  Settings,
  CheckCircle,
  AlertCircle,
  Loader2,
  RefreshCw,
  Cpu,
  Database,
  Server,
  Shield,
  Zap,
  X,
  Upload,
  Trash2,
  Globe,
  Download,
  Search,
} from 'lucide-react';
import { pluginsApi } from '../services/api';
import type { Plugin, CatalogPlugin } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { usePluginsQuery, queryKeys } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { PageLoader } from '../components/PageLoader';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';
import { PluginInstances } from '../components/PluginInstances';
import { ConfigField } from '../components/plugins/ConfigField';
import { PluginConfigUi } from '../components/plugins/PluginConfigUi';
import { SessionsTab } from '../components/plugins/SessionsTab';
import './Plugins.css';

type PluginType = 'engine' | 'storage' | 'queue' | 'auth' | 'extension';

const pluginTypeIcons: Record<PluginType, typeof Puzzle> = {
  engine: Cpu,
  storage: Database,
  queue: Server,
  auth: Shield,
  extension: Zap,
};

export default function Plugins() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('plugins.title'));
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: plugins = [], isLoading: loadingPlugins, error: queryError } = usePluginsQuery();
  const loading = loadingPlugins;
  const error = queryError instanceof Error ? queryError.message : null;
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const schemaFormRef = useRef<HTMLFormElement>(null);

  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configPluginId, setConfigPluginId] = useState<string | null>(null);
  // Derive the open plugin from the LIVE query so the modal (esp. the Sessions tab) reflects the
  // latest activeSessions/sessionConfig after a save + invalidate — not a stale open-time snapshot.
  const configPlugin = configPluginId ? (plugins.find(p => p.id === configPluginId) ?? null) : null;
  const [configTab, setConfigTab] = useState<'config' | 'sessions' | 'instances'>('config');
  const [savingConfig, setSavingConfig] = useState(false);
  // Values for a schema-driven (non-engine) plugin's config form, keyed by configSchema property.
  const [schemaConfig, setSchemaConfig] = useState<Record<string, unknown>>({});
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [installFile, setInstallFile] = useState<File | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installMode, setInstallMode] = useState<'upload' | 'catalog'>('upload');
  const [catalog, setCatalog] = useState<CatalogPlugin[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);

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
    setConfigTab('config');
    // Seed the schema form from the plugin's saved config, falling back to each field's default.
    if (plugin.configSchema?.properties) {
      const initial: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(plugin.configSchema.properties)) {
        initial[key] = plugin.config[key] ?? emptyForField(field);
      }
      setSchemaConfig(initial);
    }
    setShowConfigModal(true);
  };

  const handleSaveSchemaConfig = async () => {
    if (!configPlugin) return;
    // Enforce the schema's HTML constraint hints (required/min/max/pattern) before saving.
    if (schemaFormRef.current && !schemaFormRef.current.reportValidity()) return;
    setSavingConfig(true);
    try {
      await pluginsApi.updateConfig(configPlugin.id, schemaConfig);
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
      setShowConfigModal(false);
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingConfig(false);
    }
  };

  const handleInstall = async () => {
    if (!installFile) return;
    if (installFile.size > 5 * 1024 * 1024) {
      toast.error(
        t('plugins.toasts.installFailed', 'Install failed'),
        t('plugins.installModal.tooLarge', 'The file exceeds the 5 MB limit.'),
      );
      return;
    }
    setInstalling(true);
    try {
      const installed = await pluginsApi.install(installFile);
      refetchAll();
      toast.success(t('plugins.toasts.installed', 'Plugin installed'), installed.name);
      setShowInstallModal(false);
      setInstallFile(null);
    } catch (err) {
      toast.error(t('plugins.toasts.installFailed', 'Install failed'), err instanceof Error ? err.message : '');
    } finally {
      setInstalling(false);
    }
  };

  const loadCatalog = async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      setCatalog(await pluginsApi.catalog());
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err));
    } finally {
      setCatalogLoading(false);
    }
  };

  // Lazy-load the catalog the first time the Catalog tab is opened.
  useEffect(() => {
    if (showInstallModal && installMode === 'catalog' && catalog.length === 0 && !catalogLoading && !catalogError) {
      void loadCatalog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInstallModal, installMode]);

  const handleInstallFromCatalog = async (entry: CatalogPlugin) => {
    if (!entry.download) {
      toast.error(
        t('plugins.toasts.installFailed', 'Install failed'),
        t('plugins.catalog.noDownload', 'This catalog entry has no download URL.'),
      );
      return;
    }
    setInstallingId(entry.id);
    try {
      const installed = await pluginsApi.installFromUrl(entry.download);
      refetchAll();
      await loadCatalog();
      toast.success(t('plugins.toasts.installed', 'Plugin installed'), installed.name);
    } catch (err) {
      toast.error(t('plugins.toasts.installFailed', 'Install failed'), err instanceof Error ? err.message : '');
    } finally {
      setInstallingId(null);
    }
  };

  const handleUpdateFromCatalog = async (entry: CatalogPlugin) => {
    if (!entry.download) {
      toast.error(
        t('plugins.toasts.updateFailed', 'Update failed'),
        t('plugins.catalog.noDownload', 'This catalog entry has no download URL.'),
      );
      return;
    }
    setInstallingId(entry.id);
    try {
      const updated = await pluginsApi.updateFromUrl(entry.id, entry.download);
      refetchAll();
      await loadCatalog();
      toast.success(t('plugins.catalog.updated', 'Plugin updated'), `${updated.name} v${updated.version}`);
    } catch (err) {
      toast.error(t('plugins.toasts.updateFailed', 'Update failed'), err instanceof Error ? err.message : '');
    } finally {
      setInstallingId(null);
    }
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
            {visiblePlugins.map(plugin => {
              const TypeIcon = pluginTypeIcons[plugin.type as PluginType] || Puzzle;
              const isLoading = actionLoading === plugin.id;
              const lz = localizePlugin(plugin, i18n.language);

              return (
                <div key={plugin.id} className="plugin-card">
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
                        onClick={() => handleToggle(plugin)}
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
                        onClick={() => handleHealthCheck(plugin.id)}
                        disabled={isLoading}
                        className="btn-action"
                        title={t('plugins.healthCheck')}
                      >
                        <CheckCircle size={16} />
                      </button>

                      <button
                        className="btn-action"
                        title={t('plugins.configure')}
                        onClick={() => handleOpenConfig(plugin)}
                      >
                        <Settings size={16} />
                      </button>

                      {!plugin.builtIn && (
                        <button
                          className="btn-action btn-action-danger"
                          title={t('plugins.uninstall', 'Uninstall')}
                          onClick={() => void handleUninstall(plugin)}
                          disabled={isLoading}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </main>
      </div>

      {visiblePlugins.length === 0 && !loading && (
        <EmptyState
          icon={<Puzzle size={64} />}
          title={t('plugins.empty.title')}
          description={t('plugins.empty.description')}
        />
      )}

      {showInstallModal && (
        <div className="modal-overlay" onClick={() => setShowInstallModal(false)}>
          <div className="modal install-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('plugins.installModal.title', 'Install a plugin')}</h2>
              <button className="btn-icon" onClick={() => setShowInstallModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="install-tabs">
              <button
                className={`install-tab${installMode === 'upload' ? ' active' : ''}`}
                onClick={() => setInstallMode('upload')}
              >
                <Upload size={15} /> {t('plugins.installModal.tabUpload', 'Upload .zip')}
              </button>
              <button
                className={`install-tab${installMode === 'catalog' ? ' active' : ''}`}
                onClick={() => setInstallMode('catalog')}
              >
                <Globe size={15} /> {t('plugins.installModal.tabCatalog', 'Catalog')}
              </button>
            </div>

            {installMode === 'upload' ? (
              <>
                <div className="modal-body">
                  <p className="install-hint">
                    {t(
                      'plugins.installModal.hint',
                      'Upload a plugin packaged as a .zip (with a manifest.json). It runs sandboxed once enabled.',
                    )}
                  </p>
                  <label className={`install-drop${installFile ? ' has-file' : ''}`}>
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      hidden
                      onChange={e => setInstallFile(e.target.files?.[0] ?? null)}
                    />
                    <Upload size={28} />
                    <span className="install-drop-name">
                      {installFile ? installFile.name : t('plugins.installModal.choose', 'Choose a .zip file…')}
                    </span>
                  </label>
                </div>
                <div className="modal-footer">
                  <button className="btn-secondary" onClick={() => setShowInstallModal(false)} disabled={installing}>
                    {t('common.cancel', 'Cancel')}
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => void handleInstall()}
                    disabled={!installFile || installing}
                  >
                    {installing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                    {t('plugins.install', 'Install plugin')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-body">
                  <p className="install-hint">
                    {t(
                      'plugins.installModal.catalogHint',
                      'Install directly from the OpenWA-Lab plugin catalog. The .zip is fetched server-side through the SSRF guard, then validated and sandboxed.',
                    )}
                  </p>
                  {catalogLoading ? (
                    <div className="catalog-empty">
                      <Loader2 size={20} className="animate-spin" />
                    </div>
                  ) : catalogError ? (
                    <div className="catalog-empty catalog-error">
                      <AlertCircle size={16} /> {catalogError}
                      <button className="btn-secondary" onClick={() => void loadCatalog()}>
                        {t('plugins.refresh', 'Refresh')}
                      </button>
                    </div>
                  ) : catalog.length === 0 ? (
                    <div className="catalog-empty">{t('plugins.catalog.empty', 'No plugins in the catalog.')}</div>
                  ) : (
                    (() => {
                      const q = catalogSearch.trim().toLowerCase();
                      const filtered = q
                        ? catalog.filter(e =>
                            [e.name, e.description, e.author, e.id].some(f => f?.toLowerCase().includes(q)),
                          )
                        : catalog;
                      return (
                        <>
                          <div className="catalog-search">
                            <Search size={15} />
                            <input
                              type="text"
                              value={catalogSearch}
                              onChange={e => setCatalogSearch(e.target.value)}
                              placeholder={t('plugins.catalog.searchPlaceholder', 'Search plugins…')}
                            />
                          </div>
                          {filtered.length === 0 ? (
                            <div className="catalog-empty">
                              {t('plugins.catalog.noMatch', 'No plugins match your search.')}
                            </div>
                          ) : (
                            <div className="catalog-list">
                              {filtered.map(entry => {
                                const lz = localizePlugin(entry, i18n.language);
                                return (
                                  <div className="catalog-row" key={entry.id}>
                                    <div className="catalog-row-info">
                                      <div className="catalog-row-name">
                                        {lz.name} <span className="catalog-row-version">v{entry.version}</span>
                                      </div>
                                      {lz.description && <div className="catalog-row-desc">{lz.description}</div>}
                                      <div className="catalog-row-meta">
                                        {entry.author && <span className="catalog-row-author">{entry.author}</span>}
                                        {entry.updateAvailable && (
                                          <span className="catalog-badge update">
                                            {t('plugins.catalog.updateAvailable', 'Update available')} (v
                                            {entry.installedVersion} → v{entry.version})
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    <div className="catalog-row-action">
                                      {entry.installed ? (
                                        entry.updateAvailable ? (
                                          <button
                                            className="btn-primary"
                                            disabled={installingId !== null || !entry.download}
                                            onClick={() => void handleUpdateFromCatalog(entry)}
                                          >
                                            {installingId === entry.id ? (
                                              <Loader2 size={15} className="animate-spin" />
                                            ) : (
                                              <Download size={15} />
                                            )}
                                            {t('plugins.catalog.update', 'Update')}
                                          </button>
                                        ) : (
                                          <span className="catalog-installed">
                                            <CheckCircle size={15} /> {t('plugins.catalog.installed', 'Installed')}
                                          </span>
                                        )
                                      ) : (
                                        <button
                                          className="btn-primary"
                                          disabled={installingId !== null || !entry.download}
                                          onClick={() => void handleInstallFromCatalog(entry)}
                                        >
                                          {installingId === entry.id ? (
                                            <Loader2 size={15} className="animate-spin" />
                                          ) : (
                                            <Download size={15} />
                                          )}
                                          {t('plugins.catalog.install', 'Install')}
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </>
                      );
                    })()
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn-secondary" onClick={() => setShowInstallModal(false)}>
                    {t('common.close', 'Close')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showConfigModal &&
        configPlugin &&
        (() => {
          const lz = localizePlugin(configPlugin, i18n.language);
          // Session-scoped plugins get a Configuration/Sessions split; ingress-capable plugins add an
          // Instances tab. Either (or both) turns the modal into a tabbed view.
          const showTabs = configPlugin.sessionScoped !== false || configPlugin.ingressCapable;
          return (
            <div className="modal-overlay" onClick={() => setShowConfigModal(false)}>
              <div className="modal config-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <h2>{t('plugins.config.title', { name: lz.name })}</h2>
                  <button className="btn-icon" onClick={() => setShowConfigModal(false)}>
                    <X size={20} />
                  </button>
                </div>

                {showTabs && (
                  <div className="modal-tabs">
                    <button
                      className={`modal-tab ${configTab === 'config' ? 'active' : ''}`}
                      onClick={() => setConfigTab('config')}
                    >
                      {t('plugins.config.tabConfig')}
                    </button>
                    {configPlugin.sessionScoped !== false && (
                      <button
                        className={`modal-tab ${configTab === 'sessions' ? 'active' : ''}`}
                        onClick={() => setConfigTab('sessions')}
                      >
                        {t('plugins.config.tabSessions')}
                      </button>
                    )}
                    {configPlugin.ingressCapable && (
                      <button
                        className={`modal-tab ${configTab === 'instances' ? 'active' : ''}`}
                        onClick={() => setConfigTab('instances')}
                      >
                        {t('plugins.instances.title')}
                      </button>
                    )}
                  </div>
                )}

                <div className="modal-body">
                  {showTabs && configTab === 'instances' && configPlugin.ingressCapable ? (
                    <PluginInstances pluginId={configPlugin.id} />
                  ) : showTabs && configTab === 'sessions' && configPlugin.sessionScoped !== false ? (
                    <SessionsTab plugin={configPlugin} />
                  ) : configPlugin.configUi ? (
                    <PluginConfigUi plugin={configPlugin} />
                  ) : lz.configSchema && Object.keys(lz.configSchema.properties).length > 0 ? (
                    <form ref={schemaFormRef} className="config-form" onSubmit={e => e.preventDefault()}>
                      {Object.entries(lz.configSchema.properties).map(([key, field]) => (
                        <ConfigField
                          key={key}
                          field={field}
                          label={field.title || key}
                          value={schemaConfig[key]}
                          onChange={v => setSchemaConfig({ ...schemaConfig, [key]: v })}
                        />
                      ))}
                    </form>
                  ) : (
                    <div className="no-config">
                      <Settings size={48} style={{ opacity: 0.3 }} />
                      <p>{t('plugins.config.noOptions')}</p>
                    </div>
                  )}
                </div>

                <div className="modal-footer">
                  <button className="btn-secondary" onClick={() => setShowConfigModal(false)}>
                    {t('common.close')}
                  </button>
                  {/* The Sessions and Instances tabs have their own actions; the footer Save is config-tab only. */}
                  {showTabs && (configTab === 'sessions' || configTab === 'instances')
                    ? null
                    : configPlugin.configUi ? null : lz.configSchema &&
                    Object.keys(lz.configSchema.properties).length > 0 ? (
                    <button className="btn-primary" onClick={handleSaveSchemaConfig} disabled={savingConfig}>
                      {savingConfig ? <Loader2 size={16} className="animate-spin" /> : t('plugins.config.save')}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
