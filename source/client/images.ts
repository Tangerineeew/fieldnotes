import { maxImageBytes, uploadPartChars } from '../shared/limits.json';
import type { Invoke } from './api';


export type UploadedImage = { source: string; dataUrl: string; alt: string };

const MAX_EDGE = 2560;
const KEEP_AS_IS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

const blobUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});
const encode = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));

// Re-encodes photos and screenshots to WebP (JPEG where the browser cannot encode WebP), keeping whichever is smaller.
// GIFs are kept untouched so animation survives.
async function compress(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('unsupported');
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  let encoded = await encode(canvas, 'image/webp');
  if (encoded?.type !== 'image/webp') {
    context.globalCompositeOperation = 'destination-over'; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    encoded = await encode(canvas, 'image/jpeg');
  }
  const original = KEEP_AS_IS.has(file.type) && scale === 1 ? file : null;
  return [encoded, original].filter((blob): blob is Blob => Boolean(blob)).sort((a, b) => a.size - b.size)[0] || file;
}

export async function uploadImage(invoke: Invoke, file: File): Promise<UploadedImage> {
  const blob = await compress(file);
  if (blob.size > maxImageBytes) throw new Error('too-large');
  const dataUrl = await blobUrl(blob);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  // Plugin route bodies are capped at 100 KB; parts stay a multiple of 4 so the base64 joins cleanly server-side.
  const parts = Math.ceil(base64.length / uploadPartChars);
  let uploadId: string | undefined; let source = '';
  for (let part = 0; part < parts; part += 1) {
    const result = await invoke<{ upload_id?: string; source?: string }>('/upload', { method: 'POST', body: {
      upload_id: uploadId, part, parts, data: base64.slice(part * uploadPartChars, (part + 1) * uploadPartChars) } });
    uploadId = result.upload_id; source = result.source || '';
  }
  return { source, dataUrl, alt: file.name.replace(/\.[^.]+$/, '').replace(/[[\]\n]/g, ' ').trim() || 'image' };
}

export const imageFiles = (items: FileList | null | undefined) => Array.from(items || []).filter((file) => file.type.startsWith('image/'));
