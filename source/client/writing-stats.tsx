import type { Translate } from './i18n';


const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Counts what a reader sees: a link `[[id|Label]]` counts as its label. As in Obsidian, each CJK character is a word, and
// any other run of letters or digits is one; characters leave out line breaks.
function writingCounts(markdown: string) {
  const text = markdown.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1');
  const words = Array.from(text.matchAll(/[\p{L}\p{N}]+/gu)).reduce((total, [run]) => {
    const cjk = Array.from(run).filter((character) => CJK.test(character)).length;
    return total + cjk + (cjk === Array.from(run).length ? 0 : run.split(CJK).filter(Boolean).length);
  }, 0);
  return { words, characters: Array.from(text.replace(/\r?\n/g, '')).length };
}

// Floats at the editor's bottom right, as Obsidian's status bar does.
export function WritingStats({ markdown, locale, t }: { markdown: string; locale?: string; t: Translate }) {
  const { words, characters } = writingCounts(markdown);
  const number = (value: number) => value.toLocaleString(locale);
  return <p className="fn-writing-stats" aria-live="off">
    <span>{t('Words: {count}', '{count} 个词', { count: number(words) })}</span>
    <span>{t('Characters: {count}', '{count} 个字符', { count: number(characters) })}</span>
  </p>;
}
