import { describe, expect, it } from 'test-anywhere';
import {
  createSolidPng,
  crc32,
  decodePng,
  isPng,
} from '../src/hive-control-center/scripts/mtproxy/solid-photo.mjs';

describe('solid photo round trip', () => {
  it('encodes and decodes an exact solid color', () => {
    const color = [17, 34, 51];
    const png = createSolidPng(32, color);
    expect(isPng(png)).toBe(true);
    expect(decodePng(png)).toEqual({ width: 32, height: 32, color });
  });

  it('detects corrupt or unsupported input', () => {
    expect(() => createSolidPng(0, [1, 2, 3])).toThrow('invalid photo size');
    expect(() => createSolidPng(8, [1, 2])).toThrow('photo color');
    expect(() => decodePng(Buffer.from('not a png'))).toThrow('not a PNG');
  });

  it('uses the standard PNG CRC', () => {
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082);
  });
});
