import { describe, expect, it } from 'vitest';
import { groupFiles, SourceFile } from '../../src/remoteUpload';

const f = (path: string): SourceFile => ({ file: { name: path.split('/').pop() } as File, path });

describe('groupFiles', () => {
  it('同名 JPG+RAW 算一张，用 JPG 做预览，按文件夹区分', () => {
    const groups = groupFiles([
      f('外景/DSC_0001.NEF'),
      f('外景/DSC_0001.JPG'),
      f('外景/DSC_0002.NEF'),
      f('棚拍/DSC_0001.jpg'),
      f('外景/._DSC_0003.JPG'),
      f('外景/notes.txt'),
      f('外景/DSC_0001.xmp'),
    ]);
    expect(groups.map((g) => [g.key, g.source.path, g.originals])).toEqual([
      ['外景/dsc_0001', '外景/DSC_0001.JPG', ['DSC_0001.JPG', 'DSC_0001.NEF']],
      ['外景/dsc_0002', '外景/DSC_0002.NEF', ['DSC_0002.NEF']],
      ['棚拍/dsc_0001', '棚拍/DSC_0001.jpg', ['DSC_0001.jpg']],
    ]);
    expect(groups[0].folder).toBe('外景');
  });

  it('单选文件时没有文件夹', () => {
    const [g] = groupFiles([f('IMG_1.HEIC')]);
    expect(g.folder).toBe('');
    expect(g.key).toBe('img_1');
  });
});
