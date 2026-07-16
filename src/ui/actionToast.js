// Small transient "you did an action" toast — top-right, auto-dismisses. One
// singleton element shared by the whole app so any view can call showActionToast()
// without wiring up its own copy (previously duplicated per-view — see git history).
let _el       = null;
let _hideTimer = null;

function _ensureEl() {
  if (_el) return _el;
  _el = document.createElement('div');
  _el.className = 'info-toast';
  document.body.appendChild(_el);
  return _el;
}

export function showActionToast(msg) {
  const el = _ensureEl();
  clearTimeout(_hideTimer);
  el.innerHTML = `<span class="info-toast-icon">⚡</span>${msg}`;
  el.classList.add('visible');
  _hideTimer = setTimeout(() => { el.classList.remove('visible'); }, 2600);
}
