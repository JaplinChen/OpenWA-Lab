import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { localizePlugin } from '../../utils/localizePlugin';
import { emptyForField } from '../../utils/pluginConfigForm';
import { pluginsApi } from '../../services/api';
import type { Plugin } from '../../services/api';
import { useSessionsQuery, queryKeys } from '../../hooks/queries';
import { useToast } from '../Toast';
import { ConfigField } from './ConfigField';
import { PluginConfigUi } from './PluginConfigUi';
import { sparseSessionOverride } from './sparseSessionOverride';

/**
 * The config modal's "Sessions" tab for a session-scoped plugin: set which sessions it runs for
 * (activation), and optionally a per-session config OVERRIDE on top of the Global (`'*'`) config.
 * Activation → PUT /plugins/:id/sessions; overrides → PUT /plugins/:id/config/:sessionId.
 */
export function SessionsTab({ plugin }: { plugin: Plugin }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: sessions = [] } = useSessionsQuery();

  // ── Activation ────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'all' | 'specific'>(plugin.activeSessions.includes('*') ? 'all' : 'specific');
  const [picked, setPicked] = useState<Set<string>>(new Set(plugin.activeSessions.filter(s => s !== '*')));
  const [savingAct, setSavingAct] = useState(false);

  const saveActivation = async () => {
    setSavingAct(true);
    try {
      await pluginsApi.setSessions(plugin.id, mode === 'all' ? ['*'] : Array.from(picked));
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingAct(false);
    }
  };

  // ── Per-session config override ───────────────────────────────────────────
  const hasSchema = !!plugin.configSchema && Object.keys(plugin.configSchema.properties).length > 0;
  const hasUi = !!plugin.configUi;
  const lzProps = localizePlugin(plugin, i18n.language).configSchema?.properties;
  const [selSession, setSelSession] = useState<string>('');
  const [overrideCfg, setOverrideCfg] = useState<Record<string, unknown>>({});
  const [savingOverride, setSavingOverride] = useState(false);
  const overrideFormRef = useRef<HTMLFormElement>(null);

  // Seed the override form from the resolved slice (the session's override value where set, else base).
  // Keyed on selSession + plugin.id (NOT the plugin object): `configPlugin` is derived from the live
  // query, so it gets a new reference on every refetch (refetchOnWindowFocus) — re-running on that
  // would wipe the operator's in-progress edits. Reseed only when the selected session/plugin changes.
  useEffect(() => {
    const props = plugin.configSchema?.properties;
    if (!selSession || !props) {
      setOverrideCfg({});
      return;
    }
    const ov = plugin.sessionConfig?.[selSession] ?? {};
    const seeded: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(props)) {
      seeded[key] = key in ov ? ov[key] : (plugin.config[key] ?? emptyForField(field));
    }
    setOverrideCfg(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selSession, plugin.id]);

  const saveOverride = async () => {
    if (!selSession || !plugin.configSchema?.properties) return;
    // Enforce the schema's HTML constraint hints (required/min/max/pattern) before saving.
    if (overrideFormRef.current && !overrideFormRef.current.reportValidity()) return;
    setSavingOverride(true);
    try {
      await pluginsApi.updateSessionConfig(plugin.id, selSession, sparseSessionOverride(overrideCfg, plugin));
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingOverride(false);
    }
  };

  const clearOverride = async () => {
    if (!selSession) return;
    setSavingOverride(true);
    try {
      await pluginsApi.updateSessionConfig(plugin.id, selSession, {});
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingOverride(false);
    }
  };

  const hasOverride = (sid: string): boolean => Object.keys(plugin.sessionConfig?.[sid] ?? {}).length > 0;

  return (
    <div className="sessions-tab">
      <section className="sessions-section">
        <h3>{t('plugins.sessions.activationTitle')}</h3>
        <small>{t('plugins.sessions.activationDesc')}</small>
        <label className="sessions-radio">
          <input type="radio" name="activation" checked={mode === 'all'} onChange={() => setMode('all')} />
          <span>{t('plugins.sessions.allSessions')}</span>
        </label>
        <label className="sessions-radio">
          <input type="radio" name="activation" checked={mode === 'specific'} onChange={() => setMode('specific')} />
          <span>{t('plugins.sessions.specificSessions')}</span>
        </label>
        {mode === 'specific' &&
          (sessions.length === 0 ? (
            <p className="sessions-empty">{t('plugins.sessions.noSessions')}</p>
          ) : (
            <div className="sessions-checklist">
              {sessions.map(s => (
                <label key={s.id} className="sessions-check">
                  <input
                    type="checkbox"
                    checked={picked.has(s.id)}
                    onChange={e => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      setPicked(next);
                    }}
                  />
                  <span>{s.name || s.id}</span>
                </label>
              ))}
            </div>
          ))}
        <button className="btn-primary" onClick={() => void saveActivation()} disabled={savingAct}>
          {savingAct ? <Loader2 size={16} className="animate-spin" /> : t('plugins.sessions.saveActivation')}
        </button>
      </section>

      {(hasSchema || hasUi) && (
        <section className="sessions-section">
          <h3>{t('plugins.sessions.perSessionTitle')}</h3>
          <small>{t('plugins.sessions.perSessionDesc')}</small>
          <select className="sessions-select" value={selSession} onChange={e => setSelSession(e.target.value)}>
            <option value="">{t('plugins.sessions.selectSession')}</option>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {(s.name || s.id) + (hasOverride(s.id) ? ' ●' : '')}
              </option>
            ))}
          </select>
          {selSession && hasUi ? (
            <PluginConfigUi key={selSession} plugin={plugin} sessionId={selSession} />
          ) : selSession && plugin.configSchema ? (
            <>
              <form ref={overrideFormRef} className="config-form" onSubmit={e => e.preventDefault()}>
                {Object.entries(lzProps ?? plugin.configSchema.properties).map(([key, field]) => (
                  <ConfigField
                    key={key}
                    field={field}
                    label={field.title || key}
                    value={overrideCfg[key]}
                    onChange={v => setOverrideCfg({ ...overrideCfg, [key]: v })}
                  />
                ))}
              </form>
              <div className="sessions-override-actions">
                <button className="btn-secondary" onClick={() => void clearOverride()} disabled={savingOverride}>
                  {t('plugins.sessions.clearOverride')}
                </button>
                <button className="btn-primary" onClick={() => void saveOverride()} disabled={savingOverride}>
                  {savingOverride ? <Loader2 size={16} className="animate-spin" /> : t('plugins.sessions.saveOverride')}
                </button>
              </div>
            </>
          ) : null}
        </section>
      )}
    </div>
  );
}
