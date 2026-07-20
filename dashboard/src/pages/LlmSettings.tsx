import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save } from 'lucide-react';
import { translateApi, type LlmProvider, type LlmProviderSaved } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { metaOf, parseFallbackEntry, emptyProviderConfig, type ProviderConfig } from '../components/llm/providerMeta';
import { ProviderConfigForm } from '../components/llm/ProviderConfigForm';
import './Translate.css';

const TAB_KEYS = ['tabPrimary', 'tabFallback1', 'tabFallback2'] as const;

export function LlmSettings() {
  const { t } = useTranslation();
  useDocumentTitle(t('nav.llm', { defaultValue: 'LLM Settings' }));
  const { canWrite } = useRole();
  const toast = useToast();

  // Index 0 = primary, 1 = fallback 1, 2 = fallback 2. Each holds a full provider config.
  const [tabs, setTabs] = useState<ProviderConfig[]>([emptyProviderConfig(), emptyProviderConfig(), emptyProviderConfig()]);
  const [pcfgs, setPcfgs] = useState<Record<string, LlmProviderSaved>>({});
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const keySet = (p: LlmProvider | ''): boolean => (p ? Boolean(pcfgs[p]?.apiKeySet) : false);

  const mapFromConfig = (c: Awaited<ReturnType<typeof translateApi.getConfig>>): void => {
    // Fold the active provider's apiKeySet into pcfgs so keySet() is uniform across tabs.
    const merged = { ...c.llmProviderConfigs, [c.llmProvider]: { ...c.llmProviderConfigs?.[c.llmProvider], apiKeySet: c.apiKeySet } };
    setPcfgs(merged);
    const primary: ProviderConfig = {
      provider: c.llmProvider,
      endpoint: c.llmEndpoint,
      model: c.llmModel,
      apiKey: '', // masked; blank means "keep stored key"
      temperature: c.llmTemperature,
    };
    const fbTabs = [0, 1].map(i => {
      const entry = (c.llmFallbackModels ?? [])[i];
      if (!entry) return emptyProviderConfig();
      const { provider, model } = parseFallbackEntry(entry, c.llmProvider);
      const saved = merged[provider];
      return { provider, endpoint: saved?.endpoint ?? metaOf(provider).endpoint, model, apiKey: '', temperature: saved?.temperature ?? 0 };
    });
    setTabs([primary, fbTabs[0], fbTabs[1]]);
  };

  useEffect(() => {
    let alive = true;
    translateApi
      .getConfig()
      .then(c => {
        if (!alive) return;
        mapFromConfig(c);
        setLoaded(true);
      })
      .catch(err => alive && toast.error(t('llm.loadFailed', { message: err instanceof Error ? err.message : 'unknown' })))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [t]);

  const patchTab = (idx: number, patch: Partial<ProviderConfig>) =>
    setTabs(prev => prev.map((tab, i) => (i === idx ? { ...tab, ...patch } : tab)));

  // Switching a tab's provider restores that provider's saved settings (or its defaults on first use).
  const changeProvider = (idx: number, p: LlmProvider | '') => {
    if (!p) return setTabs(prev => prev.map((tab, i) => (i === idx ? emptyProviderConfig() : tab)));
    const saved = pcfgs[p];
    patchTab(idx, {
      provider: p,
      endpoint: saved?.endpoint ?? metaOf(p).endpoint,
      model: saved?.model ?? '',
      apiKey: '',
      temperature: saved?.temperature ?? 0,
    });
  };

  // Providers chosen in the OTHER tabs — not re-selectable here (one provider per tab).
  const excludeFor = (idx: number): LlmProvider[] =>
    tabs.filter((_, i) => i !== idx).map(tab => tab.provider).filter((p): p is LlmProvider => p !== '');

  const effectiveEndpoint = (tab: ProviderConfig): string => {
    const meta = metaOf(tab.provider as LlmProvider);
    return meta.showEndpoint ? tab.endpoint || meta.endpoint : meta.endpoint;
  };

  const handleSave = async () => {
    const primary = tabs[0];
    if (!primary.provider || !primary.model.trim()) {
      return toast.error(t('llm.primaryRequired', { defaultValue: 'The primary tab needs a provider and model.' }));
    }
    setSaving(true);
    try {
      const fbs = [tabs[1], tabs[2]].filter(tab => tab.provider && tab.model.trim());
      // Fold every set tab's config into providerConfigs so cross-provider fallback can resolve each key.
      const llmProviderConfigs: Record<string, LlmProviderSaved> = { ...pcfgs };
      for (const tab of [primary, ...fbs]) {
        llmProviderConfigs[tab.provider] = {
          endpoint: effectiveEndpoint(tab),
          model: tab.model,
          apiKey: tab.apiKey, // '' round-trips as "keep stored key"
          temperature: tab.temperature,
        };
      }
      const saved = await translateApi.updateConfig({
        llmProvider: primary.provider,
        llmEndpoint: effectiveEndpoint(primary),
        llmModel: primary.model,
        llmApiKey: primary.apiKey,
        llmTemperature: primary.temperature,
        llmFallbackModels: fbs.map(tab => `${tab.provider}:${tab.model}`),
        llmProviderConfigs,
      });
      mapFromConfig(saved);
      toast.success(t('llm.saved'));
    } catch (err) {
      toast.error(t('llm.saveFailed', { message: err instanceof Error ? err.message : 'unknown' }));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="translate-page translate-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="translate-page">
      <PageHeader
        title={t('nav.llm', { defaultValue: 'LLM Settings' })}
        subtitle={t('llm.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={handleSave} disabled={saving || !loaded}>
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
              {t('llm.save')}
            </button>
          )
        }
      />

      <div className="translate-content translate-content--single">
        <section className="translate-panel">
          <div className="llm-tabs" role="tablist">
            {tabs.map((tab, i) => (
              <button
                key={TAB_KEYS[i]}
                role="tab"
                aria-selected={active === i}
                className={`llm-tab ${active === i ? 'active' : ''}`}
                onClick={() => setActive(i)}
              >
                <span className="llm-tab-name">{t(`llm.${TAB_KEYS[i]}`, { defaultValue: TAB_KEYS[i] })}</span>
                <span className="llm-tab-sub">{tab.provider ? metaOf(tab.provider).label : t('llm.fallbackNone', { defaultValue: '—' })}</span>
              </button>
            ))}
          </div>

          <ProviderConfigForm
            key={`${active}-${tabs[active].provider}`}
            value={tabs[active]}
            keySet={keySet(tabs[active].provider)}
            canWrite={canWrite}
            allowNone={active > 0}
            excludeProviders={excludeFor(active)}
            onProviderChange={p => changeProvider(active, p)}
            onField={patch => patchTab(active, patch)}
          />
        </section>
      </div>
    </div>
  );
}

export default LlmSettings;
