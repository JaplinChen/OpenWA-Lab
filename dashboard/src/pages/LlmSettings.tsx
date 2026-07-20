import { useState, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save, Check, AlertTriangle, Plug } from 'lucide-react';
import { translateApi, type TranslateConfig, type LlmProvider, type LlmProviderSaved } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { PROVIDERS, metaOf } from '../components/llm/providerMeta';
import { LlmFallbackField } from '../components/llm/LlmFallbackField';
import { LlmModelField } from '../components/llm/LlmModelField';
import { LlmApiKeyField } from '../components/llm/LlmApiKeyField';
import './Translate.css';

type LlmFields = Pick<
  TranslateConfig,
  'llmProvider' | 'llmEndpoint' | 'llmModel' | 'llmApiKey' | 'llmTemperature' | 'llmFallbackModels' | 'llmPromptTemplate'
>;

export function LlmSettings() {
  // These labels were visible but wired to nothing: no htmlFor, no id. The field had no
  // accessible name and clicking the label did not focus it.
  const providerFieldId = useId();
  const endpointFieldId = useId();
  const styleFieldId = useId();
  const { t } = useTranslation();
  useDocumentTitle(t('nav.llm', { defaultValue: 'LLM Settings' }));
  const { canWrite } = useRole();

  const [cfg, setCfg] = useState<LlmFields>({
    llmProvider: 'ollama',
    llmEndpoint: '',
    llmModel: '',
    llmApiKey: '',
    llmTemperature: 0,
    llmFallbackModels: [],
    llmPromptTemplate: '',
  });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [showKey, setShowKey] = useState(false);
  // Per-provider saved settings — restored when switching engines so each keeps its own endpoint/key.
  const [pcfgs, setPcfgs] = useState<Record<string, LlmProviderSaved>>({});
  const [fallbackInput, setFallbackInput] = useState('');
  const toast = useToast();

  useEffect(() => {
    let active = true;
    translateApi
      .getConfig()
      .then(c => {
        if (!active) return;
        setCfg({
          llmProvider: c.llmProvider,
          llmEndpoint: c.llmEndpoint,
          llmModel: c.llmModel,
          llmApiKey: c.llmApiKey,
          llmTemperature: c.llmTemperature,
          llmFallbackModels: c.llmFallbackModels ?? [],
          llmPromptTemplate: c.llmPromptTemplate ?? '',
        });
        setPcfgs(c.llmProviderConfigs ?? {});
        setLoaded(true);
      })
      .catch(err =>
        active &&
        toast.error(t('llm.loadFailed', { message: err instanceof Error ? err.message : 'unknown' })),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [t]);

  const meta = metaOf(cfg.llmProvider);

  // Groq/Gemini have a fixed endpoint (field hidden); shown-endpoint providers use the user's value.
  const effectiveEndpoint = meta.showEndpoint ? cfg.llmEndpoint || meta.endpoint : meta.endpoint;

  const probe = () => ({
    provider: cfg.llmProvider,
    endpoint: effectiveEndpoint,
    model: cfg.llmModel,
    apiKey: cfg.llmApiKey,
  });

  const snapshot = (): LlmProviderSaved => ({
    endpoint: cfg.llmEndpoint,
    model: cfg.llmModel,
    apiKey: cfg.llmApiKey,
    temperature: cfg.llmTemperature,
    fallbackModels: cfg.llmFallbackModels,
  });

  const onProvider = (llmProvider: LlmProvider) => {
    if (llmProvider === cfg.llmProvider) return;
    // Save the current engine's settings, then restore the target engine's saved settings (or its
    // defaults on first use) — like TypeTwo's providerConfigs, so switching never loses a config.
    const savedCurrent = { ...pcfgs, [cfg.llmProvider]: snapshot() };
    setPcfgs(savedCurrent);
    const prev = savedCurrent[llmProvider];
    const next = metaOf(llmProvider);
    setCfg({
      ...cfg,
      llmProvider,
      llmEndpoint: prev?.endpoint ?? next.endpoint,
      llmModel: prev?.model ?? '',
      llmApiKey: prev?.apiKey ?? '',
      llmTemperature: prev?.temperature ?? 0,
      llmFallbackModels: prev?.fallbackModels ?? [],
    });
    setModels([]);
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await translateApi.testLlm(probe()));
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'unknown' });
    } finally {
      setTesting(false);
    }
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    try {
      const { models: list } = await translateApi.listLlmModels(probe());
      setModels(list);
      if (list.length === 0) toast.error(t('llm.noModels'));
    } catch (err) {
      toast.error(t('llm.modelsFailed', { message: err instanceof Error ? err.message : 'unknown' }));
    } finally {
      setFetchingModels(false);
    }
  };

  const addFallback = () => {
    const m = fallbackInput.trim();
    if (!m || cfg.llmFallbackModels.includes(m)) return;
    setCfg({ ...cfg, llmFallbackModels: [...cfg.llmFallbackModels, m] });
    setFallbackInput('');
  };

  const removeFallback = (m: string) =>
    setCfg({ ...cfg, llmFallbackModels: cfg.llmFallbackModels.filter(x => x !== m) });

  const handleSave = async () => {
    setSaving(true);
    try {
      // Persist the effective endpoint (fixed URL for Groq/Gemini) + the active engine's snapshot
      // folded into providerConfigs so every engine's settings survive a reload.
      const llmProviderConfigs = { ...pcfgs, [cfg.llmProvider]: { ...snapshot(), endpoint: effectiveEndpoint } };
      const saved = await translateApi.updateConfig({ ...cfg, llmEndpoint: effectiveEndpoint, llmProviderConfigs });
      setPcfgs(saved.llmProviderConfigs ?? llmProviderConfigs);
      setCfg({
        llmProvider: saved.llmProvider,
        llmEndpoint: saved.llmEndpoint,
        llmModel: saved.llmModel,
        llmApiKey: saved.llmApiKey,
        llmTemperature: saved.llmTemperature,
        llmFallbackModels: saved.llmFallbackModels ?? [],
        llmPromptTemplate: saved.llmPromptTemplate ?? cfg.llmPromptTemplate,
      });
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

  const statusBadge = testResult && (
    <span className={`llm-status ${testResult.ok ? 'ok' : 'err'}`}>
      {testResult.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
      {testResult.ok ? t('llm.testOk') : testResult.message}
    </span>
  );

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
          <div className="form-group">
            <label htmlFor={providerFieldId}>{t('llm.provider')}</label>
            <select id={providerFieldId} value={cfg.llmProvider} disabled={!canWrite} onChange={e => onProvider(e.target.value as LlmProvider)}>
              {PROVIDERS.map(p => (
                <option key={p.value} value={p.value}>{p.meta.label}</option>
              ))}
            </select>
          </div>

          {meta.showEndpoint && (
            <div className="form-group">
              <label htmlFor={endpointFieldId}>{t('llm.endpoint')}</label>
              <div className="llm-row">
                <input
                  id={endpointFieldId}
                  type="text"
                  value={cfg.llmEndpoint}
                  disabled={!canWrite}
                  placeholder={meta.endpoint}
                  onChange={e => setCfg({ ...cfg, llmEndpoint: e.target.value })} />
                <button className="btn-secondary" onClick={handleTest} disabled={testing || !cfg.llmEndpoint}>
                  {testing ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
                  {t('llm.test')}
                </button>
              </div>
              {statusBadge}
            </div>
          )}

          <LlmModelField
            model={cfg.llmModel}
            models={models}
            canWrite={canWrite}
            onChange={v => setCfg({ ...cfg, llmModel: v })}
            fetchingModels={fetchingModels}
            fetchDisabled={!cfg.llmEndpoint && !meta.endpoint}
            onFetchModels={() => void handleFetchModels()}
          />


          <LlmFallbackField
            canWrite={canWrite}
            models={models}
            fallbackModels={cfg.llmFallbackModels}
            fallbackInput={fallbackInput}
            setFallbackInput={setFallbackInput}
            addFallback={addFallback}
            removeFallback={removeFallback}
          />

          {meta.needsKey && (
            <LlmApiKeyField
              meta={meta}
              apiKey={cfg.llmApiKey}
              keySet={Boolean(pcfgs[cfg.llmProvider]?.apiKeySet)}
              canWrite={canWrite}
              showKey={showKey}
              toggleShowKey={() => setShowKey(v => !v)}
              onChange={v => setCfg({ ...cfg, llmApiKey: v })}
              testing={testing}
              onTest={handleTest}
              statusBadge={statusBadge}
            />
          )}

          <div className="form-group">
            <label htmlFor={styleFieldId}>{t('llm.style')}</label>
            <div className="llm-slider-row">
              <span>{t('llm.stylePrecise')}</span>
              <input
                id={styleFieldId}
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={cfg.llmTemperature}
                disabled={!canWrite}
                onChange={e => setCfg({ ...cfg, llmTemperature: Number(e.target.value) })} />
              <span>{t('llm.styleFluent')}</span>
              <span className="llm-slider-val">{cfg.llmTemperature.toFixed(1)}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default LlmSettings;
