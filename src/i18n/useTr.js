import { useCallback } from 'react';
import { useUserSettings } from '../contexts/UserSettingsContext';
import { normalizeLanguage, t } from './translate';

export function useTr() {
  const { settings } = useUserSettings();
  const language = normalizeLanguage(settings?.language);
  const tr = useCallback((key, fallback) => t(language, key, fallback), [language]);
  return { language, tr };
}
