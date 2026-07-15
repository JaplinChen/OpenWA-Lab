import { emptyForField } from '../../utils/pluginConfigForm';
import type { Plugin } from '../../services/api';

/**
 * Build a sparse per-session config override from a full edited config: include only non-secret keys
 * whose value differs from the Global base (so untouched keys keep inheriting Global), plus every
 * TOP-LEVEL secret key (the backend restores an untouched `***` to the stored per-session value, or
 * drops it → the host's deep-merge then re-inherits it from Global). A key absent from the base whose
 * value is just the empty default is skipped, so an untouched optional field never creates a spurious
 * override. With no schema, the input is returned as-is.
 *
 * Inheritance of untouched secrets holds for top-level secret keys and secrets nested in an OBJECT
 * (deep-merged). It does NOT hold for a `secret` column inside an array-of-rows: arrays are replaced
 * wholesale at resolve time, so a first-time per-session override that edits any cell of such an array
 * loses the untouched rows' secrets (they redact to `***`, the dashboard can't resend the real value).
 * No bundled plugin ships that shape; a plugin needing per-session array secrets should re-enter them.
 */
export function sparseSessionOverride(full: Record<string, unknown>, plugin: Plugin): Record<string, unknown> {
  const props = plugin.configSchema?.properties;
  if (!props) return full;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(props)) {
    if (!(key in full)) continue;
    const val = full[key];
    if (field.secret) {
      out[key] = val;
      continue;
    }
    if (JSON.stringify(val) === JSON.stringify(plugin.config[key])) continue; // unchanged → inherit Global
    if (plugin.config[key] === undefined && JSON.stringify(val) === JSON.stringify(emptyForField(field))) {
      continue; // untouched optional field with no Global value → don't pin a spurious empty override
    }
    out[key] = val;
  }
  return out;
}
