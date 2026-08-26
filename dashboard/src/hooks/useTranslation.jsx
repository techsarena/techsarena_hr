/**
 * Translation for the dashboard.
 *
 * The catalogue is Frappe's: every language ERPNext ships is available, and the
 * same message a Python `_()` call translates on the server translates here
 * too. Nothing is defined in the client — this only looks strings up.
 *
 * `t()` is a plain lookup with the English source as the key, so an untranslated
 * string renders as English rather than a missing-key placeholder. That means a
 * partially-translated language degrades one string at a time instead of
 * breaking the screen.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import hr from '../api/hr';
import { setCatalogue, t as translate } from '../api/i18n';

const I18nContext = createContext(null);

/** Frappe writes placeholders as {0}, {1}; `t('Hello {0}', [name])` fills them. */
function interpolate(text, args) {
  if (!args || args.length === 0) return text;
  return text.replace(/\{(\d+)\}/g, (match, index) => {
    const value = args[Number(index)];
    return value === undefined || value === null ? match : String(value);
  });
}

export function I18nProvider({ children }) {
  const [state, setState] = useState({ language: 'en', direction: 'ltr', messages: {} });
  const [ready, setReady] = useState(false);

  const apply = useCallback((data) => {
    // Module catalogue first: anything imported outside React (table columns,
    // status maps) reads from there, and must not lag a render behind.
    setCatalogue(data);
    setState({
      language: data.language,
      direction: data.direction,
      messages: data.messages || {},
    });
    // Set on <html>, not a wrapper div: `dir` has to be on an ancestor of
    // everything (including portalled dialogs), and `lang` drives the browser's
    // own hyphenation and font fallback.
    const root = document.documentElement;
    root.setAttribute('lang', data.language);
    root.setAttribute('dir', data.direction);
  }, []);

  useEffect(() => {
    let live = true;
    hr.translations()
      .then((data) => { if (live) apply(data); })
      .catch(() => { /* English is the source text, so a failure is survivable */ })
      .finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [apply]);

  const setLanguage = useCallback(async (language) => {
    // Saved first so the desk and printed documents follow the same choice,
    // then the catalogue is refetched for the new language.
    await hr.setLanguage(language);
    const data = await hr.translations(language);
    apply(data);
  }, [apply]);

  // Delegates to the module function so both paths share one catalogue; the
  // dependency on `messages` is what re-renders consumers when it changes.
  const t = useCallback(
    (text, args) => translate(text, args),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.messages],
  );

  const value = useMemo(
    () => ({ t, language: state.language, direction: state.direction, isRtl: state.direction === 'rtl', setLanguage, ready }),
    [t, state.language, state.direction, setLanguage, ready],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  // Deliberately forgiving: a component rendered outside the provider (a test,
  // an error boundary) still shows English rather than throwing.
  if (!ctx) return { t: (text, args) => interpolate(text, args), language: 'en', direction: 'ltr', isRtl: false, ready: true, setLanguage: async () => {} };
  return ctx;
}
