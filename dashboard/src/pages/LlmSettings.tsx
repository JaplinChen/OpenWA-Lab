import { useState, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save, Check, AlertTriangle, X, Plug, ListRestart, Plus, Trash2, Eye, EyeOff, ExternalLink } from 'lucide-react';
import { translateApi, type TranslateConfig, type LlmProvider, type LlmProviderSaved } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import './Translate.css';

interface ProviderMeta {
  label: string;
  endpoint: string;
  showEndpoint: boolean; // Ollama/OpenAI/Azure expose a server URL; Groq/Gemini have a fixed one.
  needsKey: boolean;
  apiKeyUrl?: string;
}

const PROVIDERS: { value: LlmProvider; meta: ProviderMeta }[] = [
  { value: 'ollama', meta: { label: 'Ollama', endpoint: 'http://127.0.0.1:11434/api/chat', showEndpoint: true, needsKey: false } },
  { value: 'groq', meta: { label: 'Groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', showEndpoint: false, needsKey: true, apiKeyUrl: 'https://console.groq.com/keys' } },
  { value: 'openai', meta: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', showEndpoint: true, needsKey: true, apiKeyUrl: 'https://platform.openai.com/api-keys' } },
  { value: 'azure', meta: { label: 'Azure OpenAI', endpoint: 'https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-02-15-preview', showEndpoint: true, needsKey: true, apiKeyUrl: 'https://portal.azure.com' } },
  { value: 'gemini', meta: { label: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', showEndpoint: false, needsKey: true, apiKeyUrl: 'https://aistudio.google.com/apikey' } },
];

const metaOf = (p: LlmProvider): ProviderMeta => PROVIDERS.find(x => x.value === p)!.meta;

type LlmFields = Pick<
  TranslateConfig,
  'llmProvider' | 'llmEndpoint' | 'llmModel' | 'llmApiKey' | 'llmTemperature' | 'llmFallbackModels'
>;

export function LlmSettings() {
  // These labels were visible but wired to nothing: no htmlFor, no id. The field had no
  // accessible name and clicking the label did not focus it.
  const providerFieldId = useId();
  const endpointFieldId = useId();
  const modelFieldId = useId();
  const fallbackFieldId = useId();
  const apiKeyFieldId = useId();
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
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

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
        });
        setPcfgs(c.llmProviderConfigs ?? {});
        setLoaded(true);
      })
      .catch(err =>
        active &&
        setToast({
          type: 'error',
          message: t('llm.loadFailed', { message: err instanceof Error ? err.message : 'unknown' }),
        }),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [t]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

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
      if (list.length === 0) setToast({ type: 'error', message: t('llm.noModels') });
    } catch (err) {
      setToast({ type: 'error', message: t('llm.modelsFailed', { message: err instanceof Error ? err.message : 'unknown' }) });
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
      });
      setToast({ type: 'success', message: t('llm.saved') });
    } catch (err) {
      setToast({ type: 'error', message: t('llm.saveFailed', { message: err instanceof Error ? err.message : 'unknown' }) });
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
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}

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
                <option key={p.value} value={p.value}>
                  {p.meta.label}
                </option>
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
                  onChange={e => setCfg({ ...cfg, llmEndpoint: e.target.value })}
                />
                <button className="btn-secondary" onClick={handleTest} disabled={testing || !cfg.llmEndpoint}>
                  {testing ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
                  {t('llm.test')}
                </button>
              </div>
              {statusBadge}
            </div>
          )}

          <div className="form-group">
            <label htmlFor={modelFieldId}>{t('llm.model')}</label>
            <div className="llm-row">
              <input
                id={modelFieldId}
                type="text"
                list="llm-models"
                value={cfg.llmModel}
                disabled={!canWrite}
                onChange={e => setCfg({ ...cfg, llmModel: e.target.value })}
              />
              <button className="btn-secondary" onClick={handleFetchModels} disabled={fetchingModels || (!cfg.llmEndpoint && !meta.endpoint)}>
                {fetchingModels ? <Loader2 size={16} className="animate-spin" /> : <ListRestart size={16} />}
                {t('llm.fetchModels')}
              </button>
            </div>
            <datalist id="llm-models">
              {models.map(m => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>

          <div className="form-group">
            <label htmlFor={fallbackFieldId}>{t('llm.fallbackModels')}</label>
            <span className="llm-hint">{t('llm.fallbackHint')}</span>
            {canWrite && (
              <div className="llm-row">
                <input
                  id={fallbackFieldId}
                  type="text"
                  list="llm-models"
                  value={fallbackInput}
                  placeholder={t('llm.fallbackPlaceholder')}
                  onChange={e => setFallbackInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addFallback())}
                />
                <button className="btn-secondary" onClick={addFallback} disabled={!fallbackInput.trim()}>
                  <Plus size={16} />
                  {t('llm.add')}
                </button>
              </div>
            )}
            <ul className="llm-fallback-list">
              {cfg.llmFallbackModels.map(m => (
                <li key={m}>
                  <span>{m}</span>
                  {canWrite && (
                    <button className="llm-fallback-del" onClick={() => removeFallback(m)} title={t('llm.add')}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {meta.needsKey && (
            <div className="form-group">
              <div className="llm-label-row">
                <label htmlFor={apiKeyFieldId}>{t('llm.apiKey')}</label>
                {meta.apiKeyUrl && (
                  <a className="llm-apply-link" href={meta.apiKeyUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    {t('llm.apiKeyApply')}
                  </a>
                )}
              </div>
              <div className="llm-row">
                <div className="llm-key-input">
                  <input
                    id={apiKeyFieldId}
                    type={showKey ? 'text' : 'password'}
                    value={cfg.llmApiKey}
                    disabled={!canWrite}
                    autoComplete="off"
                    onChange={e => setCfg({ ...cfg, llmApiKey: e.target.value })}
                  />
                  <button className="llm-eye" onClick={() => setShowKey(v => !v)} type="button" tabIndex={-1}>
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <button className="btn-secondary" onClick={handleTest} disabled={testing}>
                  {testing ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  {t('llm.verify')}
                </button>
              </div>
              {!meta.showEndpoint && statusBadge}
            </div>
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
                onChange={e => setCfg({ ...cfg, llmTemperature: Number(e.target.value) })}
              />
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
