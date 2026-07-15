import { useTranslation } from 'react-i18next';
import { Trash2, Plus } from 'lucide-react';
import { coerceFieldInput, emptyForField } from '../../utils/pluginConfigForm';
import type { PluginConfigField } from '../../services/api';

/**
 * Renders one config field from a plugin's schema and reports edits via `onChange`. Recurses for
 * nested objects and array-of-rows. Module-scope (stable identity) so inputs keep focus across
 * keystrokes. The secret redact/restore round-trip lives server-side (PUT /plugins/:id/config).
 */
export function ConfigField({
  field,
  label,
  value,
  onChange,
}: {
  field: PluginConfigField;
  label: string;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const { t } = useTranslation();
  const desc = field.description ? <small>{field.description}</small> : null;
  const labelEl = (
    <label>
      {label}
      {field.required && <span className="required-mark"> *</span>}
    </label>
  );

  if (field.type === 'boolean') {
    return (
      <div className="form-group toggle-group">
        <div className="toggle-info">
          <label>{label}</label>
          {desc}
        </div>
        <label className="toggle-switch">
          <input type="checkbox" checked={Boolean(value)} onChange={e => onChange(e.target.checked)} />
          <span className="toggle-slider"></span>
        </label>
      </div>
    );
  }

  if (field.enum && field.enum.length > 0) {
    const options = field.enum;
    return (
      <div className="form-group">
        {labelEl}
        <select
          value={String(value ?? '')}
          // Restore the option's original type (e.g. a number/boolean enum), not the raw string value.
          onChange={e => onChange(options.find(o => String(o) === e.target.value) ?? e.target.value)}
        >
          {options.map(opt => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
        {desc}
      </div>
    );
  }

  if (field.type === 'object') {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const props = field.properties ?? {};
    return (
      <fieldset className="config-fieldset">
        <legend>{label}</legend>
        {desc}
        {Object.entries(props).map(([k, sub]) => (
          <ConfigField
            key={k}
            field={sub}
            label={sub.title || k}
            value={obj[k]}
            onChange={v => onChange({ ...obj, [k]: v })}
          />
        ))}
      </fieldset>
    );
  }

  if (field.type === 'array') {
    const rows = Array.isArray(value) ? value : [];
    const item = field.items;
    if (!item) {
      // No element schema declared — nothing to render safely (don't fall through to a text input
      // that would stringify the array to "[object Object]"/"" and corrupt it).
      return (
        <div className="config-array">
          {labelEl}
          {desc}
        </div>
      );
    }
    return (
      <div className="config-array">
        {labelEl}
        {desc}
        {rows.map((row, i) => (
          <div className="config-array-row" key={i}>
            <div className="config-array-row-body">
              <ConfigField
                field={item}
                label={`#${i + 1}`}
                value={row}
                onChange={v => onChange(rows.map((r, j) => (j === i ? v : r)))}
              />
            </div>
            <button
              type="button"
              className="config-array-remove"
              title={t('common.delete')}
              aria-label={t('common.delete')}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="config-array-add" onClick={() => onChange([...rows, emptyForField(item)])}>
          <Plus size={14} /> {t('plugins.config.addItem')}
        </button>
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div className="form-group">
        {labelEl}
        <textarea
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.default !== undefined ? String(field.default) : undefined}
          required={field.required}
          minLength={field.min}
          maxLength={field.max}
          rows={4}
          onChange={e => onChange(e.target.value)}
        />
        {desc}
      </div>
    );
  }

  const inputType = field.type === 'number' ? 'number' : field.secret ? 'password' : 'text';
  return (
    <div className="form-group">
      {labelEl}
      <input
        type={inputType}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={field.default !== undefined ? String(field.default) : undefined}
        autoComplete={field.secret ? 'new-password' : undefined}
        required={field.required}
        min={field.type === 'number' ? field.min : undefined}
        max={field.type === 'number' ? field.max : undefined}
        minLength={field.type !== 'number' ? field.min : undefined}
        maxLength={field.type !== 'number' ? field.max : undefined}
        pattern={field.type !== 'number' ? field.pattern : undefined}
        onChange={e => onChange(coerceFieldInput(field, e.target.value))}
      />
      {desc}
    </div>
  );
}
