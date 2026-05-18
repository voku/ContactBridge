const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

export const getApiBaseUrl = () => {
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

  if (!configuredBaseUrl) {
    return '';
  }

  return trimTrailingSlash(configuredBaseUrl);
};

export const apiUrl = (path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const baseUrl = getApiBaseUrl();

  return `${baseUrl}${normalizedPath}`;
};

export const getHubUrl = () => {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    return window.location.origin;
  }

  try {
    return new URL(baseUrl).origin;
  } catch {
    return window.location.origin;
  }
};

export const getAllowedPopupOrigins = () => {
  const allowedOrigins = new Set<string>([window.location.origin]);
  const apiBaseUrl = getApiBaseUrl();

  if (apiBaseUrl) {
    allowedOrigins.add(new URL(apiBaseUrl).origin);
  }

  return allowedOrigins;
};
