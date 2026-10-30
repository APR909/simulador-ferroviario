const THEME_STORAGE_KEY='vialab-theme';

/** Dark by default; a user-selected light/dark theme persists when possible. */
export function initializeTheme() {
  const button=document.getElementById('themeToggle'),label=document.getElementById('themeLabel');
  if (!button || !label) return;
  const update=theme=>{
    const selected=theme==='light' ? 'light' : 'dark';
    document.documentElement.dataset.theme=selected;
    button.setAttribute('aria-pressed',String(selected==='dark'));
    button.title=selected==='dark' ? 'Cambiar al modo claro' : 'Cambiar al modo oscuro';
    label.textContent=selected==='dark' ? 'Oscuro' : 'Claro';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',selected==='dark' ? '#111d1a' : '#f5f6f1');
  };
  update(document.documentElement.dataset.theme);
  button.addEventListener('click',()=>{
    const next=document.documentElement.dataset.theme==='dark' ? 'light' : 'dark';
    update(next);
    try { localStorage.setItem(THEME_STORAGE_KEY,next); } catch (_) { /* private contexts can block storage */ }
    window.dispatchEvent(new CustomEvent('vialab:themechange',{detail:{theme:next}}));
  });
}
