/**
 * FlowDiff entry point.
 * Bootstraps the app, wires PR input to the pipeline, and mounts the 3-pane UI.
 */

import { initStore, subscribe } from './state/store.js';
import { renderLayout } from './ui/layout.js';
import { fetchAndAnalyze } from './github/fetchPullRequest.js';
import {
  clearGithubToken,
  getGithubToken,
  getStoredGithubToken,
  saveGithubToken,
  setSessionGithubToken
} from './github/auth.js';

initStore();
renderLayout();

const prInput = document.getElementById('pr-url');
const githubAuthPanel = document.getElementById('github-auth-panel');
const githubTokenInput = document.getElementById('github-token');
const rememberTokenCheckbox = document.getElementById('remember-token');
const clearTokenBtn = document.getElementById('clear-token-btn');
const authStatusEl = document.getElementById('auth-status');
const analyzeBtn = document.getElementById('analyze-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const statusEl = document.getElementById('status');

function initGithubTokenUi() {
  if (!githubTokenInput || !rememberTokenCheckbox || !clearTokenBtn) return;

  const setAuthStatus = (message) => {
    if (!authStatusEl) return;
    authStatusEl.textContent = message;
  };

  const storedToken = getStoredGithubToken();
  if (storedToken) {
    githubTokenInput.value = storedToken;
    rememberTokenCheckbox.checked = true;
  }
  setSessionGithubToken(githubTokenInput.value);

  githubTokenInput.addEventListener('input', () => {
    setSessionGithubToken(githubTokenInput.value);
    if (rememberTokenCheckbox.checked) saveGithubToken(githubTokenInput.value);
    if (githubTokenInput.value.trim() && statusEl.textContent === 'Set your GitHub token first (Auth)') {
      statusEl.textContent = '';
      statusEl.classList.remove('error');
    }
  });

  rememberTokenCheckbox.addEventListener('change', () => {
    if (rememberTokenCheckbox.checked) {
      saveGithubToken(githubTokenInput.value);
      setAuthStatus(githubTokenInput.value.trim()
        ? 'GitHub token saved locally on this browser'
        : 'Remember is on (token is currently empty)');
      return;
    }
    clearGithubToken();
    setAuthStatus('Remember is off. Token is no longer stored locally.');
  });

  clearTokenBtn.addEventListener('click', () => {
    githubTokenInput.value = '';
    clearGithubToken();
    rememberTokenCheckbox.checked = false;
    setAuthStatus('Stored GitHub token cleared');
  });

  if (githubAuthPanel) {
    githubAuthPanel.addEventListener('toggle', () => {
      if (!githubAuthPanel.open) setAuthStatus('');
    });
    document.addEventListener('click', (event) => {
      if (!githubAuthPanel.open) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!githubAuthPanel.contains(target)) githubAuthPanel.open = false;
    });
  }
}

async function handleAnalyze() {
  const url = prInput.value.trim();
  const githubToken = getGithubToken();
  if (!url) {
    statusEl.textContent = 'Enter a PR URL';
    statusEl.classList.add('error');
    return;
  }
  if (!githubToken) {
    statusEl.textContent = 'Set your GitHub token first (Auth)';
    statusEl.classList.add('error');
    return;
  }
  loadingOverlay.classList.add('visible');
  loadingText.textContent = 'Fetching diff…';
  statusEl.textContent = '';
  statusEl.classList.remove('error');
  analyzeBtn.disabled = true;
  try {
    await fetchAndAnalyze(url);
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = err.message || 'Failed to analyze PR';
    statusEl.classList.add('error');
  } finally {
    analyzeBtn.disabled = false;
    loadingOverlay.classList.remove('visible');
  }
}

analyzeBtn.addEventListener('click', handleAnalyze);
prInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleAnalyze();
});
initGithubTokenUi();
