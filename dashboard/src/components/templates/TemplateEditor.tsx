import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import type { MessageTemplate } from '../../services/api';
import type { TemplateForm } from './template-utils';

export function TemplateEditor({
  form,
  setForm,
  editingTemplate,
  sessionName,
  canWrite,
  isSaving,
  canSave,
  onCancel,
  onSave,
  onCopyName,
  onDeleteRequest,
}: {
  form: TemplateForm;
  setForm: (form: TemplateForm) => void;
  editingTemplate: MessageTemplate | null;
  sessionName: string;
  canWrite: boolean;
  isSaving: boolean;
  canSave: boolean;
  onCancel: () => void;
  onSave: () => void;
  onCopyName: (name: string) => void;
  onDeleteRequest: (template: MessageTemplate) => void;
}) {
  // Visible labels that pointed at nothing: no htmlFor, no id.
  const nameFieldId = useId();
  const headerFieldId = useId();
  const bodyFieldId = useId();
  const footerFieldId = useId();
  const { t } = useTranslation();

  return (
    <section className="template-editor">
      <div className="template-editor-header">
        <div>
          <h2>{editingTemplate ? t('templates.editTitle') : t('templates.createTitle')}</h2>
          <p>{sessionName ? t('templates.sessionHint', { name: sessionName }) : ''}</p>
        </div>
        <div className="template-header-actions">
          {editingTemplate && (
            <button
              className="icon-btn"
              title={t('templates.actions.copyName')}
              onClick={() => onCopyName(editingTemplate.name)}
              type="button"
            >
              <Copy size={16} />
            </button>
          )}
          {editingTemplate && canWrite && (
            <button
              className="icon-btn danger"
              title={t('common.delete')}
              onClick={() => onDeleteRequest(editingTemplate)}
              type="button"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="template-form">
        <div className="form-group">
          <label htmlFor={nameFieldId}>{t('common.name')}</label>
          <input
            id={nameFieldId}
            value={form.name}
            onChange={event => setForm({ ...form, name: event.target.value })}
            placeholder={t('templates.namePlaceholder')}
            disabled={!canWrite}
          />
        </div>

        <div className="template-message-fields">
          <div className="form-group">
            <label htmlFor={headerFieldId}>{t('templates.header')}</label>
            <input
              id={headerFieldId}
              value={form.header}
              onChange={event => setForm({ ...form, header: event.target.value })}
              placeholder={t('templates.headerPlaceholder')}
              disabled={!canWrite}
            />
          </div>

          <div className="form-group body-field">
            <label htmlFor={bodyFieldId}>{t('templates.body')}</label>
            <textarea
              id={bodyFieldId}
              value={form.body}
              onChange={event => setForm({ ...form, body: event.target.value })}
              placeholder={t('templates.bodyPlaceholder')}
              rows={10}
              disabled={!canWrite}
            />
          </div>

          <div className="form-group">
            <label htmlFor={footerFieldId}>{t('templates.footer')}</label>
            <input
              id={footerFieldId}
              value={form.footer}
              onChange={event => setForm({ ...form, footer: event.target.value })}
              placeholder={t('templates.footerPlaceholder')}
              disabled={!canWrite}
            />
          </div>
        </div>

        <div className="template-editor-actions">
          <button className="btn-secondary" onClick={onCancel} disabled={isSaving} type="button">
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={onSave} disabled={!canSave} type="button">
            {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
            {canWrite ? t(editingTemplate ? 'templates.saveChanges' : 'templates.createTemplate') : t('templates.viewOnly')}
          </button>
        </div>
      </div>
    </section>
  );
}
