import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';

const MOJIBAKE_MARKERS = [
  'Ã­', // Ã­ (mojibake for í = í)
  'Ã³', // Ã³ (mojibake for ó = ó)
  'Ã©', // Ã© (mojibake for é = é)
  'Ã¡', // Ã¡ (mojibake for á = á)
  'Ãº', // Ãº (mojibake for ú = ú)
  'Ã±', // Ã± (mojibake for ñ = ñ)
  'Ã',       // Ã alone (Ã prefix)
];

function hasMojibake(text) {
  return MOJIBAKE_MARKERS.some((m) => text.includes(m));
}

function decodeBuffer(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!hasMojibake(utf8)) return utf8;
  // Recuperación de mojibake: la cadena utf8 actual tiene chars en rango Latin-1.
  // Re-encodearla como Latin-1 (un byte por char) restaura los bytes UTF-8 originales,
  // que al decodificarse como UTF-8 dan el texto correcto.
  return iconv.encode(utf8, 'latin1').toString('utf8');
}

export function parseCsvBuffer(buffer) {
  const text = decodeBuffer(buffer);
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}
