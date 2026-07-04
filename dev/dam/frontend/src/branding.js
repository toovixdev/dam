// White-label branding: a customer can set their own logo + product name.
// Persisted in localStorage; components subscribe via onBrandingChange.

const NAME_KEY = 'nx-brand-name';
const LOGO_KEY = 'nx-brand-logo';
const PLACE_KEY = 'nx-brand-placement';
const EVT = 'nx-branding';
const DEFAULT_NAME = 'TooVix DAM';
const DEFAULT_PLACEMENT = 'sidebar'; // 'sidebar' | 'header' | 'both'

export function getBranding() {
  const name = localStorage.getItem(NAME_KEY) || '';
  return {
    name: name || DEFAULT_NAME,
    custom: !!name,
    logo: localStorage.getItem(LOGO_KEY) || '',
    placement: localStorage.getItem(PLACE_KEY) || DEFAULT_PLACEMENT,
  };
}

export function setBranding({ name, logo, placement }) {
  if (name !== undefined) {
    if (name) localStorage.setItem(NAME_KEY, name);
    else localStorage.removeItem(NAME_KEY);
  }
  if (logo !== undefined) {
    if (logo) localStorage.setItem(LOGO_KEY, logo);
    else localStorage.removeItem(LOGO_KEY);
  }
  if (placement !== undefined) {
    if (placement && placement !== DEFAULT_PLACEMENT) localStorage.setItem(PLACE_KEY, placement);
    else localStorage.removeItem(PLACE_KEY);
  }
  window.dispatchEvent(new Event(EVT));
}

export function resetBranding() {
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem(LOGO_KEY);
  localStorage.removeItem(PLACE_KEY);
  window.dispatchEvent(new Event(EVT));
}

export function onBrandingChange(cb) {
  window.addEventListener(EVT, cb);
  return () => window.removeEventListener(EVT, cb);
}

export const DEFAULT_BRAND_NAME = DEFAULT_NAME;
