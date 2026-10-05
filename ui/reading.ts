export interface ReadingPart { text: string; emphasized: boolean }

let words: Intl.Segmenter | undefined;
let graphemes: Intl.Segmenter | undefined;

// Presentation only: callers keep the original evidence for copying and inspection.
export function readingParts(value: string): ReadingPart[] {
  const plain = [{ text: value, emphasized: false }];
  if (!value || value.length > 16_384 || typeof Intl.Segmenter !== 'function') return plain;
  words ??= new Intl.Segmenter('th', { granularity: 'word' });
  graphemes ??= new Intl.Segmenter('th', { granularity: 'grapheme' });
  const parts: ReadingPart[] = [];
  for (const word of words.segment(value)) {
    if (!word.isWordLike || !/\p{L}/u.test(word.segment)) { parts.push({ text: word.segment, emphasized: false }); continue; }
    const clusters = [...graphemes.segment(word.segment)];
    let count = Math.ceil(clusters.length / 2);
    // Thai leading vowels render with the following consonant; keep them together.
    if (/^[\u0e40-\u0e44]$/u.test(clusters[count - 1]!.segment) && count < clusters.length) count++;
    const boundary = clusters[count]?.index ?? word.segment.length;
    parts.push({ text: word.segment.slice(0, boundary), emphasized: true });
    if (boundary < word.segment.length) parts.push({ text: word.segment.slice(boundary), emphasized: false });
  }
  return parts;
}
