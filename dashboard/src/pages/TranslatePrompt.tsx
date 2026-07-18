import { useState, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save, ListRestart } from 'lucide-react';
import { translateApi } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import './Translate.css';

export function TranslatePrompt() {
  const promptFieldId = useId();
  const { t } = useTranslation();
  useDocumentTitle(t('nav.translatePrompt', { defaultValue: 'Translation Prompt' }));
  const { canWrite } = useRole();

  const [prompt, setPrompt] = useState('');
  const [promptDefault, setPromptDefault] = useState('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    translateApi
      .getConfig()
      .then(c => {
        if (!active) return;
        setPrompt(c.llmPromptTemplate ?? '');
        setPromptDefault(c.llmPromptTemplateDefault ?? '');
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

  const handleSave = async (promptOverride?: string) => {
    setSaving(true);
    try {
      const llmPromptTemplate = promptOverride ?? prompt;
      const saved = await translateApi.updateConfig({ llmPromptTemplate });
      setPrompt(saved.llmPromptTemplate ?? llmPromptTemplate);
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
        title={t('nav.translatePrompt', { defaultValue: 'Translation Prompt' })}
        subtitle={t('llm.promptHint')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={() => handleSave()} disabled={saving || !loaded}>
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
              {t('llm.save')}
            </button>
          )
        }
      />

      <div className="translate-content translate-content--single">
        <section className="translate-panel">
          <div className="form-group">
            <label htmlFor={promptFieldId}>{t('llm.promptTemplate')}</label>
            <span className="llm-hint">{t('llm.promptHint')}</span>
            <textarea
              id={promptFieldId}
              rows={12}
              value={prompt}
              disabled={!canWrite}
              placeholder={promptDefault}
              onChange={e => setPrompt(e.target.value)}
            />
            {canWrite && (
              <div className="llm-row">
                <button className="btn-primary" onClick={() => handleSave()} disabled={saving || !loaded}>
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  {t('llm.save')}
                </button>
                <button className="btn-secondary" onClick={() => handleSave('')} disabled={saving || !loaded}>
                  <ListRestart size={16} />
                  {t('llm.promptReset')}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default TranslatePrompt;
