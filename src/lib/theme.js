// Shared light/dark/system presentation handling for extension pages.
import { getSettings } from './config.js';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function resolve(preference) {
  if (preference === 'light' || preference === 'dark') return preference;
  return media().matches ? 'dark' : 'light';
}

let listener = null;
let listenerTarget = null;

export function setTheme(preference = 'system') {
  document.documentElement.setAttribute('data-theme', resolve(preference));
  if (listenerTarget && listener) listenerTarget.removeEventListener('change', listener);
  listener = null;
  listenerTarget = null;
  if (preference === 'system') {
    listenerTarget = media();
    listener = () => document.documentElement.setAttribute('data-theme', resolve('system'));
    listenerTarget.addEventListener('change', listener);
  }
}

export async function initTheme() {
  const settings = await getSettings();
  setTheme(settings.theme || 'system');
  return settings.theme || 'system';
}
