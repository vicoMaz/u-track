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
  el.classList.remove('warn');
  el.innerHTML = `<span class="info-toast-icon">⚡</span>${msg}`;
  el.classList.add('visible');
  _hideTimer = setTimeout(() => { el.classList.remove('visible'); }, 2600);
}

// Same singleton toast, styled as a warning (amber). Unlike showActionToast
// this does NOT auto-dismiss — it stays up until the caller explicitly hides
// it (e.g. the underlying problem resolved) or the user clicks Ignore, since
// this is for conditions the user needs to actually notice and act on, not a
// routine confirmation. Returns a hide() function the caller can invoke to
// dismiss it programmatically once resolved.
export function showWarningToast(msg) {
  const el = _ensureEl();
  clearTimeout(_hideTimer);
  el.classList.add('warn');
  el.innerHTML = `<span class="info-toast-icon">⚠</span><span class="info-toast-msg">${msg}</span><button type="button" class="info-toast-ignore">Ignore</button>`;
  el.classList.add('visible');
  const hide = () => { el.classList.remove('visible'); };
  el.querySelector('.info-toast-ignore').addEventListener('click', hide, { once: true });
  return hide;
}
