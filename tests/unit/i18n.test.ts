/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { EN } from '../../src/i18n';
import html from '../../index.html?raw';

// i18n.ts 自己的注释里有示例，不算
const files = import.meta.glob<string>(['../../src/*.ts', '!../../src/i18n.ts'], { query: '?raw', import: 'default', eager: true });
const src = Object.values(files).join('\n');
/** 代码里所有 t('…') 的中文原文 */
const keys = [...src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\n/g, '\n'));
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('代码里每个 t() 都有英文', () => {
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.filter((k) => !(k in EN))).toEqual([]);
  });

  it('英文和中文的 {变量} 一致', () => {
    expect(Object.entries(EN).filter(([zh, en]) => vars(zh).join() !== vars(en).join())).toEqual([]);
  });

  it('index.html 里写死的中文都有英文', () => {
    const texts = [...html.matchAll(/>([^<>]*[一-龥][^<>]*)</g)].map((m) => m[1].trim());
    const attrs = [...html.matchAll(/(?:title|placeholder|aria-label)="([^"]*[一-龥][^"]*)"/g)].map((m) => m[1]);
    expect([...texts, ...attrs].filter((s) => !(s in EN))).toEqual([]);
  });
});
