import { useState, useEffect, useMemo, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save, Search, Languages } from 'lucide-react';
import { translateApi, type TranslateConfig, type LlmProvider } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionsQuery, useSessionGroupsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { metaOf, parseFallbackEntry } from '../components/llm/providerMeta';
import './Translate.css';

const READY_STATUSES = ['ready', 'connecting', 'qr_ready', 'idle'];

export function Translate() {
  // Visible labels that pointed at nothing: no htmlFor, no id.
  const intervalFieldId = useId();
  const maxLenFieldId = useId();
  const rateFieldId = useId();
  const sessionFieldId = useId();
  const { t } = useTranslation();
  useDocumentTitle(t('translate.title', { defaultValue: 'Translation' }));
  const { canWrite } = useRole();

  const { data: sessions = [] } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');
  const [config, setConfig] = useState<TranslateConfig>({
    enabled: false,
    groupIds: [],
    includeFromMe: false,
    minSendIntervalMs: 1000,
    notifyOnFailure: false,
    maxMessageLength: 0,
    maxTranslationsPerMinute: 0,
    llmProvider: 'ollama',
    llmEndpoint: '',
    llmModel: '',
    llmApiKey: '',
    llmTemperature: 0,
    llmFallbackModels: [],
    llmPromptTemplate: '',
    llmProviderConfigs: {},
  });
  const [loading, setLoading] = useState(true);
  // Guard against saving before a successful load: the initial config is empty, so a save issued
  // during (or after a failed) load would overwrite the server config with {enabled:false, groupIds:[]}.
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [previewResult, setPreviewResult] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewProvider, setPreviewProvider] = useState<LlmProvider | ''>('');
  const toast = useToast();

  // Providers available to preview: the primary plus any configured fallback providers.
  const previewProviders = useMemo(() => {
    const list = [config.llmProvider, ...config.llmFallbackModels.map(e => parseFallbackEntry(e, config.llmProvider).provider)];
    return [...new Set(list)];
  }, [config.llmProvider, config.llmFallbackModels]);

  const { data: groups = [], isLoading: loadingGroups } = useSessionGroupsQuery(sessionId, !!sessionId);

  // Load config on mount.
  useEffect(() => {
    let active = true;
    translateApi
      .getConfig()
      .then(cfg => {
        if (active) {
          setConfig(cfg);
          setLoaded(true);
        }
      })
      .catch(err => {
        if (active)
          toast.error(
            t('translate.toasts.loadFailed', {
              defaultValue: 'Failed to load config: {{message}}',
              message: err instanceof Error ? err.message : 'unknown',
            }),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  // Default to the first ready-ish session once sessions arrive.
  useEffect(() => {
    if (sessionId || sessions.length === 0) return;
    const ready = sessions.find(s => READY_STATUSES.includes(s.status)) ?? sessions[0];
    setSessionId(ready.id);
  }, [sessions, sessionId]);

  const filteredGroups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(g => (g.name || g.id).toLowerCase().includes(q));
  }, [groups, filter]);

  const toggleGroup = (id: string) => {
    setConfig(prev => ({
      ...prev,
      groupIds: prev.groupIds.includes(id)
        ? prev.groupIds.filter(g => g !== id)
        : [...prev.groupIds, id],
    }));
  };

  const handlePreview = async () => {
    const text = previewText.trim();
    if (!text) return;
    setPreviewing(true);
    setPreviewResult('');
    try {
      const { translated } = await translateApi.preview(text, previewProvider || undefined);
      setPreviewResult(translated);
    } catch (err) {
      toast.error(
        t('translate.toasts.previewFailed', {
          defaultValue: 'Preview failed: {{message}}',
          message: err instanceof Error ? err.message : 'unknown',
        }),
      );
    } finally {
      setPreviewing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // This page doesn't edit provider configs — never send them, so a stale snapshot can't wipe
      // groq/ollama endpoints/keys the backend has (see normalizeConfigPatch merge).
      const { llmProviderConfigs: _ownedElsewhere, ...rest } = config;
      const saved = await translateApi.updateConfig(rest);
      setConfig(saved);
      toast.success(t('translate.toasts.saved', { defaultValue: 'Settings saved' }));
    } catch (err) {
      toast.error(
        t('translate.toasts.saveFailed', {
          defaultValue: 'Save failed: {{message}}',
          message: err instanceof Error ? err.message : 'unknown',
        }),
      );
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
        title={t('translate.title', { defaultValue: 'Translation' })}
        subtitle={t('translate.subtitle', {
          defaultValue: 'Choose which WhatsApp groups get auto-translated.',
        })}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={handleSave} disabled={saving || !loaded}>
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
              {t('translate.save', { defaultValue: 'Save' })}
            </button>
          )
        }
      />

      <div className="translate-content">
        <section className="translate-panel">
          <h3 className="translate-panel-title">{t('translate.options', { defaultValue: 'Options' })}</h3>

          <div className="translate-toggle-row">
            <div className="translate-toggle-text">
              <span className="translate-toggle-label">{t('translate.enabled', { defaultValue: 'Enabled' })}</span>
              <span className="translate-toggle-hint">
                {t('translate.enabledHint', { defaultValue: 'Turn auto-translation on or off.' })}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={config.enabled}
                disabled={!canWrite}
                onChange={e => setConfig({ ...config, enabled: e.target.checked })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="translate-toggle-row">
            <div className="translate-toggle-text">
              <span className="translate-toggle-label">
                {t('translate.includeFromMe', { defaultValue: 'Translate my own messages' })}
              </span>
              <span className="translate-toggle-hint">
                {t('translate.includeFromMeHint', {
                  defaultValue: 'Also translate messages you send.',
                })}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={config.includeFromMe}
                disabled={!canWrite}
                onChange={e => setConfig({ ...config, includeFromMe: e.target.checked })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="translate-toggle-row">
            <div className="translate-toggle-text">
              <span className="translate-toggle-label">
                {t('translate.notifyOnFailure', { defaultValue: 'Notify group on failure' })}
              </span>
              <span className="translate-toggle-hint">
                {t('translate.notifyOnFailureHint', {
                  defaultValue: 'Post a short notice to the group when translation fails.',
                })}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={config.notifyOnFailure}
                disabled={!canWrite}
                onChange={e => setConfig({ ...config, notifyOnFailure: e.target.checked })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="form-group">
            <label htmlFor={intervalFieldId}>{t('translate.minInterval', { defaultValue: 'Min send interval (ms)' })}</label>
            <input
              id={intervalFieldId}
              type="number"
              min={0}
              step={100}
              value={config.minSendIntervalMs}
              disabled={!canWrite}
              onChange={e => setConfig({ ...config, minSendIntervalMs: Number(e.target.value) || 0 })}
            />
          </div>

          <div className="form-group">
            <label htmlFor={maxLenFieldId}>
              {t('translate.maxMessageLength', { defaultValue: 'Max message length (0 = no limit)' })}
            </label>
            <input
              id={maxLenFieldId}
              type="number"
              min={0}
              step={50}
              value={config.maxMessageLength}
              disabled={!canWrite}
              onChange={e => setConfig({ ...config, maxMessageLength: Number(e.target.value) || 0 })}
            />
          </div>

          <div className="form-group">
            <label htmlFor={rateFieldId}>
              {t('translate.maxPerMinute', { defaultValue: 'Max translations per group/min (0 = unlimited)' })}
            </label>
            <input
              id={rateFieldId}
              type="number"
              min={0}
              step={1}
              value={config.maxTranslationsPerMinute}
              disabled={!canWrite}
              onChange={e => setConfig({ ...config, maxTranslationsPerMinute: Number(e.target.value) || 0 })}
            />
          </div>

          <div className="form-group">
            <label>{t('translate.preview', { defaultValue: 'Test translation' })}</label>
            <span className="translate-toggle-hint">
              {t('translate.previewHint', {
                defaultValue: 'Run text through the live pipeline (glossary, senders, casing).',
              })}
            </span>
            <textarea
              rows={2}
              value={previewText}
              placeholder={t('translate.previewPlaceholder', { defaultValue: 'Type Chinese or Vietnamese…' })}
              onChange={e => setPreviewText(e.target.value)}
            />
            <div className="translate-preview-actions">
              {previewProviders.length > 1 && (
                <select
                  aria-label={t('translate.previewProvider', { defaultValue: 'Provider' })}
                  value={previewProvider}
                  onChange={e => setPreviewProvider(e.target.value as LlmProvider | '')}
                >
                  <option value="">{t('translate.previewPrimary', { defaultValue: 'Primary' })} ({metaOf(config.llmProvider).label})</option>
                  {previewProviders.map(p => (
                    <option key={p} value={p}>{metaOf(p).label}</option>
                  ))}
                </select>
              )}
              <button
                className="btn-primary"
                onClick={handlePreview}
                disabled={previewing || !previewText.trim()}
              >
                {previewing ? <Loader2 size={16} className="animate-spin" /> : <Languages size={16} />}
                {t('translate.previewRun', { defaultValue: 'Translate' })}
              </button>
            </div>
            {previewResult && <div className="translate-preview-result">{previewResult}</div>}
          </div>
        </section>

        <section className="translate-panel translate-groups-panel">
          <div className="translate-groups-head">
            <h3 className="translate-panel-title">
              {t('translate.groups', { defaultValue: 'Groups' })}
              <span className="translate-selected-count">{config.groupIds.length}</span>
            </h3>
          </div>

          <div className="form-group">
            <label htmlFor={sessionFieldId}>{t('translate.session', { defaultValue: 'Session' })}</label>
            <select id={sessionFieldId} value={sessionId} onChange={e => setSessionId(e.target.value)}>
              {sessions.length === 0 && (
                <option value="">{t('translate.noSessions', { defaultValue: 'No sessions' })}</option>
              )}
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.status})
                </option>
              ))}
            </select>
          </div>

          <div className="translate-search">
            <Search size={16} className="translate-search-icon" />
            <input
              type="text"
              placeholder={t('translate.searchGroups', { defaultValue: 'Search groups...' })}
              aria-label={t('translate.searchGroups', { defaultValue: 'Search groups...' })}
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          </div>

          <div className="translate-group-list">
            {loadingGroups ? (
              <div className="translate-group-empty">
                <Loader2 className="animate-spin" size={24} />
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="translate-group-empty">
                <Languages size={32} strokeWidth={1} />
                <p>{t('translate.emptyGroups', { defaultValue: 'No groups found for this session.' })}</p>
              </div>
            ) : (
              filteredGroups.map(g => {
                const checked = config.groupIds.includes(g.id);
                return (
                  <label key={g.id} className={`translate-group-item ${checked ? 'selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canWrite}
                      onChange={() => toggleGroup(g.id)}
                    />
                    <span className="translate-group-name">{g.name || g.id}</span>
                    <span className="translate-group-jid">{g.id}</span>
                  </label>
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
