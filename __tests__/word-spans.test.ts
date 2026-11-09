import { createKernel } from '../src/core/kernel';

describe('wordSpans', () => {
  it('wordSpans splits on exactly the code units that /\\s/ matches', () => {
    const k = createKernel();
    const spans: number[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      const text = `ab${ch}cd${ch}${ch}e`;
      const expected = Array.from(text.matchAll(/\S+/g), (m) => [m.index, m.index + m[0].length]).flat();
      spans.length = 0;
      k.wordSpans(text, spans);
      // A text that is a single word appends nothing (that word is the value itself).
      const single = expected.length === 2 && expected[0] === 0 && expected[1] === text.length;
      expect(spans).toEqual(single ? [] : expected);
    }
  });
});
