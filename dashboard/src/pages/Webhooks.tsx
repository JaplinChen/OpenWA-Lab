import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Webhook as WebhookIcon, AlertCircle } from 'lucide-react';
import { webhookApi, type Webhook } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useWebhooksQuery,
  useSessionsQuery,
  useSessionChatsQuery,
  useCreateWebhookMutation,
  useUpdateWebhookMutation,
  useDeleteWebhookMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { PageLoader } from '../components/PageLoader';
import { useToast } from '../components/Toast';
import { availableEventNames, supportsFilters } from '../components/webhooks/webhook-events';
import {
  CreateWebhookModal,
  EditWebhookModal,
  DeleteWebhookModal,
  type NewWebhookState,
} from '../components/webhooks/WebhookModals';
import { WebhookCard } from '../components/webhooks/WebhookCard';
import './Webhooks.css';

export function Webhooks() {
  const { t } = useTranslation();
  useDocumentTitle(t('webhooks.title'));
  const { canWrite } = useRole();
  const { data: webhooks = [], isLoading: loadingWebhooks, isError: webhooksError } = useWebhooksQuery();
  const { data: sessions = [] } = useSessionsQuery();
  const loading = loadingWebhooks;
  const createMutation = useCreateWebhookMutation();
  const updateMutation = useUpdateWebhookMutation();
  const deleteMutation = useDeleteWebhookMutation();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; id: string; url: string } | null>(null);
  const [editWebhook, setEditWebhook] = useState<Webhook | null>(null);
  const [newWebhook, setNewWebhook] = useState<NewWebhookState>({
    url: '',
    events: ['message.received'],
    sessionId: '',
    filters: null,
  });
  const [testingId, setTestingId] = useState<string | null>(null);
  const toast = useToast();

  // Single source for the contact/group autocomplete in whichever modal is open.
  const activeSessionId = showEditModal ? editWebhook?.sessionId ?? '' : newWebhook.sessionId;
  const { data: chats = [] } = useSessionChatsQuery(activeSessionId, showCreateModal || showEditModal);

  const eventDescription = (name: string) => {
    if (name === '*') return t('webhooks.eventDescriptions.all');
    return t(`webhooks.eventDescriptions.${name}`, { defaultValue: name });
  };

  const handleCreate = async () => {
    if (!newWebhook.url || !newWebhook.sessionId) return;
    try {
      await createMutation.mutateAsync({
        sessionId: newWebhook.sessionId,
        url: newWebhook.url,
        events: newWebhook.events,
        // Don't persist message-filters when no message events are selected (the filter UI is hidden).
        filters: supportsFilters(newWebhook.events) ? newWebhook.filters : null,
      });
      setShowCreateModal(false);
      setNewWebhook({ url: '', events: ['message.received'], sessionId: '', filters: null });
      toast.success(t('webhooks.toasts.created'));
    } catch (err) {
      toast.error(
        t('webhooks.toasts.createFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const confirmDelete = (sessionId: string, id: string, url: string) => {
    setDeleteTarget({ sessionId, id, url });
    setShowDeleteModal(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: deleteTarget.sessionId, id: deleteTarget.id });
      setShowDeleteModal(false);
      setDeleteTarget(null);
      toast.success(t('webhooks.toasts.deleted'));
    } catch (err) {
      toast.error(
        t('webhooks.toasts.deleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleTest = async (sessionId: string, id: string) => {
    setTestingId(id);
    try {
      const result = await webhookApi.test(sessionId, id);
      if (result.success) {
        toast.success(t('webhooks.toasts.testOk', { status: result.statusCode }));
      } else {
        toast.error(t('webhooks.toasts.testFailed', { message: result.error || `Status ${result.statusCode}` }));
      }
    } catch (err) {
      toast.error(
        t('webhooks.toasts.testError', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    } finally {
      setTestingId(null);
    }
  };

  const openEdit = (webhook: Webhook) => {
    setEditWebhook({ ...webhook });
    setShowEditModal(true);
  };

  const handleEdit = async () => {
    if (!editWebhook) return;
    try {
      await updateMutation.mutateAsync({
        sessionId: editWebhook.sessionId,
        id: editWebhook.id,
        data: {
          url: editWebhook.url,
          events: editWebhook.events,
          active: editWebhook.active,
          // Clear message-filters if the edit removed all message events (the filter UI is hidden then).
          filters: supportsFilters(editWebhook.events) ? (editWebhook.filters ?? null) : null,
        },
      });
      setShowEditModal(false);
      setEditWebhook(null);
      toast.success(t('webhooks.toasts.updated'));
    } catch (err) {
      toast.error(
        t('webhooks.toasts.updateFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const toggleEditEvent = (event: string) => {
    if (!editWebhook) return;
    setEditWebhook({
      ...editWebhook,
      events: editWebhook.events.includes(event)
        ? editWebhook.events.filter(e => e !== event)
        : [...editWebhook.events, event],
    });
  };

  const toggleNewEvent = (event: string) => {
    setNewWebhook(prev => ({
      ...prev,
      events: prev.events.includes(event) ? prev.events.filter(e => e !== event) : [...prev.events, event],
    }));
  };

  if (loading) {
    return (
      <PageLoader className="webhooks-page" />
    );
  }

  return (
    <div className="webhooks-page">
      <PageHeader
        title={t('webhooks.title')}
        subtitle={t('webhooks.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} />
              {t('webhooks.addWebhook')}
            </button>
          )
        }
      />

      {webhooksError && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('dashboard.loadError')}</span>
        </div>
      )}

      {showCreateModal && (
        <CreateWebhookModal
          newWebhook={newWebhook}
          setNewWebhook={setNewWebhook}
          sessions={sessions}
          chats={chats}
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
          onToggleEvent={toggleNewEvent}
        />
      )}

      {showEditModal && editWebhook && (
        <EditWebhookModal
          editWebhook={editWebhook}
          setEditWebhook={setEditWebhook}
          chats={chats}
          onClose={() => setShowEditModal(false)}
          onSave={handleEdit}
          onToggleEvent={toggleEditEvent}
        />
      )}

      {showDeleteModal && deleteTarget && (
        <DeleteWebhookModal
          url={deleteTarget.url}
          onClose={() => setShowDeleteModal(false)}
          onDelete={handleDelete}
        />
      )}

      <div className="webhooks-content">
        <div className="webhooks-list-container">
          {webhooks.length === 0 ? (
            <div className="empty-table-state">
              <WebhookIcon size={48} strokeWidth={1} />
              <h3>{t('webhooks.empty.title')}</h3>
              <p>{t('webhooks.empty.description')}</p>
            </div>
          ) : (
            <div className="webhooks-card-list">
              {webhooks.map(webhook => (
                <WebhookCard
                  key={webhook.id}
                  webhook={webhook}
                  sessionName={
                    sessions.find(s => s.id === webhook.sessionId)?.name || webhook.sessionId.substring(0, 12)
                  }
                  canWrite={canWrite}
                  testing={testingId === webhook.id}
                  onTest={() => handleTest(webhook.sessionId, webhook.id)}
                  onEdit={() => openEdit(webhook)}
                  onDelete={() => confirmDelete(webhook.sessionId, webhook.id, webhook.url)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="events-reference">
          <h3>{t('webhooks.available')}</h3>
          <div className="events-list">
            {availableEventNames.map(name => (
              <div key={name} className="event-item">
                <code>{name}</code>
                <span>{eventDescription(name)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
