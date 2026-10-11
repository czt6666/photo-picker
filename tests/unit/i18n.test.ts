import { afterEach, describe, expect, it } from 'vitest';
import { detectLang, format, t, useLang } from '../../src/i18n';

afterEach(() => useLang('zh'));

describe('detectLang', () => {
  it('中文系统用中文，其它用英文', () => {
    expect(detectLang('zh-CN')).toBe('zh');
    expect(detectLang('zh-Hant-TW')).toBe('zh');
    expect(detectLang('en-US')).toBe('en');
    expect(detectLang('ja')).toBe('en');
    expect(detectLang(undefined)).toBe('en');
  });
});

describe('format', () => {
  it('替换变量，没给的变量原样留着', () => {
    expect(format('{a} / {b}', { a: 1, b: 'x' })).toBe('1 / x');
    expect(format('{a} {missing}', { a: 1 })).toBe('1 {missing}');
  });
  it('{s:n}：英文复数，1 不加 s', () => {
    expect(format('{n} photo{s:n}', { n: 1 })).toBe('1 photo');
    expect(format('{n} photo{s:n}', { n: 0 })).toBe('0 photos');
    expect(format('{n} photo{s:n}', { n: 12 })).toBe('12 photos');
  });
});

describe('t', () => {
  it('按当前语言取文案', () => {
    useLang('zh');
    expect(t('status.count', { n: 3 })).toBe('3 张照片');
    expect(t('ex.resDone', { n: 3 }) + t('ex.resFiles', { n: 4 })).toBe('已导出 <b>3</b> 张（4 个文件）');
    useLang('en');
    expect(t('status.count', { n: 3 })).toBe('3 photos');
    expect(t('wd.found', { albums: 1, photos: 1 })).toBe('1 album, 1 photo');
  });
});
