import { useTranslation } from 'react-i18next';
import { Copy, Check, X, Loader2, AlertTriangle } from 'lucide-react';
import type { InstanceView, MintedInstance } from '../services/api';

interface CreateForm {
  instanceId: string;
  sessionScope: string;
  verifyToken: string;
  config: string;
}

export function InstanceCreateModal({
  form,
  setForm,
  formError,
  pending,
  onClose,
  onSubmit,
}: {
  form: CreateForm;
  setForm: (f: CreateForm) => void;
  formError: string | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('plugins.instances.create')}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body plugin-instances">
          <label>{t('plugins.instances.form.instanceId')}</label>
          <input
            type="text"
            value={form.instanceId}
            placeholder={t('plugins.instances.form.instanceIdPlaceholder')}
            onChange={e => setForm({ ...form, instanceId: e.target.value })}
          />
          <p className="pi-hint">{t('plugins.instances.form.instanceIdHint')}</p>
          <label>{t('plugins.instances.form.sessionScope')}</label>
          <input
            type="text"
            value={form.sessionScope}
            placeholder={t('plugins.instances.form.sessionScopePlaceholder')}
            onChange={e => setForm({ ...form, sessionScope: e.target.value })}
          />
          <label>{t('plugins.instances.form.verifyToken')}</label>
          <input
            type="text"
            value={form.verifyToken}
            placeholder={t('plugins.instances.form.verifyTokenPlaceholder')}
            onChange={e => setForm({ ...form, verifyToken: e.target.value })}
          />
          <label>{t('plugins.instances.form.config')}</label>
          <textarea
            value={form.config}
            placeholder={t('plugins.instances.form.configPlaceholder')}
            onChange={e => setForm({ ...form, config: e.target.value })}
          />
          {formError && <p className="pi-error">{formError}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={onSubmit} disabled={pending || !form.instanceId}>
            {pending ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InstanceMintedModal({
  minted,
  mintedKind,
  copied,
  copy,
  onClose,
}: {
  minted: MintedInstance;
  mintedKind: 'created' | 'regenerated';
  copied: string | null;
  copy: (text: string, id: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {mintedKind === 'regenerated'
              ? t('plugins.instances.regenerate.title')
              : t('plugins.instances.created.title')}
          </h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body plugin-instances">
          <p className="pi-hint">{t('plugins.instances.created.hint')}</p>
          <label>{t('plugins.instances.created.secret')}</label>
          <div className="pi-secret">
            <code>{minted.secret}</code>
            <button className="btn-primary" onClick={() => void copy(minted.secret, 'secret')}>
              {copied === 'secret' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <label>{t('plugins.instances.created.ingressUrls')}</label>
          {minted.ingressUrls.map(u => (
            <div key={u.route} className="pi-secret">
              <code>{u.url}</code>
              <button className="btn-primary" onClick={() => void copy(u.url, `mint-${u.route}`)}>
                {copied === `mint-${u.route}` ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InstanceEditModal({
  editing,
  editForm,
  setEditForm,
  editError,
  pending,
  onClose,
  onSubmit,
}: {
  editing: InstanceView;
  editForm: { sessionScope: string; config: string };
  setEditForm: (f: { sessionScope: string; config: string }) => void;
  editError: string | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('plugins.instances.edit.title', { id: editing.instanceId })}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body plugin-instances">
          <label>{t('plugins.instances.form.sessionScope')}</label>
          <input
            type="text"
            value={editForm.sessionScope}
            placeholder={t('plugins.instances.form.sessionScopePlaceholder')}
            onChange={e => setEditForm({ ...editForm, sessionScope: e.target.value })}
          />
          <label>{t('plugins.instances.form.config')}</label>
          <textarea
            value={editForm.config}
            placeholder={t('plugins.instances.form.configPlaceholder')}
            onChange={e => setEditForm({ ...editForm, config: e.target.value })}
          />
          {editError && <p className="pi-error">{editError}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={onSubmit} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" size={16} /> : t('plugins.instances.actions.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InstanceConfirmModal({
  confirm,
  onClose,
  onConfirm,
}: {
  confirm: { type: 'delete' | 'regenerate'; inst: InstanceView };
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t(`plugins.instances.${confirm.type}.title`)}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body plugin-instances">
          <div className="pi-confirm-icon">
            <AlertTriangle size={40} />
          </div>
          <p>{t(`plugins.instances.${confirm.type}.confirm`, { id: confirm.inst.instanceId })}</p>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className={confirm.type === 'delete' ? 'btn-danger' : 'btn-primary'} onClick={onConfirm}>
            {t(`plugins.instances.${confirm.type}.action`)}
          </button>
        </div>
      </div>
    </div>
  );
}
