import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Search, Plus, Trash2, Pencil } from 'lucide-react';
import { useResizableCol } from '../hooks/useResizableCol';
import { useSortableTable } from '../hooks/useSortableTable';
import { pageWindow } from '../utils/pageWindow';
import './EditableTable.css';

export type TableSortKey = 'key' | 'val' | 'count';

interface Props<T> {
  rows: T[];
  titleLabel: string;
  keyLabel: string;
  valLabel: string;
  addLabel: string;
  emptyIcon: ReactNode;
  emptyText: string;
  canWrite: boolean;
  busy: boolean;
  resizeStorageKey: string;
  initialSortKey: TableSortKey;
  rowKey: (row: T) => string;
  rowVal: (row: T) => string;
  rowCount: (row: T) => number;
  renderKey?: (row: T) => ReactNode;
  compareKey: (a: T, b: T) => number;
  compareVal: (a: T, b: T) => number;
  tieBreak: (a: T, b: T) => number;
  onAdd: (key: string, val: string) => Promise<boolean>;
  onSaveEdit: (originalKey: string, key: string, val: string) => Promise<boolean>;
  onRemove: (key: string) => void;
}

export function EditableKeyValueTable<T>({
  rows,
  titleLabel,
  keyLabel,
  valLabel,
  addLabel,
  emptyIcon,
  emptyText,
  canWrite,
  busy,
  resizeStorageKey,
  initialSortKey,
  rowKey,
  rowVal,
  rowCount,
  renderKey = rowKey,
  compareKey,
  compareVal,
  tieBreak,
  onAdd,
  onSaveEdit,
  onRemove,
}: Props<T>) {
  const { t } = useTranslation();
  const { ref: panelRef, onResizeStart } = useResizableCol(resizeStorageKey);

  const { filter, setFilter, filtered, toggleSort, sortMark, current, totalPages, paged, setPage } =
    useSortableTable<T, TableSortKey>({
      rows,
      initialKey: initialSortKey,
      descFirstKeys: ['count'],
      searchText: r => `${rowKey(r)}\n${rowVal(r)}`,
      compare: (a, b, k) =>
        k === 'count' ? rowCount(a) - rowCount(b) : k === 'key' ? compareKey(a, b) : compareVal(a, b),
      tieBreak,
    });

  const [keyInput, setKeyInput] = useState('');
  const [valInput, setValInput] = useState('');
  // The key column is the record's key, so the row being edited is tracked by its original key;
  // renaming one has to drop the old key, which `editing` still holds.
  const [editing, setEditing] = useState<string | null>(null);
  const [editKey, setEditKey] = useState('');
  const [editVal, setEditVal] = useState('');

  const add = async () => {
    const k = keyInput.trim();
    const v = valInput.trim();
    if (!k || !v) return;
    if (await onAdd(k, v)) {
      setKeyInput('');
      setValInput('');
    }
  };

  const startEdit = (row: T) => {
    setEditing(rowKey(row));
    setEditKey(rowKey(row));
    setEditVal(rowVal(row));
  };

  const cancelEdit = () => setEditing(null);

  const saveEdit = async (row: T) => {
    const k = editKey.trim();
    const v = editVal.trim();
    if (!k || !v) return;
    if (k === rowKey(row) && v === rowVal(row)) {
      setEditing(null);
      return;
    }
    if (await onSaveEdit(rowKey(row), k, v)) setEditing(null);
  };

  return (
    <section className="etable-panel" ref={panelRef as React.RefObject<HTMLElement>}>
      <div className="etable-head">
        <h3 className="etable-panel-title">
          {titleLabel}
          <span className="etable-count">{rows.length}</span>
        </h3>
      </div>

      {canWrite && (
        <div className="etable-add">
          <input
            type="text"
            placeholder={keyLabel}
            aria-label={keyLabel}
            value={keyInput}
            onChange={e => setKeyInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && add()}
          />
          <span className="etable-arrow">→</span>
          <input
            type="text"
            placeholder={valLabel}
            aria-label={valLabel}
            value={valInput}
            onChange={e => setValInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && add()}
          />
          <button className="btn-primary" onClick={add} disabled={busy || !keyInput.trim() || !valInput.trim()}>
            <Plus size={16} />
            {addLabel}
          </button>
        </div>
      )}

      <div className="etable-search">
        <Search size={16} className="etable-search-icon" />
        <input
          type="text"
          placeholder={t('common.search')}
          aria-label={t('common.search')}
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      {filtered.length > 0 && (
        <div className="etable-cols">
          <button className="etable-col-sort" onClick={() => toggleSort('key')}>
            {keyLabel}{sortMark('key')}
          </button>
          <span className="etable-col-resize" aria-hidden="true" onMouseDown={onResizeStart}>→</span>
          <button className="etable-col-sort" onClick={() => toggleSort('val')}>
            {valLabel}{sortMark('val')}
          </button>
          <button className="etable-col-sort etable-col-sort--num" onClick={() => toggleSort('count')}>
            {t('common.usageCount')}{sortMark('count')}
          </button>
          {canWrite && <span className="etable-col-label">{t('common.actions')}</span>}
        </div>
      )}
      <div className="etable-list">
        {filtered.length === 0 ? (
          <div className="etable-empty">
            {emptyIcon}
            <p>{emptyText}</p>
          </div>
        ) : (
          paged.map(row =>
            editing === rowKey(row) ? (
              <div key={rowKey(row)} className="etable-item etable-item--editing">
                <input
                  className="etable-edit"
                  value={editKey}
                  aria-label={keyLabel}
                  autoFocus
                  onChange={e => setEditKey(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void saveEdit(row);
                    if (e.key === 'Escape') cancelEdit();
                  }}
                />
                <span className="etable-arrow">→</span>
                <input
                  className="etable-edit"
                  value={editVal}
                  aria-label={valLabel}
                  onChange={e => setEditVal(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void saveEdit(row);
                    if (e.key === 'Escape') cancelEdit();
                  }}
                />
                <div className="etable-row-actions">
                  <button
                    className="etable-del"
                    onClick={() => void saveEdit(row)}
                    disabled={busy || !editKey.trim() || !editVal.trim()}
                    title={t('common.save')}
                  >
                    <Check size={16} />
                  </button>
                  <button className="etable-del" onClick={cancelEdit} disabled={busy} title={t('common.cancel')}>
                    <X size={16} />
                  </button>
                </div>
              </div>
            ) : (
              <div key={rowKey(row)} className="etable-item">
                <span className="etable-src">{renderKey(row)}</span>
                <span className="etable-arrow">→</span>
                <span className="etable-tgt">{rowVal(row)}</span>
                <span className="etable-usage" title={t('common.usageCount')}>{rowCount(row)}</span>
                {canWrite && (
                  <div className="etable-row-actions">
                    <button
                      className="etable-del"
                      onClick={() => startEdit(row)}
                      disabled={busy}
                      title={t('common.edit')}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="etable-del"
                      onClick={() => onRemove(rowKey(row))}
                      disabled={busy}
                      title={t('common.delete')}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>
            ),
          )
        )}
      </div>

      {totalPages > 1 && (
        <div className="pagination">
          <button disabled={current === 1} onClick={() => setPage(current - 1)}>
            {t('common.previous')}
          </button>
          <span className="page-numbers">
            {pageWindow(current, totalPages).map(p => (
              <button key={p} className={p === current ? 'active' : ''} onClick={() => setPage(p)}>
                {p}
              </button>
            ))}
          </span>
          <button disabled={current >= totalPages} onClick={() => setPage(current + 1)}>
            {t('common.next')}
          </button>
        </div>
      )}
    </section>
  );
}
