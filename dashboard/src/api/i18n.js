/**
 * Module-level translation.
 *
 * `t()` is importable anywhere — inside a component, in a column config, in a
 * helper that has no hooks — because it reads a module-level catalogue rather
 * than React context. That matters here: this app builds table columns and
 * status labels in plain objects and module constants, and a hook-only `t`
 * could not reach any of them.
 *
 * The catalogue is loaded once by the I18n provider, which also re-renders the
 * tree on change so components pick up the new strings.
 */

let catalogue = {};
let currentLanguage = 'en';
let currentDirection = 'ltr';

/** Called by the provider when a catalogue arrives. */
export function setCatalogue({ language, direction, messages }) {
  catalogue = messages || {};
  currentLanguage = language || 'en';
  currentDirection = direction || 'ltr';
}

export const getLanguage = () => currentLanguage;
export const getDirection = () => currentDirection;

/**
 * Translate one string.
 *
 * The English source is the key, so an untranslated string renders as itself
 * rather than a missing-key placeholder — a partially-translated language
 * degrades one string at a time instead of breaking the screen.
 *
 * Frappe writes placeholders as {0}, {1}: `t('Hello {0}', [name])`.
 */
export function t(text, args) {
  if (typeof text !== 'string' || !text) return text;
  const translated = catalogue[text] ?? text;
  if (!args || args.length === 0) return translated;
  return translated.replace(/\{(\d+)\}/g, (match, index) => {
    const value = args[Number(index)];
    return value === undefined || value === null ? match : String(value);
  });
}

export default t;
