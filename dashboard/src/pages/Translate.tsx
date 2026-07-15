import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save, Check, AlertTriangle, X, Search, Languages, Plus, Trash2 } from 'lucide-react';
import { translateApi, type TranslateConfig, type GlossaryTerm } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionsQuery, useSessionGroupsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './Translate.css';

const READY_STATUSES = ['ready', 'connecting', 'qr_ready', 'idle'];

export function Translate() {
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
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: groups = [], isLoading: loadingGroups } = useSessionGroupsQuery(sessionId, !!sessionId);

  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
  const [glossarySrc, setGlossarySrc] = useState('');
  const [glossaryTgt, setGlossaryTgt] = useState('');
  const [glossaryFilter, setGlossaryFilter] = useState('');
  const [glossaryBusy, setGlossaryBusy] = useState(false);

  // Load config on mount.
  useEffect(() => {
    let active = true;
    translateApi
      .getConfig()
      .then(cfg => {
        if (active) setConfig(cfg);
      })
      .catch(err => {
        if (active)
          setToast({
            type: 'error',
            message: t('translate.toasts.loadFailed', {
              defaultValue: 'Failed to load config: {{message}}',
              message: err instanceof Error ? err.message : 'unknown',
            }),
          });
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

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  useEffect(() => {
    translateApi
      .getGlossary()
      .then(setGlossary)
      .catch(() => {});
  }, []);

  const filteredGlossary = useMemo(() => {
    const q = glossaryFilter.trim().toLowerCase();
    if (!q) return glossary;
    return glossary.filter(g => `${g.source}\n${g.target}`.toLowerCase().includes(q));
  }, [glossary, glossaryFilter]);

  const addGlossaryTerm = async () => {
    const zh = glossarySrc.trim();
    const vi = glossaryTgt.trim();
    if (!zh || !vi) return;
    setGlossaryBusy(true);
    try {
      setGlossary(await translateApi.addGlossaryTerm(zh, vi));
      setGlossarySrc('');
      setGlossaryTgt('');
      setToast({ type: 'success', message: t('translate.glossary.added', { defaultValue: 'Term added' }) });
    } catch (err) {
      setToast({
        type: 'error',
        message: t('translate.glossary.saveFailed', {
          defaultValue: 'Failed: {{message}}',
          message: err instanceof Error ? err.message : 'unknown',
        }),
      });
    } finally {
      setGlossaryBusy(false);
    }
  };

  const removeGlossaryTerm = async (term: string) => {
    setGlossaryBusy(true);
    try {
      setGlossary(await translateApi.removeGlossaryTerm(term));
    } catch (err) {
      setToast({
        type: 'error',
        message: t('translate.glossary.saveFailed', {
          defaultValue: 'Failed: {{message}}',
          message: err instanceof Error ? err.message : 'unknown',
        }),
      });
    } finally {
      setGlossaryBusy(false);
    }
  };

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

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await translateApi.updateConfig(config);
      setConfig(saved);
      setToast({ type: 'success', message: t('translate.toasts.saved', { defaultValue: 'Settings saved' }) });
    } catch (err) {
      setToast({
        type: 'error',
        message: t('translate.toasts.saveFailed', {
          defaultValue: 'Save failed: {{message}}',
          message: err instanceof Error ? err.message : 'unknown',
        }),
      });
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
        title={t('translate.title', { defaultValue: 'Translation' })}
        subtitle={t('translate.subtitle', {
          defaultValue: 'Choose which WhatsApp groups get auto-translated.',
        })}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
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

          <div className="form-group">
            <label>{t('translate.minInterval', { defaultValue: 'Min send interval (ms)' })}</label>
            <input
              type="number"
              min={0}
              step={100}
              value={config.minSendIntervalMs}
              disabled={!canWrite}
              onChange={e => setConfig({ ...config, minSendIntervalMs: Number(e.target.value) || 0 })}
            />
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
            <label>{t('translate.session', { defaultValue: 'Session' })}</label>
            <select value={sessionId} onChange={e => setSessionId(e.target.value)}>
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

        <section className="translate-panel translate-glossary-panel">
          <div className="translate-groups-head">
            <h3 className="translate-panel-title">
              {t('translate.glossary.title', { defaultValue: 'Glossary (中文 ⇄ Tiếng Việt)' })}
              <span className="translate-selected-count">{glossary.length}</span>
            </h3>
          </div>
          <p className="translate-glossary-hint">
            {t('translate.glossary.hint', {
              defaultValue: 'Terms are forced into every translation of the selected groups.',
            })}
          </p>

          {canWrite && (
            <div className="translate-glossary-add">
              <input
                type="text"
                placeholder={t('translate.glossary.source', { defaultValue: '中文' })}
                value={glossarySrc}
                onChange={e => setGlossarySrc(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addGlossaryTerm()}
              />
              <span className="translate-glossary-arrow">→</span>
              <input
                type="text"
                placeholder={t('translate.glossary.target', { defaultValue: 'Tiếng Việt' })}
                value={glossaryTgt}
                onChange={e => setGlossaryTgt(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addGlossaryTerm()}
              />
              <button
                className="btn-primary"
                onClick={addGlossaryTerm}
                disabled={glossaryBusy || !glossarySrc.trim() || !glossaryTgt.trim()}
              >
                <Plus size={16} />
                {t('translate.glossary.add', { defaultValue: 'Add' })}
              </button>
            </div>
          )}

          <div className="translate-search">
            <Search size={16} className="translate-search-icon" />
            <input
              type="text"
              placeholder={t('translate.glossary.search', { defaultValue: 'Search terms...' })}
              value={glossaryFilter}
              onChange={e => setGlossaryFilter(e.target.value)}
            />
          </div>

          <div className="translate-glossary-list">
            {filteredGlossary.length === 0 ? (
              <div className="translate-group-empty">
                <Languages size={32} strokeWidth={1} />
                <p>{t('translate.glossary.empty', { defaultValue: 'No glossary terms yet.' })}</p>
              </div>
            ) : (
              filteredGlossary.map(g => (
                <div key={g.source} className="translate-glossary-item">
                  <span className="translate-glossary-src">{g.source}</span>
                  <span className="translate-glossary-arrow">→</span>
                  <span className="translate-glossary-tgt">{g.target}</span>
                  {canWrite && (
                    <button
                      className="translate-glossary-del"
                      onClick={() => removeGlossaryTerm(g.source)}
                      disabled={glossaryBusy}
                      title={t('translate.glossary.remove', { defaultValue: 'Remove' })}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
