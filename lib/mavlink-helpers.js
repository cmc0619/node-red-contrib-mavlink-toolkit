// Lightweight MAVLink v2 helpers: frame parse/build, X.25 CRC, field (un)pack.
// Supports common scalar types and fixed-length arrays, incl. char[n] (C-string).

const MAGIC_V2 = 0xFD;

// X.25 CRC (MCRF4XX), same as MAVLink
function crcAccumulate(byte, crc) {
  let tmp = byte ^ (crc & 0xff);
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return (((crc >> 8) & 0xffff) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}
function crcX25(buf, seed = 0xffff) {
  let crc = seed;
  for (let i = 0; i < buf.length; i++) crc = crcAccumulate(buf[i], crc);
  return crc & 0xffff;
}

// sizes
const typeSize = {
  "char": 1, "int8_t":1, "uint8_t":1,
  "int16_t":2, "uint16_t":2,
  "int32_t":4, "uint32_t":4, "float":4,
  "int64_t":8, "uint64_t":8, "double":8
};
function sizeof(t, len) {
  return (typeSize[t] || 0) * (len || 1);
}

function sortFieldsForPacking(fields) {
  // MAVLink packs by descending type size (8,4,2,1). Keep stable within group.
  return [...fields].sort((a,b) => {
    const sa = sizeof(a.type, a.arrayLen || 1);
    const sb = sizeof(b.type, b.arrayLen || 1);
    return sb - sa;
  });
}

function writeScalarLE(buf, offset, type, value) {
  switch (type) {
    case "char":
    case "int8_t":  buf.writeInt8(value, offset); return offset+1;
    case "uint8_t": buf.writeUInt8(value, offset); return offset+1;
    case "int16_t": buf.writeInt16LE(value, offset); return offset+2;
    case "uint16_t": buf.writeUInt16LE(value, offset); return offset+2;
    case "int32_t": buf.writeInt32LE(value, offset); return offset+4;
    case "uint32_t": buf.writeUInt32LE(value, offset); return offset+4;
    case "float": buf.writeFloatLE(value, offset); return offset+4;
    case "int64_t": {
      let lo = BigInt(value) & 0xffffffffn;
      let hi = (BigInt(value) >> 32n) & 0xffffffffn;
      buf.writeUInt32LE(Number(lo), offset);
      buf.writeInt32LE(Number(hi), offset+4);
      return offset+8;
    }
    case "uint64_t": {
      let lo = BigInt(value) & 0xffffffffn;
      let hi = (BigInt(value) >> 32n) & 0xffffffffn;
      buf.writeUInt32LE(Number(lo), offset);
      buf.writeUInt32LE(Number(hi), offset+4);
      return offset+8;
    }
    case "double": buf.writeDoubleLE(value, offset); return offset+8;
    default: throw new Error("Unsupported type " + type);
  }
}

function readScalarLE(buf, offset, type) {
  switch (type) {
    case "char":
    case "int8_t":  return [buf.readInt8(offset), offset+1];
    case "uint8_t": return [buf.readUInt8(offset), offset+1];
    case "int16_t": return [buf.readInt16LE(offset), offset+2];
    case "uint16_t": return [buf.readUInt16LE(offset), offset+2];
    case "int32_t": return [buf.readInt32LE(offset), offset+4];
    case "uint32_t": return [buf.readUInt32LE(offset), offset+4];
    case "float": return [buf.readFloatLE(offset), offset+4];
    case "int64_t": {
      const lo = BigInt(buf.readUInt32LE(offset));
      const hi = BigInt(buf.readInt32LE(offset+4));
      return [Number((hi<<32n) | lo), offset+8];
    }
    case "uint64_t": {
      const lo = BigInt(buf.readUInt32LE(offset));
      const hi = BigInt(buf.readUInt32LE(offset+4));
      return [Number((hi<<32n) | lo), offset+8];
    }
    case "double": return [buf.readDoubleLE(offset), offset+8];
    default: throw new Error("Unsupported type " + type);
  }
}

function packPayload(messageDef, payloadObj) {
  // Compute payload length
  const fieldsSorted = sortFieldsForPacking(messageDef.fields);
  const totalLen = fieldsSorted.reduce((acc,f)=> acc + sizeof(f.type, f.arrayLen||1), 0);
  const payload = Buffer.alloc(totalLen);

  let off = 0;
  for (const f of fieldsSorted) {
    const val = payloadObj[f.name];
    const arrLen = f.arrayLen || 0;

    if (arrLen && f.type === "char") {
      // char[n] string
      const s = (val == null ? "" : String(val));
      const b = Buffer.from(s, "utf8");
      const len = Math.min(arrLen, b.length);
      b.copy(payload, off, 0, len);
      if (len < arrLen) payload.fill(0, off+len, off+arrLen);
      off += arrLen;
    } else if (arrLen) {
      const arr = Array.isArray(val) ? val : [];
      for (let i=0; i<arrLen; i++) {
        const v = arr[i] ?? 0;
        off = writeScalarLE(payload, off, f.type, v);
      }
    } else {
      off = writeScalarLE(payload, off, f.type, val ?? 0);
    }
  }
  return payload;
}

function unpackPayload(messageDef, payload) {
  const fieldsSorted = sortFieldsForPacking(messageDef.fields);
  const obj = {};
  let off = 0;
  for (const f of fieldsSorted) {
    const arrLen = f.arrayLen || 0;
    if (arrLen && f.type === "char") {
      const slice = payload.subarray(off, off+arrLen);
      const nul = slice.indexOf(0);
      obj[f.name] = slice.subarray(0, nul < 0 ? slice.length : nul).toString("utf8");
      off += arrLen;
    } else if (arrLen) {
      const arr = [];
      for (let i=0;i<arrLen;i++) {
        const [v, nOff] = readScalarLE(payload, off, f.type);
        off = nOff; arr.push(v);
      }
      obj[f.name] = arr;
    } else {
      const [v, nOff] = readScalarLE(payload, off, f.type);
      off = nOff; obj[f.name] = v;
    }
  }
  return obj;
}

function buildFrameV2(messageDef, payload, opts) {
  const incompatFlags = opts?.incompatFlags ?? 0;
  const compatFlags = opts?.compatFlags ?? 0;
  const seq = opts?.seq ?? 0;
  const sysid = opts?.sysid ?? 1;
  const compid = opts?.compid ?? 1;
  const msgid = messageDef.id;

  const payloadLen = payload.length;
  const header = Buffer.alloc(10);
  header[0] = MAGIC_V2;
  header[1] = payloadLen;
  header[2] = incompatFlags & 0xff;
  header[3] = compatFlags & 0xff;
  header[4] = seq & 0xff;
  header[5] = sysid & 0xff;
  header[6] = compid & 0xff;
  header[7] = msgid & 0xff;
  header[8] = (msgid >> 8) & 0xff;
  header[9] = (msgid >> 16) & 0xff;

  // CRC over header (1..9?) + payload per MAVLink v2: start from LEN field (skip magic)
  const crcData = Buffer.concat([ header.subarray(1), payload ]);
  let crc = crcX25(crcData);
  crc = crcAccumulate(messageDef.crc & 0xff, crc);

  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16LE(crc, 0);

  return Buffer.concat([header, payload, crcBuf]);
}

function* scanFramesV2(buf) {
  // yields { start, end, frameBuf } for each valid frame found
  for (let i=0; i<buf.length; i++) {
    if (buf[i] !== MAGIC_V2) continue;
    if (i + 10 > buf.length) break; // not enough header
    const len = buf[i+1];
    const frameLen = 10 + len + 2; // header + payload + crc
    if (i + frameLen > buf.length) break;
    const frame = buf.subarray(i, i+frameLen);
    // verify CRC
    const crcData = Buffer.concat([ frame.subarray(1, 10), frame.subarray(10, 10+len) ]);
    let crc = crcX25(crcData);
    // We don't know crc extra here—can't fully verify without messageDef; let parser do it with schema
    yield { start: i, end: i+frameLen, frameBuf: frame };
    i += (frameLen - 1);
  }
}

module.exports = {
  packPayload, unpackPayload, buildFrameV2, scanFramesV2,
  crcX25, crcAccumulate, MAGIC_V2
};

