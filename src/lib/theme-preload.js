// Avoid a bright first paint while the stored preference loads asynchronously.
document.documentElement.setAttribute(
  'data-theme',
  matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
);
