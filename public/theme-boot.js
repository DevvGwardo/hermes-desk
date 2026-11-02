// Pre-paint theme: runs synchronously in <head> (a same-origin file, so the
// strict CSP needs no inline-script hash). Without it the boot splash always
// painted the light sky canvas first and dark-theme users saw a bright flash
// before src/lib/theme.ts applied their choice. Mirrors THEME_KEY / parseTheme.
try {
  if (localStorage.getItem('maia:theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark')
  }
} catch (e) {
  /* storage blocked: the light default stands, as in theme.ts */
}
