// 读 DSH 会话日志：一个事件一个 zstd 帧，只追不改。按字节偏移续读。
//
// 关键点（枢阁那边踩出来的）：多帧是**直接拼在一起**的，文件头就是魔数 28 b5 2f fd；
// 必须逐帧切、逐帧解，一帧解不开就说明这帧还没写全——偏移停在它的起点，等下一次再读，
// 绝不能跳过它，否则那一帧的数据就永远丢了。
import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_SUFFIX = 'session.v3.jsonl.zstd';
/** 单次最多读这么多字节，避免一个超大日志把内存顶穿。 */
const MAX_READ = 48 * 1024 * 1024;

/** 扫出所有会话日志 → `[{id, path, cwd, size, mtimeMs}]`，按 mtime 升序。 */
export function listSessionFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile() || e.name !== SESSION_SUFFIX) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const sessionDir = path.dirname(full);
      out.push({
        id: path.basename(sessionDir),
        path: full,
        cwd: path.basename(path.dirname(sessionDir)),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  };
  if (root) walk(root);
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** 从帧头读「这一帧解压后应该有多长」；读不出就 null。
 *
 *  为什么需要：Node 的 zstd 遇到**没写全的帧**不报错，直接返回 0 字节。
 *  光靠"解压不抛"会把这半帧当成写完，然后偏移越过它——那条记录就永远丢了。
 */
function frameContentSize(buf, s) {
  if (s + 5 > buf.length) return null;
  const fhd = buf[s + 4];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  let pos = s + 5;
  if (!singleSegment) pos += 1; // Window_Descriptor
  pos += [0, 1, 2, 4][dictFlag];
  const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  if (fcsBytes === 0 || pos + fcsBytes > buf.length) return null;
  let value = 0;
  for (let i = 0; i < fcsBytes; i += 1) value += buf[pos + i] * Math.pow(256, i);
  if (fcsBytes === 2) value += 256;
  void checksum;
  return value;
}

function findFrames(buf) {
  const starts = [];
  let i = 0;
  while (i < buf.length - 3) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i);
      i += 4;
      continue;
    }
    i += 1;
  }
  return starts;
}

/**
 * 从 `offset` 读到文件末尾 → `{records, offsetAfter, error}`。
 * 只把解开的帧算进去，`offsetAfter` 永远落在第一帧解不开的地方。
 */
export function decodeFrom(file, offset = 0) {
  let start = Number(offset) || 0;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    return { records: [], offsetAfter: 0, error: String((err && err.message) || err) };
  }
  if (start > size) start = 0;
  if (size - start > MAX_READ) start = Math.max(0, size - MAX_READ);

  let buf;
  try {
    const readBytes = size - start;
    if (readBytes <= 0) return { records: [], offsetAfter: start, error: '' };
    buf = Buffer.alloc(readBytes);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, readBytes, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { records: [], offsetAfter: start, error: String((err && err.message) || err) };
  }

  const frames = findFrames(buf);
  if (frames.length === 0) {
    // 可能是从帧中间开始读的：整份重来一次更省心
    if (start > 0) return decodeFrom(file, 0);
    return { records: [], offsetAfter: start + buf.length, error: '' };
  }
  // 偏移落在帧中间时，第一个魔数之前那段是残片，丢掉，从它可以对齐
  const records = [];
  let consumed = frames[0];
  for (let k = 0; k < frames.length; k += 1) {
    const s = frames[k];
    const e = k + 1 < frames.length ? frames[k + 1] : buf.length;
    let out;
    try {
      out = zstdDecompressSync(buf.subarray(s, e));
    } catch {
      break; // 解不开就是不完整
    }
    const declared = frameContentSize(buf, s);
    if (out.length === 0) break; // 半帧：Node 会安静地给 0 字节
    if (declared !== null && out.length !== declared) break; // 帧头说的长度对不上，也别要
    consumed = e;
    const text = out.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* 坏行跳过，不打断整批 */
      }
    }
  }
  return { records, offsetAfter: start + consumed, error: '' };
}
