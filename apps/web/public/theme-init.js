/* FinGate — tránh FOUC theme: đọc localStorage TRƯỚC khi React mount.
 * File ngoài vì CSP production là `script-src 'self'` (không inline). */
try {
  var s = JSON.parse(localStorage.getItem('fg.ui') || '{}');
  var t = s.theme || 'light';
  var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.fgTheme = dark ? 'dark' : 'light';
  if (s.density) document.documentElement.dataset.fgDensity = s.density;
} catch (e) {
  /* mặc định light/comfortable */
}
