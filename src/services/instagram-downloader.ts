import { mkdir, mkdtemp, open, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';

export class InstagramDownloadError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'InstagramDownloadError';
  }
}
export interface InstagramDownload {
  path: string;
  supportsStreaming: boolean;
  cleanup: () => Promise<void>;
}
export type InstagramDownloader = (url: string, signal?: AbortSignal) => Promise<InstagramDownload>;
type JsonObject = Record<string, unknown>;
const fail = (code: string, message: string): never => { throw new InstagramDownloadError(code, message); };
const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const instagramHost = (host: string) => host === 'instagram.com' || host === 'www.instagram.com';
const mediaHost = (host: string) => host.endsWith('.cdninstagram.com') || host.endsWith('.fbcdn.net');

function approvedUrl(raw: string, media: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return fail('unsafe_url', 'Instagram returned an invalid media address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(media ? mediaHost(url.hostname) : instagramHost(url.hostname))) {
    return fail('unsafe_url', 'Instagram returned an unsupported media address.');
  }
  return url;
}

async function boundedBody(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return fail('invalid_response', 'Instagram returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) return fail('response_too_large', 'Instagram extraction response exceeds the size limit.');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function resolvePayload(payload: unknown, shortcode: string): { url: string; requiresAudio: boolean } | undefined {
  // Only select an object carrying the requested shortcode, never an arbitrary URL in a page.
  const pending = [payload];
  let visited = 0;
  while (pending.length && visited++ < 100_000) {
    const current = pending.pop();
    if (Array.isArray(current)) { for (const child of current) pending.push(child); continue; }
    if (!object(current)) continue;
    if (current.shortcode === shortcode || current.code === shortcode) {
      if (current.is_video === false) return fail('unsupported_media', 'The Instagram post is not a video.');
      let url = typeof current.video_url === 'string' ? current.video_url : undefined;
      if (!url && Array.isArray(current.video_versions)) {
        const versions = current.video_versions.filter((entry): entry is JsonObject => object(entry) && typeof entry.url === 'string');
        versions.sort((a, b) => Number(b.width ?? 0) - Number(a.width ?? 0));
        url = versions[0]?.url as string | undefined;
      }
      if (url) return { url, requiresAudio: current.has_audio !== false };
    }
    for (const value of Object.values(current)) if (object(value) || Array.isArray(value)) pending.push(value);
  }
  return undefined;
}

function extract(text: string, shortcode: string): { url: string; requiresAudio: boolean } | undefined {
  try { const media = resolvePayload(JSON.parse(text), shortcode); if (media) return media; } catch (error) { if (error instanceof InstagramDownloadError) throw error; }
  // Instagram hydration scripts are JSON, not JavaScript. Never evaluate script content.
  const scripts = text.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const script of scripts) {
    try { const media = resolvePayload(JSON.parse(script[1]!), shortcode); if (media) return media; } catch (error) { if (error instanceof InstagramDownloadError) throw error; }
  }
  return undefined;
}

interface Box { type: string; start: number; data: number; end: number }
function boxes(bytes: Buffer, start: number, end: number): Box[] {
  const result: Box[] = [];
  while (start < end) {
    if (result.length >= 100_000) return fail('invalid_media', 'The MP4 contains too many boxes.');
    if (end - start < 8) return fail('invalid_media', 'The downloaded MP4 is truncated.');
    let length = bytes.readUInt32BE(start);
    const type = bytes.toString('latin1', start + 4, start + 8);
    let header = 8;
    if (length === 1) {
      if (end - start < 16) return fail('invalid_media', 'The downloaded MP4 is truncated.');
      const large = bytes.readBigUInt64BE(start + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return fail('invalid_media', 'The downloaded MP4 contains an invalid box.');
      length = Number(large); header = 16;
    }
    if (length === 0) length = end - start;
    if (length < header || start + length > end) return fail('invalid_media', 'The downloaded MP4 contains an invalid box.');
    result.push({ type, start, data: start + header, end: start + length });
    start += length;
  }
  return result;
}

function inspectMp4(bytes: Buffer, requiresAudio: boolean): boolean {
  const invalid = (): never => fail('invalid_media', 'The downloaded MP4 has invalid container or sample tables.');
  const children = (box: Box): Box[] => boxes(bytes, box.data, box.end);
  const one = (list: Box[], type: string): Box => {
    const matching = list.filter(box => box.type === type);
    if (matching.length !== 1) return invalid();
    return matching[0]!;
  };
  const minimum = (box: Box, length: number): void => { if (box.end - box.data < length) invalid(); };
  const fullBox = (box: Box, length: number): void => {
    minimum(box, length);
    if (bytes.readUInt32BE(box.data) !== 0) invalid();
  };
  // Metadata can also sit beside codec configuration inside sample entries.
  const parents: Record<string, string> = { moov: 'root', trak: 'moov', mdia: 'trak', minf: 'mdia', stbl: 'minf', stsd: 'stbl', avc1: 'stsd', mp4a: 'stsd' };
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);
  const scan = (list: Box[], parent: string, depth = 0): void => {
    if (depth > 12) invalid();
    for (const box of list) {
      if (box.type.startsWith('©') || ['udta', 'meta', 'uuid', 'ilst', 'ID32', 'data', 'desc', 'ldes', 'cprt'].includes(box.type)) {
        fail('embedded_metadata', 'The video contains embedded metadata; upload a clean video manually.');
      }
      if (['moof', 'mvex', 'traf', 'mfra'].includes(box.type)) invalid();
      if (parents[box.type] !== undefined && parents[box.type] !== parent) invalid();
      if (containers.has(box.type)) scan(children(box), box.type, depth + 1);
      else if (box.type === 'stsd') {
        fullBox(box, 8);
        const entries = boxes(bytes, box.data + 8, box.end);
        if (entries.length !== bytes.readUInt32BE(box.data + 4) || entries.length !== 1) invalid();
        scan(entries, 'stsd', depth + 1);
      } else if (box.type === 'avc1' || box.type === 'mp4a') {
        const header = box.type === 'avc1' ? 78 : 28;
        minimum(box, header);
        scan(boxes(bytes, box.data + header, box.end), box.type, depth + 1);
      }
    }
  };
  const top = boxes(bytes, 0, bytes.length);
  scan(top, 'root');
  const moov = one(top, 'moov');
  const ftyp = one(top, 'ftyp');
  minimum(ftyp, 8);
  const brands: string[] = [bytes.toString('latin1', ftyp.data, ftyp.data + 4)];
  if ((ftyp.end - ftyp.data) % 4 !== 0) invalid();
  for (let offset = ftyp.data + 8; offset < ftyp.end; offset += 4) brands.push(bytes.toString('latin1', offset, offset + 4));
  if (!brands.some(brand => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand))) invalid();
  const mdats = top.filter(box => box.type === 'mdat' && box.end > box.data);
  if (mdats.length === 0) invalid();
  const movieChildren = children(moov);
  const mvhd = one(movieChildren, 'mvhd');
  minimum(mvhd, 100);
  if (bytes[mvhd.data] !== 0 && bytes[mvhd.data] !== 1) invalid();
  minimum(mvhd, bytes[mvhd.data] === 1 ? 112 : 100);
  if (!bytes.readUInt32BE(mvhd.data + (bytes[mvhd.data] === 1 ? 20 : 12))) invalid();
  const tracks = movieChildren.filter(box => box.type === 'trak');
  if (tracks.length < 1 || tracks.length > 2) return fail('unsupported_tracks', 'The video has missing or unsupported audio/video tracks.');
  let video = 0; let audio = 0;
  const ranges: { start: number; end: number }[] = [];
  const trackIds = new Set<number>();
  for (const track of tracks) {
    const trackChildren = children(track);
    const tkhd = one(trackChildren, 'tkhd');
    minimum(tkhd, 84);
    const version = bytes[tkhd.data];
    if (version !== 0 && version !== 1) invalid();
    const extra = version === 1 ? 12 : 0;
    minimum(tkhd, 84 + extra);
    const id = bytes.readUInt32BE(tkhd.data + (version === 1 ? 20 : 12));
    if (id === 0 || trackIds.has(id)) invalid();
    trackIds.add(id);
    const mdia = children(one(trackChildren, 'mdia'));
    const mdhd = one(mdia, 'mdhd');
    minimum(mdhd, 24);
    if (bytes[mdhd.data] !== 0 && bytes[mdhd.data] !== 1) invalid();
    minimum(mdhd, bytes[mdhd.data] === 1 ? 36 : 24);
    if (!bytes.readUInt32BE(mdhd.data + (bytes[mdhd.data] === 1 ? 20 : 12))) invalid();
    const hdlr = one(mdia, 'hdlr');
    fullBox(hdlr, 24);
    const handler = bytes.toString('latin1', hdlr.data + 8, hdlr.data + 12);
    if (handler !== 'vide' && handler !== 'soun') return fail('unsupported_tracks', 'The MP4 has unsupported tracks.');
    const minf = children(one(mdia, 'minf'));
    minimum(one(minf, handler === 'vide' ? 'vmhd' : 'smhd'), handler === 'vide' ? 12 : 8);
    const dref = one(children(one(minf, 'dinf')), 'dref');
    fullBox(dref, 8);
    const references = boxes(bytes, dref.data + 8, dref.end);
    if (bytes.readUInt32BE(dref.data + 4) !== 1 || references.length !== 1 || references[0]!.type !== 'url ' || references[0]!.end - references[0]!.data !== 4 || bytes.readUInt32BE(references[0]!.data) !== 1) invalid();
    const table = children(one(minf, 'stbl'));
    const stsd = one(table, 'stsd');
    const sample = boxes(bytes, stsd.data + 8, stsd.end)[0]!;
    if (handler === 'vide' && sample.type === 'avc1') {
      const width = bytes.readUInt16BE(sample.data + 24);
      const height = bytes.readUInt16BE(sample.data + 26);
      if (!width || !height || width > 16384 || height > 16384 || bytes.readUInt16BE(sample.data + 6) !== 1) invalid();
      if (bytes.readUInt32BE(tkhd.data + 76 + extra) === 0 || bytes.readUInt32BE(tkhd.data + 80 + extra) === 0) invalid();
      const configs = boxes(bytes, sample.data + 78, sample.end);
      const avc = one(configs, 'avcC');
      if (!validAvcConfig(bytes.subarray(avc.data, avc.end))) invalid();
      video++;
    } else if (handler === 'soun' && sample.type === 'mp4a') {
      if (bytes.readUInt16BE(sample.data + 6) !== 1 || bytes.readUInt16BE(sample.data + 8) !== 0 || !bytes.readUInt16BE(sample.data + 16) || bytes.readUInt16BE(sample.data + 16) > 8 || !bytes.readUInt32BE(sample.data + 24)) invalid();
      const configs = boxes(bytes, sample.data + 28, sample.end);
      const esds = one(configs, 'esds');
      fullBox(esds, 4);
      if (!aacDescriptor(bytes.subarray(esds.data + 4, esds.end))) return fail('unsupported_codec', 'The MP4 audio codec is not supported AAC.');
      audio++;
    } else return fail('unsupported_codec', 'The video requires conversion; upload an H.264/AAC MP4 manually.');

    const stsz = one(table, 'stsz');
    fullBox(stsz, 12);
    const fixedSize = bytes.readUInt32BE(stsz.data + 4);
    const sampleCount = bytes.readUInt32BE(stsz.data + 8);
    if (!sampleCount || sampleCount > 2_000_000 || stsz.end - stsz.data !== 12 + (fixedSize ? 0 : sampleCount * 4)) invalid();
    const sampleSize = (index: number): number => fixedSize || bytes.readUInt32BE(stsz.data + 12 + index * 4);
    const stts = one(table, 'stts');
    fullBox(stts, 8);
    const timeCount = bytes.readUInt32BE(stts.data + 4);
    if (!timeCount || stts.end - stts.data !== 8 + timeCount * 8) invalid();
    let timedSamples = 0;
    for (let i = 0; i < timeCount; i++) {
      const count = bytes.readUInt32BE(stts.data + 8 + i * 8);
      if (!count || !bytes.readUInt32BE(stts.data + 12 + i * 8)) invalid();
      timedSamples += count;
    }
    if (timedSamples !== sampleCount) invalid();
    const offsetTables = table.filter(box => box.type === 'stco' || box.type === 'co64');
    if (offsetTables.length !== 1) invalid();
    const offsets = offsetTables[0]!;
    fullBox(offsets, 8);
    const chunkCount = bytes.readUInt32BE(offsets.data + 4);
    const offsetWidth = offsets.type === 'co64' ? 8 : 4;
    if (!chunkCount || chunkCount > sampleCount || offsets.end - offsets.data !== 8 + chunkCount * offsetWidth) invalid();
    const stsc = one(table, 'stsc');
    fullBox(stsc, 8);
    const mappingCount = bytes.readUInt32BE(stsc.data + 4);
    if (!mappingCount || mappingCount > chunkCount || stsc.end - stsc.data !== 8 + mappingCount * 12) invalid();
    const mappings: { first: number; count: number }[] = [];
    for (let i = 0; i < mappingCount; i++) {
      const first = bytes.readUInt32BE(stsc.data + 8 + i * 12);
      const count = bytes.readUInt32BE(stsc.data + 12 + i * 12);
      if (first < 1 || first > chunkCount || !count || count > sampleCount || (i === 0 ? first !== 1 : first <= mappings[i - 1]!.first) || bytes.readUInt32BE(stsc.data + 16 + i * 12) !== 1) invalid();
      mappings.push({ first, count });
    }
    let sampleIndex = 0; let mappingIndex = 0;
    for (let chunk = 1; chunk <= chunkCount; chunk++) {
      if (mappingIndex + 1 < mappings.length && chunk >= mappings[mappingIndex + 1]!.first) mappingIndex++;
      const count = mappings[mappingIndex]!.count;
      if (sampleIndex + count > sampleCount) invalid();
      let length = 0;
      for (let i = 0; i < count; i++) { const size = sampleSize(sampleIndex++); if (!size) invalid(); length += size; }
      const offset = offsets.data + 8 + (chunk - 1) * offsetWidth;
      const start = offsetWidth === 8 ? Number(bytes.readBigUInt64BE(offset)) : bytes.readUInt32BE(offset);
      const end = start + length;
      if (!Number.isSafeInteger(start) || !mdats.some(box => start >= box.data && end <= box.end)) invalid();
      ranges.push({ start, end });
    }
    if (sampleIndex !== sampleCount) invalid();
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) invalid();
  if (video !== 1 || audio > 1 || requiresAudio && audio === 0) return fail('unsupported_tracks', 'The video has missing or unsupported audio/video tracks.');
  return mdats.every(box => moov.end <= box.start);
}

function validAvcConfig(bytes: Buffer): boolean {
  if (bytes.length < 7 || bytes[0] !== 1 || (bytes[4]! & 252) !== 252 || (bytes[4]! & 3) === 2 || (bytes[5]! & 224) !== 224) return false;
  let offset = 6;
  const parameterSets = (count: number, type: number): boolean => {
    if (!count) return false;
    for (let i = 0; i < count; i++) {
      if (offset + 2 > bytes.length) return false;
      const length = bytes.readUInt16BE(offset); offset += 2;
      if (length < (type === 7 ? 4 : 2) || offset + length > bytes.length || (bytes[offset]! & 31) !== type || (bytes[offset]! & 128)) return false;
      if (type === 7 && (bytes[offset + 1] !== bytes[1] || bytes[offset + 2] !== bytes[2] || bytes[offset + 3] !== bytes[3])) return false;
      offset += length;
    }
    return true;
  };
  if (!parameterSets(bytes[5]! & 31, 7) || offset >= bytes.length) return false;
  const ppsCount = bytes[offset++]!;
  if (!parameterSets(ppsCount, 8)) return false;
  if (offset === bytes.length) return true;
  if (![100, 110, 122, 144].includes(bytes[1]!) || bytes.length - offset < 4 || (bytes[offset]! & 252) !== 252 || (bytes[offset + 1]! & 248) !== 248 || (bytes[offset + 2]! & 248) !== 248) return false;
  offset += 3;
  const extensions = bytes[offset++]!;
  if (extensions && !parameterSets(extensions, 13)) return false;
  return offset === bytes.length;
}

function aacDescriptor(bytes: Buffer): boolean {
  // ES_Descriptor -> DecoderConfigDescriptor; reject malformed variable-length fields.
  const descriptor = (offset: number, tag: number): { start: number; end: number } | undefined => {
    if (bytes[offset++] !== tag) return undefined;
    let size = 0;
    for (let i = 0; i < 4; i++) {
      const value = bytes[offset++]; if (value === undefined) return undefined;
      size = size * 128 + (value & 127);
      if (!(value & 128)) return offset + size <= bytes.length ? { start: offset, end: offset + size } : undefined;
    }
    return undefined;
  };
  const es = descriptor(0, 3);
  if (!es || es.end - es.start < 3) return false;
  const flags = bytes[es.start + 2]!;
  let offset = es.start + 3;
  if (flags & 128) offset += 2;
  if (flags & 64) offset += 1 + (bytes[offset] ?? bytes.length);
  if (flags & 32) offset += 2;
  const decoder = descriptor(offset, 4);
  if (!decoder || decoder.end > es.end || decoder.end - decoder.start < 13 || bytes[decoder.start] !== 0x40) return false;
  const config = descriptor(decoder.start + 13, 5);
  if (!config || config.end > decoder.end || config.end - config.start < 2) return false;
  return [2, 5, 29].includes(bytes[config.start]! >> 3);
}

export function createInstagramDownloader(options: { directory: string; cookie?: string; fetch?: typeof fetch; timeoutMs?: number; maximumBytes?: number }): InstagramDownloader {
  const fetcher = options.fetch ?? fetch;
  const maximum = Math.min(options.maximumBytes ?? 49_000_000, 49_000_000);
  let tail: Promise<void> = Promise.resolve();
  return async (raw, externalSignal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const timer = setTimeout(abort, options.timeoutMs ?? 120_000);
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    let operationDirectory: string | undefined;
    let activeResponse: Response | undefined;
    const cleanup = async () => {
      try { if (operationDirectory) await rm(operationDirectory, { recursive: true, force: true }); }
      catch { throw new InstagramDownloadError('cleanup_failed', 'Unable to remove the temporary Instagram video.'); }
    };
    try {
      await previous;
      controller.signal.throwIfAborted();
      const canonical = approvedUrl(raw, false);
      const match = /^\/reel\/([A-Za-z0-9_-]+)\/$/.exec(canonical.pathname);
      if (!match || canonical.search || canonical.hash) return fail('invalid_url', 'Submit a canonical Instagram Reel URL.');
      const request = async (initial: URL, media: boolean): Promise<Response> => {
        let target = initial;
        for (let redirects = 0; redirects <= 3; redirects++) {
          controller.signal.throwIfAborted();
          const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', Accept: media ? 'video/mp4' : 'text/html,application/json', 'Accept-Encoding': 'identity' };
          if (!media && options.cookie) headers.Cookie = options.cookie;
          const response = await fetcher(target, { redirect: 'manual', signal: controller.signal, headers });
          activeResponse = response;
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel().catch(() => {});
            const location = response.headers.get('location');
            if (!location || redirects === 3) return fail('redirect_limit', 'Instagram returned too many redirects.');
            target = approvedUrl(new URL(location, target).href, media);
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            if (response.status === 429) {
              const retry = response.headers.get('retry-after');
              const seconds = Number(retry);
              const retryDate = retry ? Date.parse(retry) : NaN;
              const retryAfterMs = retry && Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : undefined;
              throw new InstagramDownloadError('rate_limited', 'Instagram is rate limiting downloads. Retry later.', true, retryAfterMs);
            }
            throw new InstagramDownloadError(response.status >= 500 ? 'upstream_error' : 'inaccessible', 'Instagram could not provide this Reel.', response.status >= 500);
          }
          return response;
        }
        return fail('redirect_limit', 'Instagram returned too many redirects.');
      };
      let selected: { url: string; requiresAudio: boolean } | undefined;
      for (const suffix of ['', '?__a=1&__d=dis']) {
        const response = await request(new URL(canonical.href + suffix), false);
        selected = extract(new TextDecoder().decode(await boundedBody(response, 5_000_000, controller.signal)), match[1]!);
        if (selected) break;
      }
      if (!selected) return fail('extraction_failed', 'Instagram did not expose a downloadable video. It may require login or the extractor may need updating.');
      const mediaUrl = approvedUrl(selected.url, true);
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      // Only count our cache namespace; never follow symlinks or delete another process's files.
      let cached = 0;
      for (const entry of await readdir(options.directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('instagram-')) continue;
        try { const stat = await lstat(join(options.directory, entry.name, 'video.mp4')); if (stat.isFile()) cached += stat.size; } catch { /* incomplete concurrent operation */ }
      }
      if (cached + maximum > 1_000_000_000) return fail('cache_full', 'Instagram video cache is full. Retry after temporary files are cleaned.');
      operationDirectory = await mkdtemp(join(options.directory, 'instagram-'));
      const path = join(operationDirectory, 'video.mp4');
      const response = await request(mediaUrl, true);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maximum) { await response.body?.cancel().catch(() => {}); return fail('too_large', 'The Instagram video exceeds the Telegram upload limit.'); }
      if (!response.body) return fail('invalid_media', 'Instagram returned an empty video.');
      const reader = response.body.getReader();
      let file: FileHandle | undefined;
      let count = 0;
      try {
        file = await open(path, 'wx', 0o600);
        for (;;) {
          controller.signal.throwIfAborted();
          const chunk = await reader.read(); if (chunk.done) break;
          count += chunk.value.length;
          if (count > maximum) return fail('too_large', 'The Instagram video exceeds the Telegram upload limit.');
          let written = 0;
          while (written < chunk.value.length) { const result = await file.write(chunk.value, written, chunk.value.length - written); if (!result.bytesWritten) return fail('download_failed', 'Unable to save the Instagram video.'); written += result.bytesWritten; }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file?.close().catch(() => {}); }
      controller.signal.throwIfAborted();
      const supportsStreaming = inspectMp4(await readFile(path), selected.requiresAudio);
      controller.signal.throwIfAborted();
      return { path, supportsStreaming, cleanup };
    } catch (error) {
      const failure = controller.signal.aborted
        ? new InstagramDownloadError('cancelled', 'Instagram download was cancelled or exceeded its deadline.', true)
        : error instanceof InstagramDownloadError ? error : new InstagramDownloadError('download_failed', 'Unable to download the Instagram video. Retry later.', true);
      controller.abort();
      await cleanup().catch(() => {});
      throw failure;
    } finally {
      controller.abort();
      await activeResponse?.body?.cancel().catch(() => {});
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
      release();
    }
  };
}
