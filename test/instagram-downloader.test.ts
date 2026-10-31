import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstagramDownloader, InstagramDownloadError } from '../src/services/instagram-downloader';

const reel = 'https://www.instagram.com/reel/ABC_12/';
const cdn = 'https://scontent.cdninstagram.com/video.mp4?signature=secret';
const box = (type: string, ...parts: Uint8Array[]) => {
  const body = Buffer.concat(parts); const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8); header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};
function fixture(options: { audio?: boolean; codec?: string; metadata?: boolean; streaming?: boolean; sampleMetadata?: boolean } = {}): Buffer {
  const u32 = (...values: number[]) => { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeUInt32BE(value, index * 4)); return bytes; };
  const full = (...values: number[]) => u32(0, ...values);
  const videoSample = Buffer.from([0, 0, 0, 2, 0x65, 0x88]);
  const audioSample = Buffer.from([0x21, 0x10, 4, 0x60, 0x8c, 0x1c]);
  const sps = Buffer.from('674d001f96540a0f2e02d4040405000003000100000300320f183196', 'hex');
  const pps = Buffer.from('68ee3c80', 'hex');
  const size16 = (size: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(size); return bytes; };
  const avcC = box('avcC', Buffer.from([1, 0x4d, 0, 0x1f, 0xff, 0xe1]), size16(sps.length), sps, Buffer.from([1]), size16(pps.length), pps);
  const videoHeader = Buffer.alloc(78); videoHeader.writeUInt16BE(1, 6); videoHeader.writeUInt16BE(1280, 24); videoHeader.writeUInt16BE(720, 26);
  const audioHeader = Buffer.alloc(28); audioHeader.writeUInt16BE(1, 6); audioHeader.writeUInt16BE(2, 16); audioHeader.writeUInt16BE(16, 18); audioHeader.writeUInt32BE(44100 * 65536, 24);
  const videoEntry = box(options.codec ?? 'avc1', videoHeader, avcC, ...(options.sampleMetadata ? [box('©des', Buffer.from('private sample description'))] : []));
  const audioEntry = box('mp4a', audioHeader, box('esds', Buffer.alloc(4), Buffer.from([3, 22, 0, 1, 0, 4, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2, 0x12, 0x10])));
  const track = (sample: Buffer, handler: string, offset: number, size: number, id: number) => {
    const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(3, 0); tkhd.writeUInt32BE(id, 12); tkhd.writeUInt32BE(1280 * 65536, 76); tkhd.writeUInt32BE(720 * 65536, 80);
    const hdlr = Buffer.alloc(24); hdlr.write(handler, 8);
    const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(handler === 'vide' ? 90000 : 44100, 12); mdhd.writeUInt32BE(handler === 'vide' ? 3000 : 1024, 16);
    const dinf = box('dinf', box('dref', full(1), box('url ', u32(1))));
    const mediaHeader = handler === 'vide' ? box('vmhd', u32(1, 0, 0)) : box('smhd', u32(0, 0));
    const table = box('stbl', box('stsd', full(1), sample), box('stts', full(1, 1, handler === 'vide' ? 3000 : 1024)), box('stsc', full(1, 1, 1, 1)), box('stsz', full(0, 1, size)), box('stco', full(1, offset)));
    return box('trak', box('tkhd', tkhd), box('mdia', box('mdhd', mdhd), box('hdlr', hdlr), box('minf', mediaHeader, dinf, table)));
  };
  const withAudio = options.audio !== false;
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(34, 16);
  const makeMoov = (offset: number) => box('moov', box('mvhd', mvhd), track(videoEntry, 'vide', offset, videoSample.length, 1), ...(withAudio ? [track(audioEntry, 'soun', offset + videoSample.length, audioSample.length, 2)] : []), ...(options.metadata ? [box('udta', box('©des', Buffer.from('private description')))] : []));
  const ftyp = box('ftyp', Buffer.from('isom'), u32(0), Buffer.from('isomavc1'));
  const mdat = box('mdat', videoSample, ...(withAudio ? [audioSample] : []));
  const moov = makeMoov(ftyp.length + (options.streaming === false ? 0 : makeMoov(0).length) + 8);
  return Buffer.concat([ftyp, ...(options.streaming === false ? [mdat, moov] : [moov, mdat])]);
}

async function setup(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'reel-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function responder(media: Buffer, payload: unknown = { graphql: { shortcode_media: { shortcode: 'ABC_12', video_url: cdn } } }): typeof fetch {
  return (async (input: string | URL | Request) => String(input).includes('cdninstagram') ? new Response(Uint8Array.from(media)) : Response.json(payload)) as unknown as typeof fetch;
}
async function errorCode(operation: Promise<unknown>, code: string) {
  try { await operation; throw new Error('expected failure'); } catch (error) { expect(error).toBeInstanceOf(InstagramDownloadError); expect((error as InstagramDownloadError).code).toBe(code); expect(String(error)).not.toContain('signature=secret'); }
}

describe('native Instagram downloader', () => {
  test('selects exact shortcode, downloads privately, validates layout, and cleans up idempotently', () => setup(async directory => {
    const media = fixture();
    const download = createInstagramDownloader({ directory, fetch: responder(media, { other: { shortcode: 'other', video_url: 'https://evil.example/x' }, target: { shortcode: 'ABC_12', video_url: cdn, edge_media_to_caption: { text: 'do not preserve this' } } }) });
    const output = await download(reel);
    expect(output.supportsStreaming).toBe(true);
    expect(Array.from(await readFile(output.path))).toEqual(Array.from(media));
    expect(Object.keys(output).sort()).toEqual(['cleanup', 'path', 'supportsStreaming']);
    await output.cleanup(); await output.cleanup();
    expect(await readdir(directory)).toEqual([]);
  }));
  test('supports JSON hydration scripts and video_versions, without sending cookies to CDN', () => setup(async directory => {
    const requests: { url: string; cookie: string | null }[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); requests.push({ url, cookie: new Headers(init?.headers).get('cookie') });
      if (url.includes('cdninstagram')) return new Response(Uint8Array.from(fixture({ audio: true, streaming: false })));
      return new Response(`<script type="application/json">${JSON.stringify({ data: { code: 'ABC_12', has_audio: true, video_versions: [{ url: cdn, width: 100 }] } })}</script>`);
    }) as unknown as typeof fetch;
    const output = await createInstagramDownloader({ directory, cookie: 'sessionid=secret', fetch: fake })(reel);
    expect(output.supportsStreaming).toBe(false);
    expect(requests.map(entry => entry.cookie)).toEqual(['sessionid=secret', null]);
    await output.cleanup();
  }));
  test('falls back once to bounded JSON extraction and rejects unrelated media', () => setup(async directory => {
    const requests: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json({ shortcode: 'other', video_url: cdn });
    }) as unknown as typeof fetch;
    await errorCode(createInstagramDownloader({ directory, fetch: fake })(reel), 'extraction_failed');
    expect(requests).toEqual([reel, `${reel}?__a=1&__d=dis`]);
  }));
  test.each([
    ['unsupported_codec', { codec: 'hvc1' }], ['embedded_metadata', { metadata: true }],
  ] as const)('rejects %s and removes partial cache', (code, options) => setup(async directory => {
    await errorCode(createInstagramDownloader({ directory, fetch: responder(fixture(options)) })(reel), code);
    expect(await readdir(directory)).toEqual([]);
  }));
  test('rejects known audio omissions but permits genuinely silent media', () => setup(async directory => {
    await errorCode(createInstagramDownloader({ directory, fetch: responder(fixture({ audio: false }), { shortcode: 'ABC_12', has_audio: true, video_url: cdn }) })(reel), 'unsupported_tracks');
    const output = await createInstagramDownloader({ directory, fetch: responder(fixture({ audio: false }), { shortcode: 'ABC_12', has_audio: false, video_url: cdn }) })(reel); await output.cleanup();
  }));
  test('rejects corrupt MP4 and non-video responses', () => setup(async directory => {
    await errorCode(createInstagramDownloader({ directory, fetch: responder(Buffer.from('not an mp4')) })(reel), 'invalid_media');
    await errorCode(createInstagramDownloader({ directory, fetch: responder(fixture(), { shortcode: 'ABC_12', is_video: false, video_url: cdn }) })(reel), 'unsupported_media');
  }));
  test.each(['http://127.0.0.1/video', 'https://cdninstagram.com.evil.example/video', 'https://evil.example/video', 'https://user:pass@s.cdninstagram.com/video', 'https://s.cdninstagram.com:444/video'])('rejects unsafe media address %s', url => setup(async directory => {
    await errorCode(createInstagramDownloader({ directory, fetch: responder(fixture(), { shortcode: 'ABC_12', video_url: url }) })(reel), 'unsafe_url');
  }));
  test('validates every redirect before requesting it', () => setup(async directory => {
    let count = 0;
    const fake = (async () => { count++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } }); }) as unknown as typeof fetch;
    await errorCode(createInstagramDownloader({ directory, fetch: fake })(reel), 'unsafe_url');
    expect(count).toBe(1);
  }));
  test('bounds redirects', () => setup(async directory => {
    let count = 0;
    const fake = (async () => { count++; return new Response(null, { status: 302, headers: { location: reel } }); }) as unknown as typeof fetch;
    await errorCode(createInstagramDownloader({ directory, fetch: fake })(reel), 'redirect_limit');
    expect(count).toBe(4);
  }));
  test('enforces streaming byte cap with false or missing Content-Length', () => setup(async directory => {
    for (const length of [undefined, '1', '9999']) {
      const fake = (async (input: string | URL | Request) => String(input).includes('cdninstagram') ? new Response(Uint8Array.from(fixture()), { headers: length ? { 'content-length': length } : {} }) : Response.json({ shortcode: 'ABC_12', video_url: cdn })) as unknown as typeof fetch;
      await errorCode(createInstagramDownloader({ directory, fetch: fake, maximumBytes: 50 })(reel), 'too_large');
      expect(await readdir(directory)).toEqual([]);
    }
  }));
  test('bounds extraction bodies', () => setup(async directory => {
    const fake = (async () => new Response('x'.repeat(5_000_001))) as unknown as typeof fetch;
    await errorCode(createInstagramDownloader({ directory, fetch: fake })(reel), 'response_too_large');
  }));
  test('sanitizes network exceptions and classifies throttling separately', () => setup(async directory => {
    const network = (async () => { throw new Error(cdn); }) as unknown as typeof fetch;
    await errorCode(createInstagramDownloader({ directory, fetch: network })(reel), 'download_failed');
    const limited = (async () => new Response(null, { status: 429, headers: { 'retry-after': '90' } })) as unknown as typeof fetch;
    try { await createInstagramDownloader({ directory, fetch: limited })(reel); } catch (error) { expect((error as InstagramDownloadError).retryable).toBe(true); expect((error as InstagramDownloadError).retryAfterMs).toBe(90_000); }
  }));
  test('cancels an active network request and handles already aborted callers', () => setup(async directory => {
    const fake = (async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('secret transport error')), { once: true }); })) as unknown as typeof fetch;
    await errorCode(createInstagramDownloader({ directory, fetch: fake, timeoutMs: 5 })(reel), 'cancelled');
    const controller = new AbortController(); controller.abort();
    await errorCode(createInstagramDownloader({ directory, fetch: fake })(reel, controller.signal), 'cancelled');
  }));
  test('rejects noncanonical input before contacting the network', () => setup(async directory => {
    let called = false;
    const fake = (async () => { called = true; return new Response(); }) as unknown as typeof fetch;
    await errorCode(createInstagramDownloader({ directory, fetch: fake })('https://www.instagram.com/reel/ABC_12/?tracking=x'), 'invalid_url');
    expect(called).toBe(false);
  }));
  test('does not exceed the aggregate cache budget', () => setup(async directory => {
    const existing = join(directory, 'instagram-other-operation');
    await mkdir(existing);
    const file = await open(join(existing, 'video.mp4'), 'w');
    await file.truncate(999_000_000); await file.close();
    await errorCode(createInstagramDownloader({ directory, fetch: responder(fixture()) })(reel), 'cache_full');
    expect(await readdir(directory)).toEqual(['instagram-other-operation']);
  }));
  test('rejects missing and invalid AAC configuration', () => setup(async directory => {
    const media = fixture({ audio: true });
    const config = media.indexOf(Buffer.from([5, 2, 0x12, 0x10]));
    expect(config).toBeGreaterThan(0);
    media[config + 2] = 0xf8;
    await errorCode(createInstagramDownloader({ directory, fetch: responder(media) })(reel), 'unsupported_codec');
  }));
  test('rejects truncated files and metadata in otherwise valid video', () => setup(async directory => {
    const media = fixture();
    for (const broken of [media.subarray(0, media.length - 1), Buffer.concat([media, box('meta', Buffer.alloc(4))])]) {
      await errorCode(createInstagramDownloader({ directory, fetch: responder(broken) })(reel), broken.length < media.length ? 'invalid_media' : 'embedded_metadata');
    }
  }));
  test('classifies upstream availability and retryable server failures', () => setup(async directory => {
    for (const status of [404, 503]) {
      const fake = (async () => new Response(null, { status })) as unknown as typeof fetch;
      await errorCode(createInstagramDownloader({ directory, fetch: fake })(reel), status === 404 ? 'inaccessible' : 'upstream_error');
    }
  }));
  test('handles malformed hydration JSON without persisting descriptions', () => setup(async directory => {
    let extractionCalls = 0;
    const fake = (async (input: string | URL | Request) => {
      if (String(input).includes('cdninstagram')) return new Response(Uint8Array.from(fixture()));
      extractionCalls++;
      return extractionCalls === 1 ? new Response('<script type="application/json">invalid</script>') : Response.json({ shortcode: 'ABC_12', video_url: cdn, caption: 'private description' });
    }) as unknown as typeof fetch;
    const result = await createInstagramDownloader({ directory, fetch: fake })(reel);
    expect(extractionCalls).toBe(2);
    expect(await readdir(join(result.path, '..'))).toEqual(['video.mp4']);
    await result.cleanup();
  }));

  test('requires an audio track when the source audio status is unknown', () => setup(async directory => {
    await errorCode(createInstagramDownloader({ directory, fetch: responder(fixture({ audio: false })) })(reel), 'unsupported_tracks');
  }));
  test('rejects metadata beside AVC and AAC codec configuration', () => setup(async directory => {
    await errorCode(createInstagramDownloader({ directory, fetch: responder(fixture({ sampleMetadata: true })) })(reel), 'embedded_metadata');
    const audioMetadata = fixture();
    const config = audioMetadata.indexOf(Buffer.from('esds'));
    audioMetadata.write('uuid', config);
    await errorCode(createInstagramDownloader({ directory, fetch: responder(audioMetadata) })(reel), 'embedded_metadata');
  }));
  test.each(['mvhd', 'mdhd', 'hdlr', 'trak', 'stts', 'stsc', 'stsz', 'stco', 'dref', 'vmhd'])('requires structural track box %s', type => setup(async directory => {
    const malformed = fixture();
    malformed.write('free', malformed.indexOf(Buffer.from(type)));
    await errorCode(createInstagramDownloader({ directory, fetch: responder(malformed) })(reel), type === 'trak' ? 'unsupported_tracks' : 'invalid_media');
  }));
  test('rejects fake stsd at the container root', () => setup(async directory => {
    const malformed = Buffer.concat([fixture(), box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]))]);
    await errorCode(createInstagramDownloader({ directory, fetch: responder(malformed) })(reel), 'invalid_media');
  }));
  test.each(['dimensions', 'parameterSets', 'chunkOffset', 'sampleSize', 'sampleCount', 'sampleTiming', 'overlap'])('rejects malformed %s', kind => setup(async directory => {
    const malformed = fixture();
    if (kind === 'dimensions') malformed.writeUInt16BE(0, malformed.indexOf(Buffer.from('avc1'), 32) + 4 + 24);
    if (kind === 'parameterSets') malformed[malformed.indexOf(Buffer.from('avcC')) + 4 + 5] = 0xe0;
    if (kind === 'chunkOffset') malformed.writeUInt32BE(4, malformed.indexOf(Buffer.from('stco')) + 12);
    if (kind === 'sampleSize') malformed.writeUInt32BE(9999999, malformed.indexOf(Buffer.from('stsz')) + 16);
    if (kind === 'sampleCount') malformed.writeUInt32BE(2, malformed.indexOf(Buffer.from('stsz')) + 12);
    if (kind === 'sampleTiming') malformed.writeUInt32BE(2, malformed.indexOf(Buffer.from('stts')) + 12);
    if (kind === 'overlap') {
      const first = malformed.indexOf(Buffer.from('stco')); const second = malformed.indexOf(Buffer.from('stco'), first + 4);
      malformed.writeUInt32BE(malformed.readUInt32BE(first + 12), second + 12);
    }
    await errorCode(createInstagramDownloader({ directory, fetch: responder(malformed) })(reel), 'invalid_media');
  }));
  test('cancels the media body and aborts the request when opening the local file fails', () => setup(async directory => {
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).includes('cdninstagram')) return Response.json({ shortcode: 'ABC_12', video_url: cdn });
      const operation = (await readdir(directory))[0]!;
      await mkdir(join(directory, operation, 'video.mp4'));
      signal = init?.signal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    }) as unknown as typeof fetch;
    await errorCode(createInstagramDownloader({ directory, fetch: fake })(reel), 'download_failed');
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  }));

});
