import { REFERENCE_PATTERN, headingLabel, isNoteId, splitTarget } from './markdown';
import { checklistOf, selectedOf, type Property } from './properties';
import { TREK_LINK } from './trek-objects';


const yaml = (value: string) => /^[\w\p{L}][\w\p{L} .\-/]*$/u.test(value) && !/^(true|false|\d)/i.test(value) ? value
  : JSON.stringify(value);

function frontMatter(properties: Property[]) {
  const lines = properties.flatMap((property) => {
    const name = yaml(property.name);
    if (property.type === 'select' || property.type === 'multi_select') {
      const chosen = selectedOf(property);
      const names = (property.options || []).filter((option) => chosen.includes(option.id)).map((option) => yaml(option.name));
      return names.length ? [`${name}: [${names.join(', ')}]`] : [];
    }
    if (property.type === 'checklist') {
      const items = checklistOf(property);
      return items.length ? [`${name}:`, ...items.map((item) => `  - ${yaml(`${item.done ? '[x]' : '[ ]'} ${item.text}`)}`)] : [];
    }
    if (property.type === 'last_edited' || property.value === null || property.value === '' || property.value === undefined) return [];
    return [`${name}: ${typeof property.value === 'string' ? yaml(property.value) : String(property.value)}`];
  });
  return lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
}

// A note as portable Markdown, the shape the importer reads back: properties as front matter, then the text, with links that
// point at note ids written as Obsidian links by title. `titles` holds the linked notes' current titles; a link without one keeps
// the text it shows, so a note the reader cannot open stays unnamed. Images and PDFs keep their Fieldnotes sources.
export function noteMarkdown(note: { content: string; properties?: Property[] }, titles: Record<string, string> = {}) {
  // A trip item means something only inside TREK, so it leaves as the name it was inserted with.
  const items = note.content.replace(TREK_LINK, (_match, _target: string, label?: string) => label?.trim() || '');
  const content = items.replace(REFERENCE_PATTERN, (match, target: string, label?: string) => {
    const { note: linked, heading } = splitTarget(target);
    if (!isNoteId(linked) || !label?.trim()) return match;
    // The editor stores the heading after the title for a heading link; the title alone names the note.
    const suffix = headingLabel('', heading);
    const title = titles[linked] || (heading && label.endsWith(suffix) ? label.slice(0, -suffix.length) : label.trim());
    const shown = heading ? `${title}#${heading}` : title;
    return [title, headingLabel(title, heading)].includes(label.trim()) ? `[[${shown}]]` : `[[${shown}|${label.trim()}]]`;
  });
  return `${frontMatter(note.properties || [])}${content}`;
}

// The frame may not be granted the async clipboard, so a selected, hidden field and the copy command stand in.
export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* falls back below */ }
  const field = document.createElement('textarea');
  field.value = text; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
  document.body.append(field); field.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { field.remove(); }
}
