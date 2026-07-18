import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle, Download, Globe, Loader2, Search, Upload, X } from 'lucide-react';
import { pluginsApi } from '../../services/api';
import { localizePlugin } from '../../utils/localizePlugin';
import { useToast } from '../Toast';
import { useCatalog } from '../../hooks/useCatalog';

interface InstallModalProps {
  onClose: () => void;
  refetchAll: () => void;
}

export function InstallModal({ onClose, refetchAll }: InstallModalProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [installFile, setInstallFile] = useState<File | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installMode, setInstallMode] = useState<'upload' | 'catalog'>('upload');
  const {
    catalog,
    catalogLoading,
    catalogError,
    catalogSearch,
    setCatalogSearch,
    installingId,
    loadCatalog,
    handleInstallFromCatalog,
    handleUpdateFromCatalog,
  } = useCatalog(installMode === 'catalog', refetchAll);

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
      onClose();
    } catch (err) {
      toast.error(t('plugins.toasts.installFailed', 'Install failed'), err instanceof Error ? err.message : '');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal install-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('plugins.installModal.title', 'Install a plugin')}</h2>
          <button className="btn-icon" onClick={onClose}>
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
              <button className="btn-secondary" onClick={onClose} disabled={installing}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleInstall()} disabled={!installFile || installing}>
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
              <button className="btn-secondary" onClick={onClose}>
                {t('common.close', 'Close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
