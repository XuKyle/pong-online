'use strict';
// 最小可用 ZIP 写入器（STORE + DEFLATE，UTF-8 文件名）。
// 为什么要自己写：本机的 bsdtar 遇到中文输出名直接段错误，Compress-Archive 直接失败
// （疑似被 tools/shots 里那几个特殊字符文件名绊住）。zlib 是 Node 自带的，用它最稳。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ---------- DOS 时间 ----------
function dosDateTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

// ---------- 遍历 ----------
function walk(rootAbs, rootName) {
  const out = [];
  (function rec(dir, rel) {
    // 排序保证结果稳定可复现
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) rec(abs, r);
      // ★ 这里必须是 `rel: r`（完整路径），不能偷懒写 `{ rel }` —— 那等于 `rel: rel`，
      //   存进去的是**父目录**的路径，于是包内每个文件名都变成它所在的目录
      //   （node_modules/ws/lib 会重复出现十几次）。而且这种包"能解开、CRC 也对"，
      //   只有真的去比文件名才会暴露 —— 光看"压缩成功"是发现不了的。
      else if (st.isFile()) out.push({ abs, rel: r, size: st.size, mtime: st.mtime });
    }
  })(rootAbs, '');
  return out;
}

function makeZip(rootAbs, rootName, outFile) {
  const files = walk(rootAbs, rootName);
  const chunks = [];
  const central = [];
  let offset = 0;
  let rawTotal = 0;
  let compTotal = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.abs);
    rawTotal += data.length;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // 压不下去就原样存（比如 mp3 / png），避免"越压越大"和多余的 CPU
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    compTotal += body.length;

    const nameBuf = Buffer.from(rootName + '/' + f.rel, 'utf8');
    const { time, date } = dosDateTime(f.mtime);
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);          // ★ bit 11 = 文件名是 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    chunks.push(lh, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outFile, Buffer.concat([...chunks, cdBuf, eocd]));
  return { count: files.length, rawTotal, compTotal, files };
}

// ---------- 执行 ----------
const ROOT = process.argv[2];
const OUT = process.argv[3];
const NAME = path.basename(ROOT);
const r = makeZip(ROOT, NAME, OUT);
const zsize = fs.statSync(OUT).size;
console.log('打包完成: ' + OUT);
console.log('  条目数   : ' + r.count);
console.log('  原始大小 : ' + (r.rawTotal / 1048576).toFixed(2) + ' MB');
console.log('  压缩后   : ' + (zsize / 1048576).toFixed(2) + ' MB');
console.log('  压缩率   : ' + (100 * (1 - zsize / r.rawTotal)).toFixed(1) + '%');
