'use strict';

// 极简 ZIP 写入器（store 模式不压缩）：导出的图片本身已是 png/jpg/webp 压缩格式，
// 再压缩收益极小，store 模式写入快且实现可靠。逐个读文件顺序写入，内存占用只取决于单张最大图片。
const fs = require('node:fs/promises');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
  return { time, day };
}

// 经典 ZIP（非 ZIP64）的 32 位字段上限：条目大小与偏移都不能超过 4GB
const ZIP32_MAX = 0xFFFFFFFF;

// entries: [{ name, path }]，按顺序写入；返回写入的文件数
async function writeZipFile(targetPath, entries) {
  const handle = await fs.open(targetPath, 'w');
  const central = [];
  let offset = 0;
  let completed = false;
  try {
    for (const entry of entries) {
      const data = await fs.readFile(entry.path);
      // 本实现不支持 ZIP64：单文件或累计偏移超过 4GB 时提前给出明确报错，
      // 避免 writeUInt32LE 抛 RangeError 并留下损坏的 zip
      if (data.length > ZIP32_MAX || offset + 30 + Buffer.byteLength(entry.name) + data.length > ZIP32_MAX) {
        throw new Error('导出内容总大小超过 ZIP 4GB 上限，请减少勾选数量后分批导出');
      }
      const name = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
      const crc = crc32(data);
      const { time, day } = dosDateTime();
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034B50, 0);       // local file header 签名
      local.writeUInt16LE(20, 4);               // 解压所需版本 2.0
      local.writeUInt16LE(0x0800, 6);           // UTF-8 文件名标志
      local.writeUInt16LE(0, 8);                // store，不压缩
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);     // 压缩后大小
      local.writeUInt32LE(data.length, 22);     // 原始大小
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);               // extra 长度
      await handle.write(local);
      await handle.write(name);
      await handle.write(data);
      central.push({ name, crc, size: data.length, offset, time, day });
      offset += local.length + name.length + data.length;
    }

    const centralStart = offset;
    for (const item of central) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014B50, 0);      // central directory 签名
      record.writeUInt16LE(20, 4);              // 压缩所用版本
      record.writeUInt16LE(20, 6);              // 解压所需版本
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(0, 10);
      record.writeUInt16LE(item.time, 12);
      record.writeUInt16LE(item.day, 14);
      record.writeUInt32LE(item.crc, 16);
      record.writeUInt32LE(item.size, 20);
      record.writeUInt32LE(item.size, 24);
      record.writeUInt16LE(item.name.length, 28);
      // 30 extra 长度、32 注释长度、34 起始磁盘、36 内部属性 均为 0
      record.writeUInt32LE(0, 38);              // 外部属性
      record.writeUInt32LE(item.offset, 42);    // local header 偏移
      await handle.write(record);
      await handle.write(item.name);
      offset += record.length + item.name.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);           // EOCD 签名
    end.writeUInt16LE(central.length, 8);       // 本磁盘条目数
    end.writeUInt16LE(central.length, 10);      // 条目总数
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    await handle.write(end);
    completed = true;
  } finally {
    await handle.close();
    // 中途失败（读文件出错、超出 4GB 上限等）时删掉残缺的 zip，不留损坏文件
    if (!completed) await fs.rm(targetPath, { force: true }).catch(() => {});
  }
  return central.length;
}

module.exports = { writeZipFile, crc32 };
