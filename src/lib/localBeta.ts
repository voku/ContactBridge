export type ExportAttemptState = {
  format: string;
  ok: boolean;
  timestamp: string;
};

const LAST_EXPORT_ATTEMPT_KEY = 'contactbridge:last-export-attempt';
const EXTENSION_CONFIGURED_KEY = 'contactbridge:extension-configured';

const readJson = <T>(key: string): T | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const getLastExportAttempt = () => readJson<ExportAttemptState>(LAST_EXPORT_ATTEMPT_KEY);

export const setLastExportAttempt = (attempt: ExportAttemptState) => {
  window.localStorage.setItem(LAST_EXPORT_ATTEMPT_KEY, JSON.stringify(attempt));
};

export const isExtensionConfigured = () => window.localStorage.getItem(EXTENSION_CONFIGURED_KEY) === 'true';

export const setExtensionConfigured = (value: boolean) => {
  window.localStorage.setItem(EXTENSION_CONFIGURED_KEY, value ? 'true' : 'false');
};
