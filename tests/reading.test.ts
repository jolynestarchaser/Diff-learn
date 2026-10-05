import assert from 'node:assert/strict';
import test from 'node:test';
import { readingParts } from '../ui/reading.js';

test('Reading emphasis preserves mixed English/Thai source, punctuation, whitespace and CRLF', () => {
  for (const source of ['English reading: original evidence.', 'เก้าอี้สำหรับตรวจหลักฐาน', '\tบริการ.java return "กำลังเปิดหลักฐานที่ตรวจแล้ว";\r\n', '<img src=x onerror=alert(1)> & 123_456', 'cafe\u0301 👩🏽‍💻 \u{10400}hello ภาษาไทย']) {
    const parts = readingParts(source);
    assert.equal(parts.map(part => part.text).join(''), source);
    assert.ok(parts.some(part => part.emphasized));
    const boundaries = new Set([...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(source)].map(part => part.index));
    boundaries.add(source.length);
    let offset = 0;
    for (const part of parts) { offset += part.text.length; assert.ok(boundaries.has(offset), 'Never separate a grapheme across emphasis spans'); }
  }
  assert.deepEqual(readingParts('Evidence'), [{ text: 'Evid', emphasized: true }, { text: 'ence', emphasized: false }]);
  assert.deepEqual(readingParts('ไทย'), [{ text: 'ไท', emphasized: true }, { text: 'ย', emphasized: false }]);
});

test('Reading keeps Thai leading vowels attached and leaves numeric/emoji-only text plain', () => {
  for (const source of ['เก้าอี้', 'ประเทศไทย', 'เก่งมาก', 'กำลัง', 'แล้ว']) {
    assert.ok(readingParts(source).some(part => part.emphasized));
    assert.ok(readingParts(source).every(part => !part.emphasized || !/[\u0e40-\u0e44]$/u.test(part.text)), 'Leading vowel must not end an emphasis span');
  }
  assert.ok(readingParts('123\t๑๒๓ 👩🏽‍💻\r\n').every(part => !part.emphasized));
});

test('Reading falls back losslessly for empty, oversized or unsupported text', () => {
  for (const source of ['', 'หลักฐาน'.repeat(3000)]) assert.deepEqual(readingParts(source), [{ text: source, emphasized: false }]);
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
  try {
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
    assert.deepEqual(readingParts('English ภาษาไทย'), [{ text: 'English ภาษาไทย', emphasized: false }]);
  } finally { Object.defineProperty(Intl, 'Segmenter', descriptor); }
});
