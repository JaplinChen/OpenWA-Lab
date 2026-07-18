import { useEffect, useRef } from 'react';

/**
 * Drag-resizes the first grid column of a panel whose rows read `var(--col-src)`, persisting the
 * width in localStorage. Values are set via CSS custom property on the panel element, not inline
 * grid styles, so the stylesheet stays the single source of the row template.
 */
export function useResizableCol(storageKey: string) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved && ref.current) ref.current.style.setProperty('--col-src', saved);
  }, [storageKey]);

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const panel = ref.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const pct = Math.min(70, Math.max(15, ((ev.clientX - rect.left) / rect.width) * 100));
      panel.style.setProperty('--col-src', `${pct.toFixed(1)}%`);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const v = panel.style.getPropertyValue('--col-src');
      if (v) localStorage.setItem(storageKey, v);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return { ref, onResizeStart };
}
