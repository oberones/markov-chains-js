import { Unzip, UnzipInflate } from 'fflate';
import { inspectMidi } from './midi.js';
import { inspectMusicXml, parseXml } from './musicxml.js';
import { LIMITS } from './normalize.js';

export { LIMITS } from './normalize.js';

function decodeXml(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('MusicXML text must use UTF-8 or UTF-16 encoding.'); }
}

function unpackMxl(bytes) {
  // Check a complete, ordinary single-disk ZIP before streaming its contents.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let footer = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { footer = i; break; }
  }
  if (footer < 0) throw new Error('This MXL archive is incomplete.');
  if (view.getUint16(footer + 4, true) || view.getUint16(footer + 6, true)) throw new Error('Multi-disk MXL archives are not supported.');
  if (view.getUint16(footer + 10, true) > 1000) throw new Error('This MXL archive contains too many files.');
  const contents = new Map();
  let total = 0;
  let declaredTotal = 0;
  let count = 0;
  let pending = 0;
  let failure = null;
  const unzip = new Unzip(file => {
    if (++count > 1000) throw new Error('This MXL archive contains too many files.');
    if (contents.has(file.name)) throw new Error('This MXL archive contains duplicate file names.');
    if (file.originalSize != null) {
      declaredTotal += file.originalSize;
      if (declaredTotal > LIMITS.expandedBytes) throw new Error('MXL expanded content exceeds 20 MiB. Use a smaller score.');
      if (/\.xml$|\.musicxml$/i.test(file.name) && file.originalSize > LIMITS.xmlBytes) throw new Error('An XML document in this MXL exceeds 10 MiB. Use a smaller score.');
    }
    const chunks = [];
    let size = 0;
    pending++;
    contents.set(file.name, null);
    file.ondata = (error, data, final) => {
      if (failure) return;
      if (error) { failure = new Error('This MXL archive could not be decompressed.'); return; }
      total += data.length;
      size += data.length;
      if (total > LIMITS.expandedBytes) { failure = new Error('MXL expanded content exceeds 20 MiB. Use a smaller score.'); return; }
      if (/\.xml$|\.musicxml$/i.test(file.name) && size > LIMITS.xmlBytes) { failure = new Error('An XML document in this MXL exceeds 10 MiB. Use a smaller score.'); return; }
      chunks.push(data);
      if (final) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        contents.set(file.name, bytes);
        pending--;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    // Small compressed chunks bound each decoder expansion before our size check.
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
      if (failure) throw failure;
    }
  } catch (error) {
    if (/MXL|XML document/.test(error.message)) throw error;
    throw new Error('This MXL archive is malformed or uses unsupported compression.');
  }
  if (pending) throw new Error('This MXL archive has incomplete entries.');
  const container = contents.get('META-INF/container.xml');
  if (!container) throw new Error('This MXL is missing META-INF/container.xml.');
  const doc = parseXml(decodeXml(container));
  const rootfiles = [...doc.getElementsByTagNameNS('*', 'rootfile')];
  const rootfile = rootfiles.find(file => file.getAttribute('media-type') === 'application/vnd.recordare.musicxml+xml') || rootfiles[0];
  const path = rootfile?.getAttribute('full-path');
  const score = path ? contents.get(path) : null;
  if (!score) throw new Error('The MusicXML score named by this MXL container is missing.');
  if (score.length > LIMITS.xmlBytes) throw new Error('The MusicXML score in this MXL exceeds 10 MiB.');
  return decodeXml(score);
}

export async function inspectBytes(name, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.length) throw new Error('This file is empty.');
  if (bytes.length > LIMITS.fileBytes) throw new Error('Files must be 5 MiB or smaller. Import a shorter excerpt.');
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  if (signature === 'MThd') return inspectMidi(name, bytes);
  if (signature === 'PK\x03\x04') return inspectMusicXml(name, unpackMxl(bytes));
  if (/\.(midi?|mxl)$/i.test(name)) throw new Error('This file does not contain a valid MIDI or MXL header.');
  return inspectMusicXml(name, decodeXml(bytes));
}

export async function inspectFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Choose a MusicXML, MXL, or MIDI file.');
  if (file.size > LIMITS.fileBytes) throw new Error('Files must be 5 MiB or smaller. Import a shorter excerpt.');
  return inspectBytes(file.name || 'Untitled score', new Uint8Array(await file.arrayBuffer()));
}
