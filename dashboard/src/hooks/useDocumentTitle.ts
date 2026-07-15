import { useEffect } from 'react';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends " | OpenWA-Lab" suffix.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | OpenWA-Lab`;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
