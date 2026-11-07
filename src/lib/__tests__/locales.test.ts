import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { getSystemLocale, resolveSystemLocale, SUPPORTED_LOCALES } from '../locales';
import { useUiStore } from '../../stores/ui';
import { i18n } from '../../i18n';
import en from '../../i18n/en';
import zh from '../../i18n/zh';
import ja from '../../i18n/ja';
import ko from '../../i18n/ko';
import { useGerberOutline } from '../../composables/useGerberOutline';
import { useGerberStencil } from '../../composables/useGerberStencil';
import { GerberImportError, formatImportError } from '../gerber/import-error';

let pinia: ReturnType<typeof createPinia>;
let disk: Map<string, string>;
let languages: string[];
let listeners: Set<() => void>;

beforeEach(() => {
  disk = new Map(); languages = ['ja-JP', 'en-US']; listeners = new Set();
  vi.stubGlobal('navigator', { get languages() { return languages; }, get language() { return languages[0]; } });
  vi.stubGlobal('window', {
    addEventListener: (name: string, handler: () => void) => { if (name === 'languagechange') listeners.add(handler); },
    removeEventListener: (name: string, handler: () => void) => { if (name === 'languagechange') listeners.delete(handler); },
  });
  vi.stubGlobal('document', { documentElement: { lang: '', classList: { toggle: vi.fn() } } });
  vi.stubGlobal('localStorage', { getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => disk.set(key, value) });
  pinia = createPinia(); setActivePinia(pinia);
});
afterEach(() => { disposePinia(pinia); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('system language selection', () => {
  it.each([
    [['zh-CN'], 'zh'], [['zh-Hant-TW'], 'zh'], [['JA_jp'], 'ja'], [['ko-KR'], 'ko'],
    [['EN-us'], 'en'], [['de-DE', 'ko-KR', 'ja-JP'], 'ko'], [['fr-FR', 'de-DE'], 'en'], [[], 'en'],
  ] as const)('maps language preferences %j to %s', (preferred, expected) => {
    expect(resolveSystemLocale(preferred)).toBe(expected);
  });

  it('uses language when the preference list is unavailable, and English without navigator', () => {
    vi.stubGlobal('navigator', { language: 'ko-KR' });
    expect(getSystemLocale()).toBe('ko');
    vi.stubGlobal('navigator', undefined);
    expect(getSystemLocale()).toBe('en');
  });

  it('defaults to system and applies the detected language and document font language immediately', () => {
    const ui = useUiStore();
    expect(ui.locale).toBe('system');
    expect(ui.resolvedLocale).toBe('ja');
    expect(i18n.global.locale.value).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
  });

  it.each(SUPPORTED_LOCALES)('preserves the stored manual %s preference', locale => {
    disk.set('psj_locale', locale);
    const ui = useUiStore();
    expect(ui.locale).toBe(locale);
    expect(ui.resolvedLocale).toBe(locale);
    expect(i18n.global.locale.value).toBe(locale);
    expect(document.documentElement.lang).toBe(locale === 'zh' ? 'zh-Hans' : locale);
  });

  it('follows language changes while retaining the system preference', async () => {
    disk.set('psj_locale', 'system');
    const ui = useUiStore();
    languages = ['ko-KR']; listeners.forEach(handler => handler()); await nextTick();
    expect(ui.locale).toBe('system');
    expect(ui.resolvedLocale).toBe('ko');
    expect(i18n.global.locale.value).toBe('ko');
    expect(document.documentElement.lang).toBe('ko');
    expect(disk.get('psj_locale')).toBe('system');
  });

  it('honors a manual override, then detects the latest system preference when returning to automatic', async () => {
    const ui = useUiStore();
    ui.setLocale('zh'); await nextTick();
    languages = ['ko-KR']; listeners.forEach(handler => handler()); await nextTick();
    expect(ui.resolvedLocale).toBe('zh');
    expect(i18n.global.locale.value).toBe('zh');
    expect(disk.get('psj_locale')).toBe('zh');
    ui.setLocale('system'); await nextTick();
    expect(ui.resolvedLocale).toBe('ko');
    expect(disk.get('psj_locale')).toBe('system');
  });

  it('uses the system fallback for corrupt preferences', () => {
    disk.set('psj_locale', 'invalid'); languages = ['de-DE'];
    const ui = useUiStore();
    expect(ui.locale).toBe('system');
    expect(ui.resolvedLocale).toBe('en');
  });

  it('can change language with unavailable storage and removes its system listener on disposal', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    const ui = useUiStore();
    ui.setLocale('ko'); await nextTick();
    expect(i18n.global.locale.value).toBe('ko');
    expect(listeners.size).toBe(1);
    ui.$dispose();
    expect(listeners.size).toBe(0);
  });
});

function flatten(object: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(object).flatMap(([key, value]) => typeof value === 'string'
    ? [[prefix + key, value]] : Object.entries(flatten(value as Record<string, unknown>, prefix + key + '.'))));
}

describe('complete and valid UI translations', () => {
  const reference = flatten(en);
  it.each(Object.entries({ zh, en, ja, ko }))('%s covers every key and preserves interpolation', (locale, messages) => {
    const translated = flatten(messages);
    expect(Object.keys(translated).sort()).toEqual(Object.keys(reference).sort());
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    i18n.global.locale.value = locale as typeof i18n.global.locale.value;
    for (const [key, value] of Object.entries(translated)) {
      const params = (text: string) => [...text.matchAll(/\{([a-zA-Z]\w*)\}/g)].map(match => match[1]).sort();
      expect(value.trim(), key).not.toBe('');
      expect(params(value), key).toEqual(params(reference[key]));
      const named = Object.fromEntries(params(value).map(name => [name, '7']));
      expect(i18n.global.t(key, named), key).not.toBe(key);
    }
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });
});

describe('localized import errors', () => {
  it('updates existing outline and paste errors when the language changes', async () => {
    i18n.global.locale.value = 'ja';
    const outline = useGerberOutline(), stencil = useGerberStencil();
    const file = { name: 'unsupported.txt' } as File;
    await outline.processFile(file); await stencil.processFile(file);
    expect(outline.error.value).toBe(i18n.global.t('gerber.unsupportedOutline', { name: file.name }));
    expect(stencil.error.value).toBe(i18n.global.t('gerber.unsupportedPaste', { name: file.name }));
    const previous = outline.error.value;
    i18n.global.locale.value = 'ko';
    expect(outline.error.value).not.toBe(previous);
    expect(outline.error.value).toBe(i18n.global.t('gerber.unsupportedOutline', { name: file.name }));
    expect(stencil.error.value).toBe(i18n.global.t('gerber.unsupportedPaste', { name: file.name }));
    outline.reset(); stencil.reset();
    expect(outline.error.value).toBeNull(); expect(stencil.error.value).toBeNull();
  });

  it('keeps unexpected technical diagnostics and formats known error parameters', () => {
    expect(formatImportError(new Error('ZIP CRC mismatch'))).toBe('ZIP CRC mismatch');
    expect(formatImportError(null)).toBeNull();
    expect(formatImportError(new GerberImportError('gerber.invalidOutline', { name: 'board.GKO', n: 2 })))
      .toBe(i18n.global.t('gerber.invalidOutline', { name: 'board.GKO', n: 2 }));
  });
});
