import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Copy, Check, RefreshCw, Pencil, Trash2, Loader2, Power } from 'lucide-react';
import type { InstanceView, MintedInstance } from '../services/api';
import {
  InstanceCreateModal,
  InstanceMintedModal,
  InstanceEditModal,
  InstanceConfirmModal,
} from './PluginInstanceModals';
import {
  usePluginInstancesQuery,
  useCreateInstanceMutation,
  useRegenerateInstanceSecretMutation,
  useUpdateInstanceMutation,
  useDeleteInstanceMutation,
} from '../hooks/queries';
import { isValidInstanceId, parseInstanceConfig } from '../utils/instanceForm';
import { copyToClipboard } from '../utils/clipboard';
import { useToast } from './Toast';
import './PluginInstances.css';

const emptyForm = { instanceId: '', sessionScope: '', verifyToken: '', config: '' };

export function PluginInstances({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data: instances = [], isLoading, isError } = usePluginInstancesQuery(pluginId, true);
  const createM = useCreateInstanceMutation(pluginId);
  const regenM = useRegenerateInstanceSecretMutation(pluginId);
  const updateM = useUpdateInstanceMutation(pluginId);
  const deleteM = useDeleteInstanceMutation(pluginId);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedInstance | null>(null); // secret-shown-once view
  const [mintedKind, setMintedKind] = useState<'created' | 'regenerated'>('created');
  const [editing, setEditing] = useState<InstanceView | null>(null);
  const [editForm, setEditForm] = useState({ sessionScope: '', config: '' });
  const [editError, setEditError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ type: 'delete' | 'regenerate'; inst: InstanceView } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, id: string) => {
    if (await copyToClipboard(text)) {
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const openCreate = () => {
    setForm(emptyForm);
    setFormError(null);
    setShowForm(true);
  };

  const submitCreate = async () => {
    if (!isValidInstanceId(form.instanceId)) {
      setFormError(t('plugins.instances.errors.invalidId'));
      return;
    }
    const parsed = parseInstanceConfig(form.config);
    if (!parsed.ok) {
      setFormError(t('plugins.instances.errors.invalidJson'));
      return;
    }
    try {
      const created = await createM.mutateAsync({
        instanceId: form.instanceId,
        sessionScope: form.sessionScope.trim() || undefined,
        verifyToken: form.verifyToken.trim() || undefined,
        config: parsed.value,
      });
      setShowForm(false);
      setForm(emptyForm);
      setMintedKind('created');
      setMinted(created);
      toast.success(t('plugins.instances.toasts.created'), created.instanceId);
    } catch (err) {
      const e = err as Error & { status?: number };
      setFormError(e.status === 409 ? t('plugins.instances.errors.duplicateId') : e.message);
    }
  };

  const toggleEnabled = async (inst: InstanceView) => {
    try {
      await updateM.mutateAsync({ instanceId: inst.instanceId, body: { enabled: !inst.enabled } });
      toast.success(t('plugins.instances.toasts.updated'), inst.instanceId);
    } catch (err) {
      toast.error(t('plugins.instances.toasts.actionFailed'), (err as Error).message);
    }
  };

  const openEdit = (inst: InstanceView) => {
    setEditing(inst);
    setEditForm({
      sessionScope: inst.sessionScope ?? '',
      config: inst.config ? JSON.stringify(inst.config, null, 2) : '',
    });
    setEditError(null);
  };

  const submitEdit = async () => {
    if (!editing) return;
    const parsed = parseInstanceConfig(editForm.config);
    if (!parsed.ok) {
      setEditError(t('plugins.instances.errors.invalidJson'));
      return;
    }
    try {
      await updateM.mutateAsync({
        instanceId: editing.instanceId,
        // Blank → omit (leave scope unchanged); mirrors create. Sending '' would corrupt an
        // all-sessions (null) instance into a literal empty scope the backend never clears.
        body: { sessionScope: editForm.sessionScope.trim() || undefined, config: parsed.value ?? {} },
      });
      setEditing(null);
      toast.success(t('plugins.instances.toasts.updated'), editing.instanceId);
    } catch (err) {
      setEditError((err as Error).message);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const { type, inst } = confirm;
    setConfirm(null);
    try {
      if (type === 'delete') {
        await deleteM.mutateAsync(inst.instanceId);
        toast.success(t('plugins.instances.toasts.deleted'), inst.instanceId);
      } else {
        const res = await regenM.mutateAsync(inst.instanceId);
        setMintedKind('regenerated');
        setMinted(res);
        toast.success(t('plugins.instances.toasts.secretRegenerated'), inst.instanceId);
      }
    } catch (err) {
      toast.error(t('plugins.instances.toasts.actionFailed'), (err as Error).message);
    }
  };

  return (
    <div className="plugin-instances">
      <div className="pi-header">
        <p className="pi-desc">{t('plugins.instances.description')}</p>
        <button className="btn-primary" onClick={openCreate}>
          <Plus size={16} />
          {t('plugins.instances.create')}
        </button>
      </div>

      {isLoading ? (
        <div className="pi-loading">
          <Loader2 className="animate-spin" size={24} />
        </div>
      ) : isError ? (
        <p className="pi-error">{t('plugins.instances.loadError')}</p>
      ) : instances.length === 0 ? (
        <p className="pi-empty">{t('plugins.instances.empty')}</p>
      ) : (
        <div className="pi-list">
          {instances.map(inst => (
            <div key={inst.id} className="pi-row">
              <div className="pi-main">
                <span className="pi-id">{inst.instanceId}</span>
                <span className="pi-scope">{inst.sessionScope || t('plugins.instances.allSessions')}</span>
              </div>
              {inst.ingressUrls[0] && (
                <div className="pi-url">
                  <code title={inst.ingressUrls[0].url}>{inst.ingressUrls[0].url}</code>
                  <button
                    className="icon-btn-sm"
                    onClick={() => void copy(inst.ingressUrls[0].url, `url-${inst.id}`)}
                    title={t('plugins.instances.actions.copy')}
                  >
                    {copied === `url-${inst.id}` ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              )}
              <span className={`pi-badge ${inst.enabled ? 'on' : 'off'}`}>
                {inst.enabled ? t('plugins.instances.enabled') : t('plugins.instances.disabled')}
              </span>
              <div className="pi-actions">
                <button className="icon-btn" onClick={() => void toggleEnabled(inst)} title={t(`plugins.instances.actions.${inst.enabled ? 'disable' : 'enable'}`)}>
                  <Power size={16} />
                </button>
                <button className="icon-btn" onClick={() => setConfirm({ type: 'regenerate', inst })} title={t('plugins.instances.actions.regenerate')}>
                  <RefreshCw size={16} />
                </button>
                <button className="icon-btn" onClick={() => openEdit(inst)} title={t('plugins.instances.actions.edit')}>
                  <Pencil size={16} />
                </button>
                <button className="icon-btn danger" onClick={() => setConfirm({ type: 'delete', inst })} title={t('plugins.instances.actions.delete')}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal — form, or the secret-shown-once view after mint */}
      {showForm && (
        <InstanceCreateModal
          form={form}
          setForm={setForm}
          formError={formError}
          pending={createM.isPending}
          onClose={() => setShowForm(false)}
          onSubmit={() => void submitCreate()}
        />
      )}

      {/* Secret-shown-once modal (after create or regenerate) */}
      {minted && (
        <InstanceMintedModal
          minted={minted}
          mintedKind={mintedKind}
          copied={copied}
          copy={copy}
          onClose={() => setMinted(null)}
        />
      )}

      {/* Edit modal — sessionScope + config */}
      {editing && (
        <InstanceEditModal
          editing={editing}
          editForm={editForm}
          setEditForm={setEditForm}
          editError={editError}
          pending={updateM.isPending}
          onClose={() => setEditing(null)}
          onSubmit={() => void submitEdit()}
        />
      )}

      {/* Confirm modal — delete or regenerate */}
      {confirm && (
        <InstanceConfirmModal confirm={confirm} onClose={() => setConfirm(null)} onConfirm={() => void runConfirm()} />
      )}
    </div>
  );
}
