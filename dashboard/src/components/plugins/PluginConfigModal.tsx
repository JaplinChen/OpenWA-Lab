import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Settings, X } from 'lucide-react';
import { pluginsApi } from '../../services/api';
import type { Plugin } from '../../services/api';
import { localizePlugin } from '../../utils/localizePlugin';
import { emptyForField } from '../../utils/pluginConfigForm';
import { queryKeys } from '../../hooks/queries';
import { useToast } from '../Toast';
import { PluginInstances } from '../PluginInstances';
import { ConfigField } from './ConfigField';
import { PluginConfigUi } from './PluginConfigUi';
import { SessionsTab } from './SessionsTab';

interface PluginConfigModalProps {
  plugin: Plugin;
  onClose: () => void;
}

function seedSchemaConfig(plugin: Plugin): Record<string, unknown> {
  // Seed the schema form from the plugin's saved config, falling back to each field's default.
  const initial: Record<string, unknown> = {};
  if (plugin.configSchema?.properties) {
    for (const [key, field] of Object.entries(plugin.configSchema.properties)) {
      initial[key] = plugin.config[key] ?? emptyForField(field);
    }
  }
  return initial;
}

export function PluginConfigModal({ plugin, onClose }: PluginConfigModalProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const schemaFormRef = useRef<HTMLFormElement>(null);
  const [configTab, setConfigTab] = useState<'config' | 'sessions' | 'instances'>('config');
  const [savingConfig, setSavingConfig] = useState(false);
  // Values for a schema-driven (non-engine) plugin's config form, keyed by configSchema property.
  const [schemaConfig, setSchemaConfig] = useState<Record<string, unknown>>(() => seedSchemaConfig(plugin));

  const handleSaveSchemaConfig = async () => {
    // Enforce the schema's HTML constraint hints (required/min/max/pattern) before saving.
    if (schemaFormRef.current && !schemaFormRef.current.reportValidity()) return;
    setSavingConfig(true);
    try {
      await pluginsApi.updateConfig(plugin.id, schemaConfig);
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
      onClose();
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingConfig(false);
    }
  };

  const lz = localizePlugin(plugin, i18n.language);
  // Session-scoped plugins get a Configuration/Sessions split; ingress-capable plugins add an
  // Instances tab. Either (or both) turns the modal into a tabbed view.
  const showTabs = plugin.sessionScoped !== false || plugin.ingressCapable;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal config-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('plugins.config.title', { name: lz.name })}</h2>
          <button className="btn-icon" onClick={onClose}>
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
            {plugin.sessionScoped !== false && (
              <button
                className={`modal-tab ${configTab === 'sessions' ? 'active' : ''}`}
                onClick={() => setConfigTab('sessions')}
              >
                {t('plugins.config.tabSessions')}
              </button>
            )}
            {plugin.ingressCapable && (
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
          {showTabs && configTab === 'instances' && plugin.ingressCapable ? (
            <PluginInstances pluginId={plugin.id} />
          ) : showTabs && configTab === 'sessions' && plugin.sessionScoped !== false ? (
            <SessionsTab plugin={plugin} />
          ) : plugin.configUi ? (
            <PluginConfigUi plugin={plugin} />
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
              <Settings size={48} className="no-config-icon" />
              <p>{t('plugins.config.noOptions')}</p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
          {/* The Sessions and Instances tabs have their own actions; the footer Save is config-tab only. */}
          {showTabs && (configTab === 'sessions' || configTab === 'instances')
            ? null
            : plugin.configUi ? null : lz.configSchema && Object.keys(lz.configSchema.properties).length > 0 ? (
            <button className="btn-primary" onClick={handleSaveSchemaConfig} disabled={savingConfig}>
              {savingConfig ? <Loader2 size={16} className="animate-spin" /> : t('plugins.config.save')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
