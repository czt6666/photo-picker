import { describe, expect, it } from 'vitest';
import { parseShareInput, shareLink } from '../../src/remote';

describe('分享链接', () => {
  it('认出带路径的服务器', () => {
    expect(parseShareInput('https://czt666.cn/photo-picker/r/abcd2345EFGH6789', '')).toEqual({
      server: 'https://czt666.cn/photo-picker',
      code: 'ABCD2345EFGH6789',
    });
  });
  it('认出根路径的服务器', () => {
    expect(parseShareInput('http://localhost:8081/r/ABC234', '')).toEqual({ server: 'http://localhost:8081', code: 'ABC234' });
  });
  it('只有码时用默认服务器', () => {
    expect(parseShareInput(' ABC234 ', 'https://czt666.cn/photo-picker/')).toEqual({ server: 'https://czt666.cn/photo-picker', code: 'ABC234' });
  });
  it('拼回链接', () => {
    expect(shareLink({ server: 'https://czt666.cn/photo-picker', code: 'ABC234' })).toBe('https://czt666.cn/photo-picker/r/ABC234');
  });
});
