/**
 * FlowDiff entry point.
 * Bootstraps the app, wires PR input to the pipeline, and mounts the 3-pane UI.
 */

import { initStore, subscribe } from './state/store.js';
import { renderLayout } from './ui/layout.js';
import { fetchAndAnalyze } from './github/fetchPullRequest.js';

initStore();
renderLayout();

const prInput = document.getElementById('pr-url');
const analyzeBtn = document.getElementById('analyze-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const statusEl = document.getElementById('status');

async function handleAnalyze() {
  const url = prInput.value.trim();
  if (!url) {
    statusEl.textContent = 'Enter a PR URL';
    statusEl.classList.add('error');
    return;
  }
  loadingOverlay.classList.add('visible');
  loadingText.textContent = 'Fetching diff…';
  statusEl.textContent = '';
  statusEl.classList.remove('error');
  analyzeBtn.disabled = true;
  try {
    const result = await fetchAndAnalyze(url);
    statusEl.textContent = result?.source === 'cache' ? 'Loaded from cache' : 'Done';
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
