// Progress (stage 5).
import { h } from '../util.js';
export function renderProgress(root) {
  root.replaceChildren(h('header', { class: 'top' }, h('h1', null, 'Progress')));
}
