'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeZipFile, crc32 } = require('../src/zip-writer');

test('crc32 与标准向量一致', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('写出的 zip 结构合法：EOCD、条目数、文件名与内容可回读', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-writer-'));
  const fileA = path.join(dir, 'a.txt');
  const fileB = path.join(dir, 'b 中文名.png');
  fs.writeFileSync(fileA, 'hello zip');
  fs.writeFileSync(fileB, Buffer.from([1, 2, 3, 4, 5, 250, 251]));
  const target = path.join(dir, 'out.zip');

  const count = await writeZipFile(target, [
    { name: 'a.txt', path: fileA },
    { name: '子目录/b 中文名.png', path: fileB }
  ]);
  assert.equal(count, 2);

  const zip = fs.readFileSync(target);
  // EOCD 签名在末尾 22 字节
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054B50);
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2);
  // 第一个 local header 签名
  assert.equal(zip.readUInt32LE(0), 0x04034B50);
  // local header(30) + 文件名(5) 之后是文件内容
  assert.equal(zip.subarray(35, 35 + 9).toString(), 'hello zip');
  // 内容 CRC 与头里记录的一致
  assert.equal(zip.readUInt32LE(14), crc32(Buffer.from('hello zip')));
  fs.rmSync(dir, { recursive: true, force: true });
});
