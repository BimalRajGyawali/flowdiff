const STORAGE_KEY = 'flowdiff:github-token';
let sessionToken = '';

function normalizeToken(value) {
  return String(value ?? '').trim();
}

export function getStoredGithubToken() {
  if (typeof localStorage === 'undefined') return '';
  try {
    return normalizeToken(localStorage.getItem(STORAGE_KEY));
  } catch {
    return '';
  }
}

export function getGithubToken() {
  const inSession = normalizeToken(sessionToken);
  if (inSession) return inSession;
  const storedToken = getStoredGithubToken();
  if (storedToken) return storedToken;
  return normalizeToken(import.meta.env?.VITE_GITHUB_TOKEN);
}

export function setSessionGithubToken(token) {
  sessionToken = normalizeToken(token);
}

export function saveGithubToken(token) {
  if (typeof localStorage === 'undefined') return;
  const normalized = normalizeToken(token);
  try {
    if (!normalized) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    // Ignore localStorage failures; caller can still keep token in memory/UI.
  }
}

export function clearGithubToken() {
  sessionToken = '';
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function githubAuthHeaders() {
  const token = getGithubToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
