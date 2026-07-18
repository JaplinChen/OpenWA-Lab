import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Loader2 } from 'lucide-react';
import { type MessageTemplate } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useCreateTemplateMutation,
  useDeleteTemplateMutation,
  useSessionsQuery,
  useTemplatesQuery,
  useUpdateTemplateMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { copyToClipboard } from '../utils/clipboard';
import {
  type TemplateForm,
  emptyForm,
  extractPlaceholders,
  toPayload,
  renderPreview,
} from '../components/templates/template-utils';
import { TemplateLibrary } from '../components/templates/TemplateLibrary';
import { TemplatePreview } from '../components/templates/TemplatePreview';
import { TemplateDeleteModal } from '../components/templates/TemplateDeleteModal';
import { TemplateEditor } from '../components/templates/TemplateEditor';
import './Templates.css';

export function Templates() {
  const { t } = useTranslation();
  useDocumentTitle(t('templates.title'));
  const { canWrite } = useRole();
  const { data: sessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [form, setForm] = useState<TemplateForm>(emptyForm);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MessageTemplate | null>(null);
  const toast = useToast();
  const [previewValues, setPreviewValues] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState('');

  const { data: templates = [], isLoading: loadingTemplates } = useTemplatesQuery(selectedSessionId, !!selectedSessionId);
  const createMutation = useCreateTemplateMutation();
  const updateMutation = useUpdateTemplateMutation();
  const deleteMutation = useDeleteTemplateMutation();

  const selectedSession = sessions.find(session => session.id === selectedSessionId);
  const placeholders = useMemo(() => extractPlaceholders(form), [form]);
  const preview = useMemo(() => renderPreview(form, previewValues), [form, previewValues]);
  const filteredTemplates = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return templates;
    return templates.filter(template =>
      [template.name, template.header, template.body, template.footer]
        .filter(Boolean)
        .some(value => value!.toLowerCase().includes(query)),
    );
  }, [searchTerm, templates]);
  const isSaving = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0].id);
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    setPreviewValues(current => {
      const next: Record<string, string> = {};
      for (const key of placeholders) {
        next[key] = current[key] || '';
      }
      return next;
    });
  }, [placeholders]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingTemplate(null);
    setPreviewValues({});
  };

  const openEdit = (template: MessageTemplate) => {
    setEditingTemplate(template);
    setForm({
      name: template.name,
      header: template.header || '',
      body: template.body,
      footer: template.footer || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSave = async () => {
    if (!selectedSessionId || !form.name.trim() || !form.body.trim()) return;

    try {
      if (editingTemplate) {
        await updateMutation.mutateAsync({
          sessionId: selectedSessionId,
          id: editingTemplate.id,
          data: toPayload(form),
        });
        toast.success(t('templates.toasts.updated'));
      } else {
        await createMutation.mutateAsync({
          sessionId: selectedSessionId,
          data: toPayload(form),
        });
        toast.success(t('templates.toasts.created'));
      }
      resetForm();
    } catch (err) {
      toast.error(
        t(editingTemplate ? 'templates.toasts.updateFailed' : 'templates.toasts.createFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleDelete = async () => {
    if (!selectedSessionId || !deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: selectedSessionId, id: deleteTarget.id });
      toast.success(t('templates.toasts.deleted'));
      if (editingTemplate?.id === deleteTarget.id) resetForm();
      setDeleteTarget(null);
    } catch (err) {
      toast.error(
        t('templates.toasts.deleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const copyName = async (name: string) => {
    if (await copyToClipboard(name)) {
      toast.success(t('templates.toasts.copied'));
    }
  };

  if (loadingSessions) {
    return (
      <div className="templates-page templates-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="templates-page">
      <PageHeader
        title={t('templates.title')}
        subtitle={t('templates.subtitle')}
        actions={
          <select
            aria-label={t('common.session')}
            className="templates-session-select"
            value={selectedSessionId}
            onChange={event => {
              setSelectedSessionId(event.target.value);
              resetForm();
            }}
          >
            {sessions.length === 0 && <option value="">{t('templates.noSessions')}</option>}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        }
      />

      {sessions.length === 0 ? (
        <div className="templates-empty-page">
          <FileText size={48} strokeWidth={1} />
          <h3>{t('templates.empty.noSessionsTitle')}</h3>
          <p>{t('templates.empty.noSessionsDesc')}</p>
        </div>
      ) : (
        <div className="templates-workspace">
          <TemplateLibrary
            templates={templates}
            filteredTemplates={filteredTemplates}
            loading={loadingTemplates}
            canWrite={canWrite}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            selectedId={editingTemplate?.id ?? null}
            onNew={resetForm}
            onSelect={openEdit}
          />

          <TemplateEditor
            form={form}
            setForm={setForm}
            editingTemplate={editingTemplate}
            sessionName={selectedSession?.name ?? ''}
            canWrite={canWrite}
            isSaving={isSaving}
            canSave={!(!canWrite || isSaving || !selectedSessionId || !form.name.trim() || !form.body.trim())}
            onCancel={resetForm}
            onSave={handleSave}
            onCopyName={name => void copyName(name)}
            onDeleteRequest={setDeleteTarget}
          />

          <TemplatePreview
            preview={preview}
            placeholders={placeholders}
            previewValues={previewValues}
            onValuesChange={setPreviewValues}
          />
        </div>
      )}

      {deleteTarget && (
        <TemplateDeleteModal
          target={deleteTarget}
          deleting={deleteMutation.isPending}
          onClose={() => setDeleteTarget(null)}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
