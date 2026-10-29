import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Button, RadioGroup} from '@hannasage/projection-ui/core';
import './appearance.css';
import {THEME_PRESETS} from '@hannasage/projection-ui/foundations';

/** @typedef {'bloom' | 'coast'} ThemePairId */
/** @typedef {'dark' | 'light' | 'system'} AppearanceMode */
/** @typedef {'noir-bloom' | 'confetti-studio' | 'dusk-protocol' | 'coastal-day'} ThemeId */
/** @typedef {{pair: ThemePairId, mode: AppearanceMode}} AppearancePreference */
/** @typedef {AppearancePreference & {storageError: boolean, resolvedMode: 'dark' | 'light', themeId: ThemeId, theme: (typeof THEME_PRESETS)[ThemeId]}} AppearanceSnapshot */
const storageKey = 'touchline-appearance';
/** @type {{id: ThemePairId, dark: ThemeId, light: ThemeId}[]} */
export const themePairs = [
  {id: 'bloom', dark: 'noir-bloom', light: 'confetti-studio'},
  {id: 'coast', dark: 'dusk-protocol', light: 'coastal-day'},
];
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
/** @type {Set<() => void>} */
const listeners = new Set();
let storageError = false;
/** @returns {AppearancePreference} */
function readPreference() {
  try {
    /** @type {{pair?: unknown, mode?: unknown} | null} */
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    storageError = false;
    return {
      pair: saved?.pair === 'coast' ? 'coast' : 'bloom',
      mode: saved?.mode === 'dark' || saved?.mode === 'light' ? saved.mode : 'system',
    };
  } catch { storageError = true; return {pair: 'bloom', mode: 'system'}; }
}
let preference = readPreference();
/** @type {AppearanceSnapshot} */
let snapshot;
function update() {
  const mode = preference.mode === 'system' ? (systemDark.matches ? 'dark' : 'light') : preference.mode;
  const pair = themePairs.find(pair => pair.id === preference.pair) || themePairs[0];
  const themeId = pair[mode];
  snapshot = {...preference, storageError, resolvedMode: mode, themeId, theme: THEME_PRESETS[themeId]};
  document.documentElement.style.colorScheme = mode;
  document.documentElement.dataset.theme = themeId;
  document.body.style.background = snapshot.theme.bg;
  document.body.style.color = snapshot.theme.text;
  for (const listener of listeners) listener();
}
update();
systemDark.addEventListener('change', () => { if (preference.mode === 'system') update(); });
window.addEventListener('storage', event => {
  if (event.key === storageKey || event.key === null) { preference = readPreference(); update(); }
});
/** @param {Partial<AppearancePreference>} value */
function select(value) {
  preference = {...preference, ...value};
  try { localStorage.setItem(storageKey, JSON.stringify({version: 1, ...preference})); storageError = false; }
  catch { storageError = true; }
  update();
}
/** @param {() => void} listener */
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const useAppearance = () => useSyncExternalStore(subscribe, () => snapshot);

export function ThemeSwitcher() {
  const appearance = useAppearance();
  const [open, setOpen] = useState(false);
  const container = useRef(/** @type {HTMLDivElement | null} */(null));
  const trigger = useRef(/** @type {HTMLButtonElement | null} */(null));
  const panel = useRef(/** @type {HTMLDivElement | null} */(null));
  useEffect(() => {
    if (!open) return;
    /** @type {HTMLInputElement | null | undefined} */(panel.current?.querySelector('input:checked'))?.focus();
    /** @param {PointerEvent} event */
    const outside = event => { if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false); };
    /** @param {KeyboardEvent} event */
    const escape = event => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="appearance" ref={container} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <style>{`@font-face{font-family:"Touchline Appearance Syne";font-style:normal;font-weight:400 800;font-display:swap;src:url(/assets/appearance/syne-latin-variable.woff2) format("woff2")}
@font-face{font-family:"Touchline Appearance Plex Sans";font-style:normal;font-weight:100 700;font-display:swap;src:url(/assets/appearance/ibm-plex-sans-latin-variable.woff2) format("woff2")}`}</style>
    <button ref={trigger} type="button" className="appearance-trigger" aria-label="Change theme"
      title={`Appearance: ${appearance.theme.name} (${appearance.mode})`} aria-expanded={open} aria-controls="appearance-panel"
      onClick={() => setOpen(value => !value)}>
      <svg width="20" height="20" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="4.5" cy="5.5" r="1.2" fill={appearance.theme.primary} />
        <circle cx="7" cy="4" r="1.2" fill={appearance.theme.partner} />
        <circle cx="9.5" cy="5.5" r="1.2" fill={appearance.theme.cyan} />
        <circle cx="9" cy="8.5" r="1.2" fill={appearance.theme.amber} />
        <circle cx="5" cy="8.5" r="1.2" fill={appearance.theme.mint} />
      </svg>
      <span>Theme</span><span className="theme-swatch" style={{background: appearance.theme.primary}} aria-hidden="true" />
    </button>
    {open && <div id="appearance-panel" className="appearance-panel" ref={panel} role="region" aria-label="Appearance">
      <h2>Appearance</h2>
      <RadioGroup className="theme-pairs" label="Theme pair" name="theme-pair" value={appearance.pair}
        onValueChange={value => { if (value === 'bloom' || value === 'coast') select({pair:value}); }}
        options={themePairs.map(pair => ({value:pair.id,label:<>
          <span className="theme-pair-names">{THEME_PRESETS[pair.dark].name}<small>{THEME_PRESETS[pair.light].name}</small></span>
          <span className={`theme-pair-preview ${pair.id}`} aria-hidden="true" />
        </>}))} />
      <RadioGroup className="theme-modes" label="Mode" name="theme-mode" value={appearance.mode}
        onValueChange={value => { if (value === 'dark' || value === 'light' || value === 'system') select({mode:value}); }}
        options={['dark','light','system'].map(mode => ({value:mode,label:<span>{mode[0].toUpperCase() + mode.slice(1)}</span>}))} />
      <div className="appearance-current" role="status">
        <p>{appearance.theme.name}</p>
        <p>{appearance.mode === 'system' ? `Following your device · ${appearance.resolvedMode === 'dark' ? 'Dark' : 'Light'}` : `Always ${appearance.mode}`}</p>
        <p className="appearance-note">{appearance.storageError ? 'Only for this tab. Preferences could not be saved.' : 'Saved on this device.'}</p>
      </div>
      <Button variant="secondary" size="lg" className="appearance-done" style={{color:"var(--ui-text)",transition:"none"}} onClick={() => { setOpen(false); trigger.current?.focus(); }}>Done</Button>
    </div>}
  </div>;
}
