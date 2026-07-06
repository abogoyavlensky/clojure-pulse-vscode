/**
 * Minimal bencode codec for the nREPL wire protocol. Byte-oriented: string
 * lengths count UTF-8 bytes, and decoding works on Buffers so multibyte
 * characters split across TCP chunks never corrupt the stream.
 */

export type BencodeValue =
  | string
  | number
  | BencodeValue[]
  | { [key: string]: BencodeValue | undefined };

export function encode(value: BencodeValue): Buffer {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`bencode supports only integers, got ${value}`);
    }
    return Buffer.from(`i${value}e`);
  }
  if (Array.isArray(value)) {
    const parts = value.map(encode);
    return Buffer.concat([Buffer.from("l"), ...parts, Buffer.from("e")]);
  }
  const parts: Buffer[] = [Buffer.from("d")];
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) {
      continue;
    }
    parts.push(encode(key), encode(val));
  }
  parts.push(Buffer.from("e"));
  return Buffer.concat(parts);
}

/** Sentinel: the buffer ends before the current value is complete. */
const INCOMPLETE = Symbol("incomplete");

type DecodeResult =
  | { value: BencodeValue; next: number }
  | typeof INCOMPLETE;

/**
 * Decodes as many complete top-level values as the buffer holds. A partial
 * trailing value is returned untouched in `rest` to be retried once more
 * bytes arrive.
 */
export function decodeBuffer(buf: Buffer): {
  decoded: BencodeValue[];
  rest: Buffer;
} {
  const decoded: BencodeValue[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const result = decodeAt(buf, offset);
    if (result === INCOMPLETE) {
      break;
    }
    decoded.push(result.value);
    offset = result.next;
  }
  return { decoded, rest: buf.subarray(offset) };
}

function decodeAt(buf: Buffer, offset: number): DecodeResult {
  if (offset >= buf.length) {
    return INCOMPLETE;
  }
  const marker = buf[offset];
  if (marker === 0x69) {
    // "i" — integer
    return decodeInt(buf, offset);
  }
  if (marker === 0x6c) {
    // "l" — list
    return decodeSequence(buf, offset, (items) => items);
  }
  if (marker === 0x64) {
    // "d" — dict
    return decodeSequence(buf, offset, toDict);
  }
  if (marker >= 0x30 && marker <= 0x39) {
    // digit — string
    return decodeString(buf, offset);
  }
  throw new Error(
    `bencode: unexpected byte 0x${marker.toString(16)} at offset ${offset}`,
  );
}

function decodeInt(buf: Buffer, offset: number): DecodeResult {
  const end = buf.indexOf(0x65, offset + 1); // "e"
  if (end === -1) {
    return INCOMPLETE;
  }
  const text = buf.toString("ascii", offset + 1, end);
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`bencode: invalid integer "${text}"`);
  }
  return { value: Number.parseInt(text, 10), next: end + 1 };
}

function decodeString(buf: Buffer, offset: number): DecodeResult {
  const colon = buf.indexOf(0x3a, offset); // ":"
  if (colon === -1) {
    return INCOMPLETE;
  }
  const lengthText = buf.toString("ascii", offset, colon);
  if (!/^\d+$/.test(lengthText)) {
    throw new Error(`bencode: invalid string length "${lengthText}"`);
  }
  const length = Number.parseInt(lengthText, 10);
  const end = colon + 1 + length;
  if (end > buf.length) {
    return INCOMPLETE;
  }
  return { value: buf.toString("utf8", colon + 1, end), next: end };
}

function decodeSequence(
  buf: Buffer,
  offset: number,
  build: (items: BencodeValue[]) => BencodeValue,
): DecodeResult {
  const items: BencodeValue[] = [];
  let cursor = offset + 1;
  for (;;) {
    if (cursor >= buf.length) {
      return INCOMPLETE;
    }
    if (buf[cursor] === 0x65) {
      // "e" — end of sequence
      return { value: build(items), next: cursor + 1 };
    }
    const result = decodeAt(buf, cursor);
    if (result === INCOMPLETE) {
      return INCOMPLETE;
    }
    items.push(result.value);
    cursor = result.next;
  }
}

function toDict(items: BencodeValue[]): BencodeValue {
  const dict: { [key: string]: BencodeValue } = {};
  for (let i = 0; i + 1 < items.length; i += 2) {
    dict[String(items[i])] = items[i + 1];
  }
  return dict;
}
