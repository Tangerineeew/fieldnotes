import DOMPurify from 'dompurify';
import { marked } from 'marked';

export type ImageSources = Record<string, string>;
export type ReferenceLinks = Record<string, { id: string; title: string }>;

const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
const PLACEHOLDER_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
// An image source that failed to resolve maps to this prefix plus a readable reason instead of a data URL.
export const IMAGE_ERROR = 'error:';
const REFERENCE_PATTERN = /\[\[([^\]]+)\]\]/g;
const SAFE_URI_REGEXP = /^(?:https?:\/\/|mailto:|fieldnotes:\/\/note\/[0-9a-f-]{36}|\/|#|data:image\/(?:gif|jpeg|png|webp|avif);base64,)/i;

export function imageSourcesInMarkdown(source: string): string[] {
  const sources = new Set<string>();
  for (const match of source.matchAll(IMAGE_PATTERN)) sources.add(match[2]);
  return [...sources];
}

export function referenceSourcesInMarkdown(source: string): string[] {
  const sources = new Set<string>();
  for (const match of source.matchAll(REFERENCE_PATTERN)) sources.add(match[1].trim());
  return [...sources];
}

function materializeReferences(source: string, references: ReferenceLinks): string {
  return source.replace(REFERENCE_PATTERN, (match, reference: string) => {
    const link = references[reference.trim()];
    return link ? `[${link.title}](fieldnotes://note/${link.id})` : match;
  });
}

function materializeImages(source: string, imageSources: ImageSources): string {
  return source.replace(IMAGE_PATTERN, (_match, alt: string, src: string) => {
    const rendered = imageSources[src] || PLACEHOLDER_IMAGE;
    if (rendered.startsWith(IMAGE_ERROR)) return `*⚠ ${alt || 'image'} · ${rendered.slice(IMAGE_ERROR.length)}*`;
    return `![${alt}](${rendered} "fieldnotes-source:${encodeURIComponent(src)}")`;
  });
}

export function renderMarkdown(source: string, imageSources: ImageSources = {}, references: ReferenceLinks = {}): string {
  const markdown = source.replace(/<img\b[^>]*>/gi, '');
  return DOMPurify.sanitize(marked.parse(materializeImages(materializeReferences(markdown, references), imageSources), { async: false }), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
      'blockquote', 'pre', 'code', 'hr', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt'],
    ALLOWED_URI_REGEXP: SAFE_URI_REGEXP,
  });
}

// Mounts sanitized Markdown without innerHTML, so the rendered fragment never runs inline handlers.
export function renderMarkdownInto(element: HTMLElement, source: string, imageSources: ImageSources = {}, references: ReferenceLinks = {}) {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  element.replaceChildren(range.createContextualFragment(renderMarkdown(source, imageSources, references)));
}
