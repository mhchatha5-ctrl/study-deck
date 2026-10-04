// Lint config (optional): npx eslint js sw.js
const browser = Object.fromEntries([
  'window', 'document', 'navigator', 'location', 'history', 'indexedDB', 'localStorage', 'sessionStorage',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'ResizeObserver',
  'URL', 'Blob', 'File', 'Node', 'console', 'matchMedia', 'caches', 'self', 'fetch', 'SpeechSynthesisUtterance',
  'Response', 'TextEncoder', 'TextDecoder', 'AbortController', 'structuredClone', 'crypto', 'getComputedStyle',
  'DOMException', 'Intl',
].map((g) => [g, 'readonly']));
export default [
  {
    files: ['js/**/*.js', 'sw.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: browser },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'warn' },
  },
];
