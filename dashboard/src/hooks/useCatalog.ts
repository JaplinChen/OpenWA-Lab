import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { pluginsApi } from '../services/api';
import type { CatalogPlugin } from '../services/api';
import { useToast } from '../components/Toast';

export function useCatalog(active: boolean, refetchAll: () => void) {
  const { t } = useTranslation();
  const toast = useToast();
  const [catalog, setCatalog] = useState<CatalogPlugin[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);

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
    if (active && catalog.length === 0 && !catalogLoading && !catalogError) {
      void loadCatalog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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

  return {
    catalog,
    catalogLoading,
    catalogError,
    catalogSearch,
    setCatalogSearch,
    installingId,
    loadCatalog,
    handleInstallFromCatalog,
    handleUpdateFromCatalog,
  };
}
