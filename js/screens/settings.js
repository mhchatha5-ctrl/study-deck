// Settings (filled in over the next stages).
import { h } from '../util.js';
export function renderSettings(root) {
  root.replaceChildren(h('header', { class: 'top' }, h('h1', null, 'Settings')));
}
export function exportBackup() {}
