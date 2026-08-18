// App-level preferences (as opposed to `io.js`'s per-document persistence):
// these apply to the whole app/browser regardless of which map is open, so
// they're stored under their own localStorage key and applied as CSS custom
// properties rather than being part of the saved/exported document.

const STORAGE_KEY = 'freemindonline.settings.v1';

export const NODE_COLOR_PRESETS = [
  { value: '#ffffff', label: '흰색' },
  { value: '#f8fafc', label: '연회색' },
  { value: '#fef9c3', label: '연노랑' },
  { value: '#dcfce7', label: '연초록' },
  { value: '#dbeafe', label: '연파랑' },
  { value: '#fce7f3', label: '연분홍' },
];

// Each preset also carries a matching darker shade, used for the root
// node's border/shadow and hover states — same relationship the built-in
// default (#2563eb / #1d4ed8) already has.
export const ACCENT_COLOR_PRESETS = [
  { value: '#2563eb', dark: '#1d4ed8', label: '파랑' },
  { value: '#16a34a', dark: '#15803d', label: '초록' },
  { value: '#9333ea', dark: '#7e22ce', label: '보라' },
  { value: '#ea580c', dark: '#c2410c', label: '주황' },
  { value: '#0f172a', dark: '#020617', label: '슬레이트' },
  { value: '#e11d48', dark: '#be123c', label: '로즈' },
];

export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 20;

export const DEFAULT_SETTINGS = {
  fontSize: 14,
  nodeBg: NODE_COLOR_PRESETS[0].value,
  accent: ACCENT_COLOR_PRESETS[0].value,
  accentDark: ACCENT_COLOR_PRESETS[0].dark,
  // Whether the icon sidebar starts expanded on load. A plain UI-chrome
  // preference (like fontSize/colors above) rather than something the map
  // document itself needs to remember, so it lives here — the toolbar's
  // show/hide button changes this same value, it doesn't just toggle a
  // one-off runtime flag.
  iconSidebarVisible: true,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (e) {
    console.warn('failed to load settings', e);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('failed to save settings', e);
  }
}

// Only touches nodes/root created with the *default* color (color: null) —
// nodes with an explicit per-node color (set via the toolbar swatches)
// keep it regardless of this setting, same as FreeMind's own per-node
// override behavior.
export function applySettings(settings) {
  const root = document.documentElement;
  root.style.setProperty('--node-font-size', settings.fontSize + 'px');
  root.style.setProperty('--node-bg', settings.nodeBg);
  root.style.setProperty('--accent', settings.accent);
  root.style.setProperty('--accent-dark', settings.accentDark);
}
