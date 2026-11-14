let _navigate = null;
export function setNavigator(fn) { _navigate = fn; }
export function navigate(screen, params = {}) { _navigate?.(screen, params); }