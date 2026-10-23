"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all2) => {
  for (var name in all2)
    __defProp(target, name, { get: all2[name], enumerable: true });
};
var __copyProps = (to, from2, except, desc) => {
  if (from2 && typeof from2 === "object" || typeof from2 === "function") {
    for (let key of __getOwnPropNames(from2))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from2[key], enumerable: !(desc = __getOwnPropDesc(from2, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// shared/limits.json
var require_limits = __commonJS({
  "shared/limits.json"(exports2, module2) {
    module2.exports = {
      uploadPartChars: 9e4,
      maxImageBytes: 4194304,
      maxContentChars: 24e3,
      maxContentBytes: 4e4,
      maxPropertiesBytes: 32e3
    };
  }
});

// server/assets.cjs
var require_assets = __commonJS({
  "server/assets.cjs"(exports2, module2) {
    "use strict";
    var { randomUUID } = require("node:crypto");
    var { uploadPartChars, maxImageBytes } = require_limits();
    var ASSET_SOURCE = /^fieldnotes:\/\/asset\/([0-9a-f-]{36})$/;
    var ASSET_REFERENCE = /fieldnotes:\/\/asset\/([0-9a-f-]{36})/g;
    var MAX_PARTS = Math.ceil(Math.ceil(maxImageBytes / 3) * 4 / uploadPartChars);
    var MAX_STORED_IMAGE_BYTES = 256 * 1024 * 1024 / 2 * 3 / 4;
    var UPLOAD_TTL_MS = 60 * 60 * 1e3;
    var RELEASE_GRACE_MS = 10 * 60 * 1e3;
    var UNUSED_GRACE_MS = 24 * 60 * 60 * 1e3;
    var SIGNATURES = [
      ["image/png", (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
      ["image/jpeg", (bytes) => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255],
      ["image/gif", (bytes) => /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))],
      ["image/webp", (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"],
      ["image/avif", (bytes) => bytes.subarray(4, 8).toString("latin1") === "ftyp" && /^avi[fs]$/.test(bytes.subarray(8, 12).toString("latin1"))]
    ];
    var assetIds = (content) => new Set([...String(content).matchAll(ASSET_REFERENCE)].map((match) => match[1]));
    var sniff = (bytes) => SIGNATURES.find(([, matches]) => matches(bytes))?.[0] || null;
    function createAssets({ fail }) {
      const uploadId = (value) => {
        if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) fail(400, "Invalid upload.");
        return value;
      };
      function referenceOps(before, after) {
        const previous = assetIds(before);
        const next = assetIds(after);
        const added = [...next].filter((assetId) => !previous.has(assetId));
        const removed = [...previous].filter((assetId) => !next.has(assetId));
        const ops = [];
        if (added.length) ops.push({
          sql: "UPDATE note_assets SET released_at = NULL WHERE id IN (SELECT value FROM json_each(?))",
          args: [JSON.stringify(added)]
        });
        if (removed.length) {
          ops.push({
            sql: "UPDATE note_assets SET released_at = ? WHERE released_at IS NULL AND id IN (SELECT value FROM json_each(?))",
            args: [(/* @__PURE__ */ new Date()).toISOString(), JSON.stringify(removed)]
          });
        }
        return ops;
      }
      async function track(ctx, before, after) {
        const ops = referenceOps(before, after);
        if (ops.length) await ctx.db.tx(ops);
      }
      function sweep(ctx) {
        const now = Date.now();
        return ctx.db.exec(
          `DELETE FROM note_assets WHERE (CASE WHEN released_at IS NULL THEN created_at < ? ELSE released_at < ? END)
      AND NOT EXISTS (SELECT 1 FROM notes WHERE archived = 0 AND instr(content, 'fieldnotes://asset/' || note_assets.id) > 0)`,
          new Date(now - UNUSED_GRACE_MS).toISOString(),
          new Date(now - RELEASE_GRACE_MS).toISOString()
        );
      }
      async function reserve(ctx, uploadId2, adding) {
        const [{ total }] = await ctx.db.query(`SELECT (SELECT COALESCE(SUM(size), 0) FROM note_assets)
      + (SELECT COALESCE(SUM(size), 0) FROM snapshot_assets)
      + (SELECT COALESCE(SUM(length(data)), 0) * 3 / 4 FROM asset_uploads WHERE id != ?) AS total`, uploadId2);
        if (total + adding > MAX_STORED_IMAGE_BYTES) fail(413, "Fieldnotes image storage is full. Remove unused images first.");
      }
      async function upload(ctx, userId, input) {
        const part = Number(input.part);
        const parts = Number(input.parts);
        const data = input.data;
        if (!Number.isSafeInteger(parts) || parts < 1 || parts > MAX_PARTS || !Number.isSafeInteger(part) || part < 0 || part >= parts || typeof data !== "string" || !data.length || data.length > uploadPartChars || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
          fail(400, "Invalid upload part.");
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const id2 = part === 0 ? randomUUID() : uploadId(input.upload_id);
        if (part === 0) await ctx.db.exec("DELETE FROM asset_uploads WHERE created_at < ?", new Date(Date.now() - UPLOAD_TTL_MS).toISOString());
        const stored = part === 0 ? [] : await ctx.db.query("SELECT data FROM asset_uploads WHERE id = ? AND owner_id = ? AND parts = ? ORDER BY part", id2, userId, parts);
        if (stored.length !== part) fail(409, "Upload parts must arrive in order.");
        if (part < parts - 1) {
          await reserve(ctx, id2, (part + 1) * data.length * 3 / 4);
          await ctx.db.exec(
            "INSERT INTO asset_uploads (id, owner_id, part, parts, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            id2,
            userId,
            part,
            parts,
            data,
            now
          );
          return { upload_id: id2 };
        }
        const bytes = Buffer.from([...stored.map((row) => row.data), data].join(""), "base64");
        if (bytes.length > maxImageBytes) fail(413, "Images must be {size} MB or smaller.", { size: maxImageBytes / 1024 / 1024 });
        const mimetype = sniff(bytes) || fail(415, "Upload a PNG, JPEG, GIF, WebP or AVIF image.");
        await sweep(ctx);
        await reserve(ctx, id2, bytes.length);
        const assetId = randomUUID();
        await ctx.db.tx([
          {
            sql: "INSERT INTO note_assets (id, owner_id, mimetype, size, content_base64, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            args: [assetId, userId, mimetype, bytes.length, bytes.toString("base64"), now]
          },
          { sql: "DELETE FROM asset_uploads WHERE id = ?", args: [id2] }
        ]);
        return { source: `fieldnotes://asset/${assetId}`, mimetype, size: bytes.length };
      }
      async function read(ctx, source) {
        const match = ASSET_SOURCE.exec(source);
        if (!match) return null;
        const [row] = await ctx.db.query("SELECT mimetype, size, content_base64 FROM note_assets WHERE id = ?", match[1]);
        return row || fail(404, "This image was deleted.");
      }
      return { referenceOps, track, sweep, upload, read };
    }
    module2.exports = { createAssets };
  }
});

// node_modules/lib0/map.js
var create, copy, setIfUndefined, any;
var init_map = __esm({
  "node_modules/lib0/map.js"() {
    create = () => /* @__PURE__ */ new Map();
    copy = (m) => {
      const r = create();
      m.forEach((v, k) => {
        r.set(k, v);
      });
      return r;
    };
    setIfUndefined = (map, key, createT) => {
      let set = map.get(key);
      if (set === void 0) {
        map.set(key, set = createT());
      }
      return set;
    };
    any = (m, f) => {
      for (const [key, value] of m) {
        if (f(value, key)) {
          return true;
        }
      }
      return false;
    };
  }
});

// node_modules/lib0/set.js
var create2;
var init_set = __esm({
  "node_modules/lib0/set.js"() {
    create2 = () => /* @__PURE__ */ new Set();
  }
});

// node_modules/lib0/array.js
var last, appendTo, from, some, unfold, isArray;
var init_array = __esm({
  "node_modules/lib0/array.js"() {
    last = (arr) => arr[arr.length - 1];
    appendTo = (dest, src) => {
      for (let i = 0; i < src.length; i++) {
        dest.push(src[i]);
      }
    };
    from = Array.from;
    some = (arr, f) => {
      for (let i = 0; i < arr.length; i++) {
        if (f(arr[i], i, arr)) {
          return true;
        }
      }
      return false;
    };
    unfold = (len, f) => {
      const array = new Array(len);
      for (let i = 0; i < len; i++) {
        array[i] = f(i, array);
      }
      return array;
    };
    isArray = Array.isArray;
  }
});

// node_modules/lib0/observable.js
var ObservableV2;
var init_observable = __esm({
  "node_modules/lib0/observable.js"() {
    init_map();
    init_set();
    init_array();
    ObservableV2 = class {
      constructor() {
        this._observers = create();
      }
      /**
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name
       * @param {EVENTS[NAME]} f
       */
      on(name, f) {
        setIfUndefined(
          this._observers,
          /** @type {string} */
          name,
          create2
        ).add(f);
        return f;
      }
      /**
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name
       * @param {EVENTS[NAME]} f
       */
      once(name, f) {
        const _f = (...args2) => {
          this.off(
            name,
            /** @type {any} */
            _f
          );
          f(...args2);
        };
        this.on(
          name,
          /** @type {any} */
          _f
        );
      }
      /**
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name
       * @param {EVENTS[NAME]} f
       */
      off(name, f) {
        const observers = this._observers.get(name);
        if (observers !== void 0) {
          observers.delete(f);
          if (observers.size === 0) {
            this._observers.delete(name);
          }
        }
      }
      /**
       * Emit a named event. All registered event listeners that listen to the
       * specified name will receive the event.
       *
       * @todo This should catch exceptions
       *
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name The event name.
       * @param {Parameters<EVENTS[NAME]>} args The arguments that are applied to the event listener.
       */
      emit(name, args2) {
        return from((this._observers.get(name) || create()).values()).forEach((f) => f(...args2));
      }
      destroy() {
        this._observers = create();
      }
    };
  }
});

// node_modules/lib0/math.js
var floor, abs, min, max, isNaN, isNegativeZero;
var init_math = __esm({
  "node_modules/lib0/math.js"() {
    floor = Math.floor;
    abs = Math.abs;
    min = (a, b) => a < b ? a : b;
    max = (a, b) => a > b ? a : b;
    isNaN = Number.isNaN;
    isNegativeZero = (n) => n !== 0 ? n < 0 : 1 / n < 0;
  }
});

// node_modules/lib0/binary.js
var BIT1, BIT2, BIT3, BIT4, BIT6, BIT7, BIT8, BIT18, BIT19, BIT20, BIT21, BIT22, BIT23, BIT24, BIT25, BIT26, BIT27, BIT28, BIT29, BIT30, BIT31, BIT32, BITS5, BITS6, BITS7, BITS17, BITS18, BITS19, BITS20, BITS21, BITS22, BITS23, BITS24, BITS25, BITS26, BITS27, BITS28, BITS29, BITS30, BITS31;
var init_binary = __esm({
  "node_modules/lib0/binary.js"() {
    BIT1 = 1;
    BIT2 = 2;
    BIT3 = 4;
    BIT4 = 8;
    BIT6 = 32;
    BIT7 = 64;
    BIT8 = 128;
    BIT18 = 1 << 17;
    BIT19 = 1 << 18;
    BIT20 = 1 << 19;
    BIT21 = 1 << 20;
    BIT22 = 1 << 21;
    BIT23 = 1 << 22;
    BIT24 = 1 << 23;
    BIT25 = 1 << 24;
    BIT26 = 1 << 25;
    BIT27 = 1 << 26;
    BIT28 = 1 << 27;
    BIT29 = 1 << 28;
    BIT30 = 1 << 29;
    BIT31 = 1 << 30;
    BIT32 = 1 << 31;
    BITS5 = 31;
    BITS6 = 63;
    BITS7 = 127;
    BITS17 = BIT18 - 1;
    BITS18 = BIT19 - 1;
    BITS19 = BIT20 - 1;
    BITS20 = BIT21 - 1;
    BITS21 = BIT22 - 1;
    BITS22 = BIT23 - 1;
    BITS23 = BIT24 - 1;
    BITS24 = BIT25 - 1;
    BITS25 = BIT26 - 1;
    BITS26 = BIT27 - 1;
    BITS27 = BIT28 - 1;
    BITS28 = BIT29 - 1;
    BITS29 = BIT30 - 1;
    BITS30 = BIT31 - 1;
    BITS31 = 2147483647;
  }
});

// node_modules/lib0/number.js
var MAX_SAFE_INTEGER, MIN_SAFE_INTEGER, LOWEST_INT32, isInteger, isNaN2, parseInt;
var init_number = __esm({
  "node_modules/lib0/number.js"() {
    init_math();
    MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
    MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
    LOWEST_INT32 = 1 << 31;
    isInteger = Number.isInteger || ((num) => typeof num === "number" && isFinite(num) && floor(num) === num);
    isNaN2 = Number.isNaN;
    parseInt = Number.parseInt;
  }
});

// node_modules/lib0/string.js
var fromCharCode, fromCodePoint, MAX_UTF16_CHARACTER, toLowerCase, trimLeftRegex, trimLeft, fromCamelCaseRegex, fromCamelCase, _encodeUtf8Polyfill, utf8TextEncoder, _encodeUtf8Native, encodeUtf8, utf8TextDecoder, repeat;
var init_string = __esm({
  "node_modules/lib0/string.js"() {
    init_array();
    fromCharCode = String.fromCharCode;
    fromCodePoint = String.fromCodePoint;
    MAX_UTF16_CHARACTER = fromCharCode(65535);
    toLowerCase = (s) => s.toLowerCase();
    trimLeftRegex = /^\s*/g;
    trimLeft = (s) => s.replace(trimLeftRegex, "");
    fromCamelCaseRegex = /([A-Z])/g;
    fromCamelCase = (s, separator) => trimLeft(s.replace(fromCamelCaseRegex, (match) => `${separator}${toLowerCase(match)}`));
    _encodeUtf8Polyfill = (str) => {
      const encodedString = unescape(encodeURIComponent(str));
      const len = encodedString.length;
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        buf[i] = /** @type {number} */
        encodedString.codePointAt(i);
      }
      return buf;
    };
    utf8TextEncoder = /** @type {TextEncoder} */
    typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    _encodeUtf8Native = (str) => utf8TextEncoder.encode(str);
    encodeUtf8 = utf8TextEncoder ? _encodeUtf8Native : _encodeUtf8Polyfill;
    utf8TextDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    if (utf8TextDecoder && utf8TextDecoder.decode(new Uint8Array()).length === 1) {
      utf8TextDecoder = null;
    }
    repeat = (source, n) => unfold(n, () => source).join("");
  }
});

// node_modules/lib0/encoding.js
var Encoder, createEncoder, length, toUint8Array, verifyLen, write, writeUint8, writeVarUint, writeVarInt, _strBuffer, _maxStrBSize, _writeVarStringNative, _writeVarStringPolyfill, writeVarString, writeBinaryEncoder, writeUint8Array, writeVarUint8Array, writeOnDataView, writeFloat32, writeFloat64, writeBigInt64, floatTestBed, isFloat32, writeAny, RleEncoder, flushUintOptRleEncoder, UintOptRleEncoder, flushIntDiffOptRleEncoder, IntDiffOptRleEncoder, StringEncoder;
var init_encoding = __esm({
  "node_modules/lib0/encoding.js"() {
    init_math();
    init_number();
    init_binary();
    init_string();
    init_array();
    Encoder = class {
      constructor() {
        this.cpos = 0;
        this.cbuf = new Uint8Array(100);
        this.bufs = [];
      }
    };
    createEncoder = () => new Encoder();
    length = (encoder) => {
      let len = encoder.cpos;
      for (let i = 0; i < encoder.bufs.length; i++) {
        len += encoder.bufs[i].length;
      }
      return len;
    };
    toUint8Array = (encoder) => {
      const uint8arr = new Uint8Array(length(encoder));
      let curPos = 0;
      for (let i = 0; i < encoder.bufs.length; i++) {
        const d = encoder.bufs[i];
        uint8arr.set(d, curPos);
        curPos += d.length;
      }
      uint8arr.set(new Uint8Array(encoder.cbuf.buffer, 0, encoder.cpos), curPos);
      return uint8arr;
    };
    verifyLen = (encoder, len) => {
      const bufferLen = encoder.cbuf.length;
      if (bufferLen - encoder.cpos < len) {
        encoder.bufs.push(new Uint8Array(encoder.cbuf.buffer, 0, encoder.cpos));
        encoder.cbuf = new Uint8Array(max(bufferLen, len) * 2);
        encoder.cpos = 0;
      }
    };
    write = (encoder, num) => {
      const bufferLen = encoder.cbuf.length;
      if (encoder.cpos === bufferLen) {
        encoder.bufs.push(encoder.cbuf);
        encoder.cbuf = new Uint8Array(bufferLen * 2);
        encoder.cpos = 0;
      }
      encoder.cbuf[encoder.cpos++] = num;
    };
    writeUint8 = write;
    writeVarUint = (encoder, num) => {
      while (num > BITS7) {
        write(encoder, BIT8 | BITS7 & num);
        num = floor(num / 128);
      }
      write(encoder, BITS7 & num);
    };
    writeVarInt = (encoder, num) => {
      const isNegative = isNegativeZero(num);
      if (isNegative) {
        num = -num;
      }
      write(encoder, (num > BITS6 ? BIT8 : 0) | (isNegative ? BIT7 : 0) | BITS6 & num);
      num = floor(num / 64);
      while (num > 0) {
        write(encoder, (num > BITS7 ? BIT8 : 0) | BITS7 & num);
        num = floor(num / 128);
      }
    };
    _strBuffer = new Uint8Array(3e4);
    _maxStrBSize = _strBuffer.length / 3;
    _writeVarStringNative = (encoder, str) => {
      if (str.length < _maxStrBSize) {
        const written = utf8TextEncoder.encodeInto(str, _strBuffer).written || 0;
        writeVarUint(encoder, written);
        for (let i = 0; i < written; i++) {
          write(encoder, _strBuffer[i]);
        }
      } else {
        writeVarUint8Array(encoder, encodeUtf8(str));
      }
    };
    _writeVarStringPolyfill = (encoder, str) => {
      const encodedString = unescape(encodeURIComponent(str));
      const len = encodedString.length;
      writeVarUint(encoder, len);
      for (let i = 0; i < len; i++) {
        write(
          encoder,
          /** @type {number} */
          encodedString.codePointAt(i)
        );
      }
    };
    writeVarString = utf8TextEncoder && /** @type {any} */
    utf8TextEncoder.encodeInto ? _writeVarStringNative : _writeVarStringPolyfill;
    writeBinaryEncoder = (encoder, append) => writeUint8Array(encoder, toUint8Array(append));
    writeUint8Array = (encoder, uint8Array) => {
      const bufferLen = encoder.cbuf.length;
      const cpos = encoder.cpos;
      const leftCopyLen = min(bufferLen - cpos, uint8Array.length);
      const rightCopyLen = uint8Array.length - leftCopyLen;
      encoder.cbuf.set(uint8Array.subarray(0, leftCopyLen), cpos);
      encoder.cpos += leftCopyLen;
      if (rightCopyLen > 0) {
        encoder.bufs.push(encoder.cbuf);
        encoder.cbuf = new Uint8Array(max(bufferLen * 2, rightCopyLen));
        encoder.cbuf.set(uint8Array.subarray(leftCopyLen));
        encoder.cpos = rightCopyLen;
      }
    };
    writeVarUint8Array = (encoder, uint8Array) => {
      writeVarUint(encoder, uint8Array.byteLength);
      writeUint8Array(encoder, uint8Array);
    };
    writeOnDataView = (encoder, len) => {
      verifyLen(encoder, len);
      const dview = new DataView(encoder.cbuf.buffer, encoder.cpos, len);
      encoder.cpos += len;
      return dview;
    };
    writeFloat32 = (encoder, num) => writeOnDataView(encoder, 4).setFloat32(0, num, false);
    writeFloat64 = (encoder, num) => writeOnDataView(encoder, 8).setFloat64(0, num, false);
    writeBigInt64 = (encoder, num) => (
      /** @type {any} */
      writeOnDataView(encoder, 8).setBigInt64(0, num, false)
    );
    floatTestBed = new DataView(new ArrayBuffer(4));
    isFloat32 = (num) => {
      floatTestBed.setFloat32(0, num);
      return floatTestBed.getFloat32(0) === num;
    };
    writeAny = (encoder, data) => {
      switch (typeof data) {
        case "string":
          write(encoder, 119);
          writeVarString(encoder, data);
          break;
        case "number":
          if (isInteger(data) && abs(data) <= BITS31) {
            write(encoder, 125);
            writeVarInt(encoder, data);
          } else if (isFloat32(data)) {
            write(encoder, 124);
            writeFloat32(encoder, data);
          } else {
            write(encoder, 123);
            writeFloat64(encoder, data);
          }
          break;
        case "bigint":
          write(encoder, 122);
          writeBigInt64(encoder, data);
          break;
        case "object":
          if (data === null) {
            write(encoder, 126);
          } else if (isArray(data)) {
            write(encoder, 117);
            writeVarUint(encoder, data.length);
            for (let i = 0; i < data.length; i++) {
              writeAny(encoder, data[i]);
            }
          } else if (data instanceof Uint8Array) {
            write(encoder, 116);
            writeVarUint8Array(encoder, data);
          } else {
            write(encoder, 118);
            const keys2 = Object.keys(data);
            writeVarUint(encoder, keys2.length);
            for (let i = 0; i < keys2.length; i++) {
              const key = keys2[i];
              writeVarString(encoder, key);
              writeAny(encoder, data[key]);
            }
          }
          break;
        case "boolean":
          write(encoder, data ? 120 : 121);
          break;
        default:
          write(encoder, 127);
      }
    };
    RleEncoder = class extends Encoder {
      /**
       * @param {function(Encoder, T):void} writer
       */
      constructor(writer) {
        super();
        this.w = writer;
        this.s = null;
        this.count = 0;
      }
      /**
       * @param {T} v
       */
      write(v) {
        if (this.s === v) {
          this.count++;
        } else {
          if (this.count > 0) {
            writeVarUint(this, this.count - 1);
          }
          this.count = 1;
          this.w(this, v);
          this.s = v;
        }
      }
    };
    flushUintOptRleEncoder = (encoder) => {
      if (encoder.count > 0) {
        writeVarInt(encoder.encoder, encoder.count === 1 ? encoder.s : -encoder.s);
        if (encoder.count > 1) {
          writeVarUint(encoder.encoder, encoder.count - 2);
        }
      }
    };
    UintOptRleEncoder = class {
      constructor() {
        this.encoder = new Encoder();
        this.s = 0;
        this.count = 0;
      }
      /**
       * @param {number} v
       */
      write(v) {
        if (this.s === v) {
          this.count++;
        } else {
          flushUintOptRleEncoder(this);
          this.count = 1;
          this.s = v;
        }
      }
      /**
       * Flush the encoded state and transform this to a Uint8Array.
       *
       * Note that this should only be called once.
       */
      toUint8Array() {
        flushUintOptRleEncoder(this);
        return toUint8Array(this.encoder);
      }
    };
    flushIntDiffOptRleEncoder = (encoder) => {
      if (encoder.count > 0) {
        const encodedDiff = encoder.diff * 2 + (encoder.count === 1 ? 0 : 1);
        writeVarInt(encoder.encoder, encodedDiff);
        if (encoder.count > 1) {
          writeVarUint(encoder.encoder, encoder.count - 2);
        }
      }
    };
    IntDiffOptRleEncoder = class {
      constructor() {
        this.encoder = new Encoder();
        this.s = 0;
        this.count = 0;
        this.diff = 0;
      }
      /**
       * @param {number} v
       */
      write(v) {
        if (this.diff === v - this.s) {
          this.s = v;
          this.count++;
        } else {
          flushIntDiffOptRleEncoder(this);
          this.count = 1;
          this.diff = v - this.s;
          this.s = v;
        }
      }
      /**
       * Flush the encoded state and transform this to a Uint8Array.
       *
       * Note that this should only be called once.
       */
      toUint8Array() {
        flushIntDiffOptRleEncoder(this);
        return toUint8Array(this.encoder);
      }
    };
    StringEncoder = class {
      constructor() {
        this.sarr = [];
        this.s = "";
        this.lensE = new UintOptRleEncoder();
      }
      /**
       * @param {string} string
       */
      write(string) {
        this.s += string;
        if (this.s.length > 19) {
          this.sarr.push(this.s);
          this.s = "";
        }
        this.lensE.write(string.length);
      }
      toUint8Array() {
        const encoder = new Encoder();
        this.sarr.push(this.s);
        this.s = "";
        writeVarString(encoder, this.sarr.join(""));
        writeUint8Array(encoder, this.lensE.toUint8Array());
        return toUint8Array(encoder);
      }
    };
  }
});

// node_modules/lib0/error.js
var create3, methodUnimplemented, unexpectedCase;
var init_error = __esm({
  "node_modules/lib0/error.js"() {
    create3 = (s) => new Error(s);
    methodUnimplemented = () => {
      throw create3("Method unimplemented");
    };
    unexpectedCase = () => {
      throw create3("Unexpected case");
    };
  }
});

// node_modules/lib0/decoding.js
var errorUnexpectedEndOfArray, errorIntegerOutOfRange, Decoder, createDecoder, hasContent, readUint8Array, readVarUint8Array, readUint8, readVarUint, readVarInt, _readVarStringPolyfill, _readVarStringNative, readVarString, readFromDataView, readFloat32, readFloat64, readBigInt64, readAnyLookupTable, readAny, RleDecoder, UintOptRleDecoder, IntDiffOptRleDecoder, StringDecoder;
var init_decoding = __esm({
  "node_modules/lib0/decoding.js"() {
    init_binary();
    init_math();
    init_number();
    init_string();
    init_error();
    errorUnexpectedEndOfArray = create3("Unexpected end of array");
    errorIntegerOutOfRange = create3("Integer out of Range");
    Decoder = class {
      /**
       * @param {Uint8Array<Buf>} uint8Array Binary data to decode
       */
      constructor(uint8Array) {
        this.arr = uint8Array;
        this.pos = 0;
      }
    };
    createDecoder = (uint8Array) => new Decoder(uint8Array);
    hasContent = (decoder) => decoder.pos !== decoder.arr.length;
    readUint8Array = (decoder, len) => {
      if (len < 0 || len > decoder.arr.length - decoder.pos) {
        throw errorUnexpectedEndOfArray;
      }
      const view = new Uint8Array(decoder.arr.buffer, decoder.pos + decoder.arr.byteOffset, len);
      decoder.pos += len;
      return view;
    };
    readVarUint8Array = (decoder) => readUint8Array(decoder, readVarUint(decoder));
    readUint8 = (decoder) => decoder.arr[decoder.pos++];
    readVarUint = (decoder) => {
      let num = 0;
      let mult = 1;
      const len = decoder.arr.length;
      while (decoder.pos < len) {
        const r = decoder.arr[decoder.pos++];
        num = num + (r & BITS7) * mult;
        mult *= 128;
        if (r < BIT8) {
          return num;
        }
        if (num > MAX_SAFE_INTEGER) {
          throw errorIntegerOutOfRange;
        }
      }
      throw errorUnexpectedEndOfArray;
    };
    readVarInt = (decoder) => {
      let r = decoder.arr[decoder.pos++];
      let num = r & BITS6;
      let mult = 64;
      const sign = (r & BIT7) > 0 ? -1 : 1;
      if ((r & BIT8) === 0) {
        return sign * num;
      }
      const len = decoder.arr.length;
      while (decoder.pos < len) {
        r = decoder.arr[decoder.pos++];
        num = num + (r & BITS7) * mult;
        mult *= 128;
        if (r < BIT8) {
          return sign * num;
        }
        if (num > MAX_SAFE_INTEGER) {
          throw errorIntegerOutOfRange;
        }
      }
      throw errorUnexpectedEndOfArray;
    };
    _readVarStringPolyfill = (decoder) => {
      let remainingLen = readVarUint(decoder);
      if (remainingLen === 0) {
        return "";
      } else {
        let encodedString = String.fromCodePoint(readUint8(decoder));
        if (--remainingLen < 100) {
          while (remainingLen--) {
            encodedString += String.fromCodePoint(readUint8(decoder));
          }
        } else {
          while (remainingLen > 0) {
            const nextLen = remainingLen < 1e4 ? remainingLen : 1e4;
            const bytes = decoder.arr.subarray(decoder.pos, decoder.pos + nextLen);
            decoder.pos += nextLen;
            encodedString += String.fromCodePoint.apply(
              null,
              /** @type {any} */
              bytes
            );
            remainingLen -= nextLen;
          }
        }
        return decodeURIComponent(escape(encodedString));
      }
    };
    _readVarStringNative = (decoder) => (
      /** @type any */
      utf8TextDecoder.decode(readVarUint8Array(decoder))
    );
    readVarString = utf8TextDecoder ? _readVarStringNative : _readVarStringPolyfill;
    readFromDataView = (decoder, len) => {
      const dv = new DataView(decoder.arr.buffer, decoder.arr.byteOffset + decoder.pos, len);
      decoder.pos += len;
      return dv;
    };
    readFloat32 = (decoder) => readFromDataView(decoder, 4).getFloat32(0, false);
    readFloat64 = (decoder) => readFromDataView(decoder, 8).getFloat64(0, false);
    readBigInt64 = (decoder) => (
      /** @type {any} */
      readFromDataView(decoder, 8).getBigInt64(0, false)
    );
    readAnyLookupTable = [
      (decoder) => void 0,
      // CASE 127: undefined
      (decoder) => null,
      // CASE 126: null
      readVarInt,
      // CASE 125: integer
      readFloat32,
      // CASE 124: float32
      readFloat64,
      // CASE 123: float64
      readBigInt64,
      // CASE 122: bigint
      (decoder) => false,
      // CASE 121: boolean (false)
      (decoder) => true,
      // CASE 120: boolean (true)
      readVarString,
      // CASE 119: string
      (decoder) => {
        const len = readVarUint(decoder);
        const obj = {};
        for (let i = 0; i < len; i++) {
          const key = readVarString(decoder);
          obj[key] = readAny(decoder);
        }
        return obj;
      },
      (decoder) => {
        const len = readVarUint(decoder);
        const arr = [];
        for (let i = 0; i < len; i++) {
          arr.push(readAny(decoder));
        }
        return arr;
      },
      readVarUint8Array
      // CASE 116: Uint8Array
    ];
    readAny = (decoder) => readAnyLookupTable[127 - readUint8(decoder)](decoder);
    RleDecoder = class extends Decoder {
      /**
       * @param {Uint8Array} uint8Array
       * @param {function(Decoder):T} reader
       */
      constructor(uint8Array, reader) {
        super(uint8Array);
        this.reader = reader;
        this.s = null;
        this.count = 0;
      }
      read() {
        if (this.count === 0) {
          this.s = this.reader(this);
          if (hasContent(this)) {
            this.count = readVarUint(this) + 1;
          } else {
            this.count = -1;
          }
        }
        this.count--;
        return (
          /** @type {T} */
          this.s
        );
      }
    };
    UintOptRleDecoder = class extends Decoder {
      /**
       * @param {Uint8Array} uint8Array
       */
      constructor(uint8Array) {
        super(uint8Array);
        this.s = 0;
        this.count = 0;
      }
      read() {
        if (this.count === 0) {
          this.s = readVarInt(this);
          const isNegative = isNegativeZero(this.s);
          this.count = 1;
          if (isNegative) {
            this.s = -this.s;
            this.count = readVarUint(this) + 2;
          }
        }
        this.count--;
        return (
          /** @type {number} */
          this.s
        );
      }
    };
    IntDiffOptRleDecoder = class extends Decoder {
      /**
       * @param {Uint8Array} uint8Array
       */
      constructor(uint8Array) {
        super(uint8Array);
        this.s = 0;
        this.count = 0;
        this.diff = 0;
      }
      /**
       * @return {number}
       */
      read() {
        if (this.count === 0) {
          const diff = readVarInt(this);
          const hasCount = diff & 1;
          this.diff = floor(diff / 2);
          this.count = 1;
          if (hasCount) {
            this.count = readVarUint(this) + 2;
          }
        }
        this.s += this.diff;
        this.count--;
        return this.s;
      }
    };
    StringDecoder = class {
      /**
       * @param {Uint8Array} uint8Array
       */
      constructor(uint8Array) {
        this.decoder = new UintOptRleDecoder(uint8Array);
        this.str = readVarString(this.decoder);
        this.spos = 0;
      }
      /**
       * @return {string}
       */
      read() {
        const end = this.spos + this.decoder.read();
        const res = this.str.slice(this.spos, end);
        this.spos = end;
        return res;
      }
    };
  }
});

// node_modules/lib0/webcrypto.node.js
var import_node_crypto, subtle, getRandomValues;
var init_webcrypto_node = __esm({
  "node_modules/lib0/webcrypto.node.js"() {
    import_node_crypto = require("node:crypto");
    subtle = /** @type {any} */
    import_node_crypto.webcrypto.subtle;
    getRandomValues = /** @type {any} */
    import_node_crypto.webcrypto.getRandomValues.bind(import_node_crypto.webcrypto);
  }
});

// node_modules/lib0/random.js
var uint32, uuidv4Template, uuidv4;
var init_random = __esm({
  "node_modules/lib0/random.js"() {
    init_webcrypto_node();
    uint32 = () => getRandomValues(new Uint32Array(1))[0];
    uuidv4Template = "10000000-1000-4000-8000" + -1e11;
    uuidv4 = () => uuidv4Template.replace(
      /[018]/g,
      /** @param {number} c */
      (c) => (c ^ uint32() & 15 >> c / 4).toString(16)
    );
  }
});

// node_modules/lib0/time.js
var getUnixTime;
var init_time = __esm({
  "node_modules/lib0/time.js"() {
    getUnixTime = Date.now;
  }
});

// node_modules/lib0/promise.js
var create4, all;
var init_promise = __esm({
  "node_modules/lib0/promise.js"() {
    create4 = (f) => (
      /** @type {Promise<T>} */
      new Promise(f)
    );
    all = Promise.all.bind(Promise);
  }
});

// node_modules/lib0/conditions.js
var undefinedToNull;
var init_conditions = __esm({
  "node_modules/lib0/conditions.js"() {
    undefinedToNull = (v) => v === void 0 ? null : v;
  }
});

// node_modules/lib0/storage.js
var VarStoragePolyfill, _localStorage, usePolyfill, varStorage;
var init_storage = __esm({
  "node_modules/lib0/storage.js"() {
    VarStoragePolyfill = class {
      constructor() {
        this.map = /* @__PURE__ */ new Map();
      }
      /**
       * @param {string} key
       * @param {any} newValue
       */
      setItem(key, newValue) {
        this.map.set(key, newValue);
      }
      /**
       * @param {string} key
       */
      getItem(key) {
        return this.map.get(key);
      }
    };
    _localStorage = new VarStoragePolyfill();
    usePolyfill = true;
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        _localStorage = localStorage;
        usePolyfill = false;
      }
    } catch (e) {
    }
    varStorage = _localStorage;
  }
});

// node_modules/lib0/trait/equality.js
var EqualityTraitSymbol, equals;
var init_equality = __esm({
  "node_modules/lib0/trait/equality.js"() {
    EqualityTraitSymbol = Symbol("Equality");
    equals = (a, b) => a === b || !!a?.[EqualityTraitSymbol]?.(b) || false;
  }
});

// node_modules/lib0/object.js
var assign, keys, forEach, size, isEmpty, every, hasProperty, equalFlat, freeze, deepFreeze;
var init_object = __esm({
  "node_modules/lib0/object.js"() {
    init_equality();
    assign = Object.assign;
    keys = Object.keys;
    forEach = (obj, f) => {
      for (const key in obj) {
        f(obj[key], key);
      }
    };
    size = (obj) => keys(obj).length;
    isEmpty = (obj) => {
      for (const _k in obj) {
        return false;
      }
      return true;
    };
    every = (obj, f) => {
      for (const key in obj) {
        if (!f(obj[key], key)) {
          return false;
        }
      }
      return true;
    };
    hasProperty = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    equalFlat = (a, b) => a === b || size(a) === size(b) && every(a, (val, key) => (val !== void 0 || hasProperty(b, key)) && equals(b[key], val));
    freeze = Object.freeze;
    deepFreeze = (o) => {
      for (const key in o) {
        const c = o[key];
        if (typeof c === "object" || typeof c === "function") {
          deepFreeze(o[key]);
        }
      }
      return freeze(o);
    };
  }
});

// node_modules/lib0/function.js
var callAll, id, isOneOf;
var init_function = __esm({
  "node_modules/lib0/function.js"() {
    callAll = (fs, args2, i = 0) => {
      try {
        for (; i < fs.length; i++) {
          fs[i](...args2);
        }
      } finally {
        if (i < fs.length) {
          callAll(fs, args2, i + 1);
        }
      }
    };
    id = (a) => a;
    isOneOf = (value, options) => options.includes(value);
  }
});

// node_modules/lib0/environment.js
var isNode, isMac, params, args, computeParams, hasParam, getVariable, hasConf, production, forceColor, supportsColor;
var init_environment = __esm({
  "node_modules/lib0/environment.js"() {
    init_map();
    init_string();
    init_conditions();
    init_storage();
    init_function();
    isNode = typeof process !== "undefined" && process.release && /node|io\.js/.test(process.release.name) && Object.prototype.toString.call(typeof process !== "undefined" ? process : 0) === "[object process]";
    isMac = typeof navigator !== "undefined" ? /Mac/.test(navigator.platform) : false;
    args = [];
    computeParams = () => {
      if (params === void 0) {
        if (isNode) {
          params = create();
          const pargs = process.argv;
          let currParamName = null;
          for (let i = 0; i < pargs.length; i++) {
            const parg = pargs[i];
            if (parg[0] === "-") {
              if (currParamName !== null) {
                params.set(currParamName, "");
              }
              currParamName = parg;
            } else {
              if (currParamName !== null) {
                params.set(currParamName, parg);
                currParamName = null;
              } else {
                args.push(parg);
              }
            }
          }
          if (currParamName !== null) {
            params.set(currParamName, "");
          }
        } else if (typeof location === "object") {
          params = create();
          (location.search || "?").slice(1).split("&").forEach((kv) => {
            if (kv.length !== 0) {
              const [key, value] = kv.split("=");
              params.set(`--${fromCamelCase(key, "-")}`, value);
              params.set(`-${fromCamelCase(key, "-")}`, value);
            }
          });
        } else {
          params = create();
        }
      }
      return params;
    };
    hasParam = (name) => computeParams().has(name);
    getVariable = (name) => isNode ? undefinedToNull(process.env[name.toUpperCase().replaceAll("-", "_")]) : undefinedToNull(varStorage.getItem(name));
    hasConf = (name) => hasParam("--" + name) || getVariable(name) !== null;
    production = hasConf("production");
    forceColor = isNode && isOneOf(process.env.FORCE_COLOR, ["true", "1", "2"]);
    supportsColor = forceColor || !hasParam("--no-colors") && // @todo deprecate --no-colors
    !hasConf("no-color") && (!isNode || process.stdout.isTTY) && (!isNode || hasParam("--color") || getVariable("COLORTERM") !== null || (getVariable("TERM") || "").includes("color"));
  }
});

// node_modules/lib0/buffer.js
var createUint8ArrayFromLen, copyUint8Array;
var init_buffer = __esm({
  "node_modules/lib0/buffer.js"() {
    createUint8ArrayFromLen = (len) => new Uint8Array(len);
    copyUint8Array = (uint8Array) => {
      const newBuf = createUint8ArrayFromLen(uint8Array.byteLength);
      newBuf.set(uint8Array);
      return newBuf;
    };
  }
});

// node_modules/lib0/symbol.js
var create5;
var init_symbol = __esm({
  "node_modules/lib0/symbol.js"() {
    create5 = Symbol;
  }
});

// node_modules/lib0/logging.common.js
var BOLD, UNBOLD, BLUE, GREY, GREEN, RED, PURPLE, ORANGE, UNCOLOR, computeNoColorLoggingArgs, lastLoggingTime;
var init_logging_common = __esm({
  "node_modules/lib0/logging.common.js"() {
    init_symbol();
    init_time();
    BOLD = create5();
    UNBOLD = create5();
    BLUE = create5();
    GREY = create5();
    GREEN = create5();
    RED = create5();
    PURPLE = create5();
    ORANGE = create5();
    UNCOLOR = create5();
    computeNoColorLoggingArgs = (args2) => {
      if (args2.length === 1 && args2[0]?.constructor === Function) {
        args2 = /** @type {Array<string|Symbol|Object|number>} */
        /** @type {[function]} */
        args2[0]();
      }
      const strBuilder = [];
      const logArgs = [];
      let i = 0;
      for (; i < args2.length; i++) {
        const arg = args2[i];
        if (arg === void 0) {
          break;
        } else if (arg.constructor === String || arg.constructor === Number) {
          strBuilder.push(arg);
        } else if (arg.constructor === Object) {
          break;
        }
      }
      if (i > 0) {
        logArgs.push(strBuilder.join(""));
      }
      for (; i < args2.length; i++) {
        const arg = args2[i];
        if (!(arg instanceof Symbol)) {
          logArgs.push(arg);
        }
      }
      return logArgs;
    };
    lastLoggingTime = getUnixTime();
  }
});

// node_modules/lib0/logging.node.js
var _nodeStyleMap, computeNodeLoggingArgs, computeLoggingArgs, print, warn;
var init_logging_node = __esm({
  "node_modules/lib0/logging.node.js"() {
    init_environment();
    init_logging_common();
    init_logging_common();
    _nodeStyleMap = {
      [BOLD]: "\x1B[1m",
      [UNBOLD]: "\x1B[2m",
      [BLUE]: "\x1B[34m",
      [GREEN]: "\x1B[32m",
      [GREY]: "\x1B[37m",
      [RED]: "\x1B[31m",
      [PURPLE]: "\x1B[35m",
      [ORANGE]: "\x1B[38;5;208m",
      [UNCOLOR]: "\x1B[0m"
    };
    computeNodeLoggingArgs = (args2) => {
      if (args2.length === 1 && args2[0]?.constructor === Function) {
        args2 = /** @type {Array<string|Symbol|Object|number>} */
        /** @type {[function]} */
        args2[0]();
      }
      const strBuilder = [];
      const logArgs = [];
      let i = 0;
      for (; i < args2.length; i++) {
        const arg = args2[i];
        const style = _nodeStyleMap[arg];
        if (style !== void 0) {
          strBuilder.push(style);
        } else {
          if (arg === void 0) {
            break;
          } else if (arg.constructor === String || arg.constructor === Number) {
            strBuilder.push(arg);
          } else {
            break;
          }
        }
      }
      if (i > 0) {
        strBuilder.push("\x1B[0m");
        logArgs.push(strBuilder.join(""));
      }
      for (; i < args2.length; i++) {
        const arg = args2[i];
        if (!(arg instanceof Symbol)) {
          logArgs.push(arg);
        }
      }
      return logArgs;
    };
    computeLoggingArgs = supportsColor ? computeNodeLoggingArgs : computeNoColorLoggingArgs;
    print = (...args2) => {
      console.log(...computeLoggingArgs(args2));
    };
    warn = (...args2) => {
      console.warn(...computeLoggingArgs(args2));
    };
  }
});

// node_modules/lib0/iterator.js
var createIterator, iteratorFilter, iteratorMap;
var init_iterator = __esm({
  "node_modules/lib0/iterator.js"() {
    createIterator = (next) => ({
      /**
       * @return {IterableIterator<T>}
       */
      [Symbol.iterator]() {
        return this;
      },
      // @ts-ignore
      next
    });
    iteratorFilter = (iterator, filter) => createIterator(() => {
      let res;
      do {
        res = iterator.next();
      } while (!res.done && !filter(res.value));
      return res;
    });
    iteratorMap = (iterator, fmap) => createIterator(() => {
      const { done, value } = iterator.next();
      return { done, value: done ? void 0 : fmap(value) };
    });
  }
});

// node_modules/yjs/dist/yjs.mjs
var yjs_exports = {};
__export(yjs_exports, {
  AbsolutePosition: () => AbsolutePosition,
  AbstractConnector: () => AbstractConnector,
  AbstractStruct: () => AbstractStruct,
  AbstractType: () => AbstractType,
  Array: () => YArray,
  ContentAny: () => ContentAny,
  ContentBinary: () => ContentBinary,
  ContentDeleted: () => ContentDeleted,
  ContentDoc: () => ContentDoc,
  ContentEmbed: () => ContentEmbed,
  ContentFormat: () => ContentFormat,
  ContentJSON: () => ContentJSON,
  ContentString: () => ContentString,
  ContentType: () => ContentType,
  Doc: () => Doc,
  GC: () => GC,
  ID: () => ID,
  Item: () => Item,
  Map: () => YMap,
  PermanentUserData: () => PermanentUserData,
  RelativePosition: () => RelativePosition,
  Skip: () => Skip,
  Snapshot: () => Snapshot,
  Text: () => YText,
  Transaction: () => Transaction,
  UndoManager: () => UndoManager,
  UpdateDecoderV1: () => UpdateDecoderV1,
  UpdateDecoderV2: () => UpdateDecoderV2,
  UpdateEncoderV1: () => UpdateEncoderV1,
  UpdateEncoderV2: () => UpdateEncoderV2,
  XmlElement: () => YXmlElement,
  XmlFragment: () => YXmlFragment,
  XmlHook: () => YXmlHook,
  XmlText: () => YXmlText,
  YArrayEvent: () => YArrayEvent,
  YEvent: () => YEvent,
  YMapEvent: () => YMapEvent,
  YTextEvent: () => YTextEvent,
  YXmlEvent: () => YXmlEvent,
  applyUpdate: () => applyUpdate,
  applyUpdateV2: () => applyUpdateV2,
  cleanupYTextFormatting: () => cleanupYTextFormatting,
  compareIDs: () => compareIDs,
  compareRelativePositions: () => compareRelativePositions,
  convertUpdateFormatV1ToV2: () => convertUpdateFormatV1ToV2,
  convertUpdateFormatV2ToV1: () => convertUpdateFormatV2ToV1,
  createAbsolutePositionFromRelativePosition: () => createAbsolutePositionFromRelativePosition,
  createDeleteSet: () => createDeleteSet,
  createDeleteSetFromStructStore: () => createDeleteSetFromStructStore,
  createDocFromSnapshot: () => createDocFromSnapshot,
  createID: () => createID,
  createRelativePositionFromJSON: () => createRelativePositionFromJSON,
  createRelativePositionFromTypeIndex: () => createRelativePositionFromTypeIndex,
  createSnapshot: () => createSnapshot,
  decodeRelativePosition: () => decodeRelativePosition,
  decodeSnapshot: () => decodeSnapshot,
  decodeSnapshotV2: () => decodeSnapshotV2,
  decodeStateVector: () => decodeStateVector,
  decodeUpdate: () => decodeUpdate,
  decodeUpdateV2: () => decodeUpdateV2,
  diffUpdate: () => diffUpdate,
  diffUpdateV2: () => diffUpdateV2,
  emptySnapshot: () => emptySnapshot,
  encodeRelativePosition: () => encodeRelativePosition,
  encodeSnapshot: () => encodeSnapshot,
  encodeSnapshotV2: () => encodeSnapshotV2,
  encodeStateAsUpdate: () => encodeStateAsUpdate,
  encodeStateAsUpdateV2: () => encodeStateAsUpdateV2,
  encodeStateVector: () => encodeStateVector,
  encodeStateVectorFromUpdate: () => encodeStateVectorFromUpdate,
  encodeStateVectorFromUpdateV2: () => encodeStateVectorFromUpdateV2,
  equalDeleteSets: () => equalDeleteSets,
  equalSnapshots: () => equalSnapshots,
  findIndexSS: () => findIndexSS,
  findRootTypeKey: () => findRootTypeKey,
  getItem: () => getItem,
  getItemCleanEnd: () => getItemCleanEnd,
  getItemCleanStart: () => getItemCleanStart,
  getState: () => getState,
  getTypeChildren: () => getTypeChildren,
  isDeleted: () => isDeleted,
  isParentOf: () => isParentOf,
  iterateDeletedStructs: () => iterateDeletedStructs,
  logType: () => logType,
  logUpdate: () => logUpdate,
  logUpdateV2: () => logUpdateV2,
  mergeDeleteSets: () => mergeDeleteSets,
  mergeUpdates: () => mergeUpdates,
  mergeUpdatesV2: () => mergeUpdatesV2,
  obfuscateUpdate: () => obfuscateUpdate,
  obfuscateUpdateV2: () => obfuscateUpdateV2,
  parseUpdateMeta: () => parseUpdateMeta,
  parseUpdateMetaV2: () => parseUpdateMetaV2,
  readUpdate: () => readUpdate,
  readUpdateV2: () => readUpdateV2,
  relativePositionToJSON: () => relativePositionToJSON,
  snapshot: () => snapshot,
  snapshotContainsUpdate: () => snapshotContainsUpdate,
  transact: () => transact,
  tryGc: () => tryGc,
  typeListToArraySnapshot: () => typeListToArraySnapshot,
  typeMapGetAllSnapshot: () => typeMapGetAllSnapshot,
  typeMapGetSnapshot: () => typeMapGetSnapshot
});
function* lazyStructReaderGenerator(decoder) {
  const numOfStateUpdates = readVarUint(decoder.restDecoder);
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = readVarUint(decoder.restDecoder);
    const client = decoder.readClient();
    let clock = readVarUint(decoder.restDecoder);
    for (let i2 = 0; i2 < numberOfStructs; i2++) {
      const info = decoder.readInfo();
      if (info === 10) {
        const len = readVarUint(decoder.restDecoder);
        yield new Skip(createID(client, clock), len);
        clock += len;
      } else if ((BITS5 & info) !== 0) {
        const cantCopyParentInfo = (info & (BIT7 | BIT8)) === 0;
        const struct = new Item(
          createID(client, clock),
          null,
          // left
          (info & BIT8) === BIT8 ? decoder.readLeftID() : null,
          // origin
          null,
          // right
          (info & BIT7) === BIT7 ? decoder.readRightID() : null,
          // right origin
          // @ts-ignore Force writing a string here.
          cantCopyParentInfo ? decoder.readParentInfo() ? decoder.readString() : decoder.readLeftID() : null,
          // parent
          cantCopyParentInfo && (info & BIT6) === BIT6 ? decoder.readString() : null,
          // parentSub
          readItemContent(decoder, info)
          // item content
        );
        yield struct;
        clock += struct.length;
      } else {
        const len = decoder.readLen();
        yield new GC(createID(client, clock), len);
        clock += len;
      }
    }
  }
}
var AbstractConnector, DeleteItem, DeleteSet, iterateDeletedStructs, findIndexDS, isDeleted, sortAndMergeDeleteSet, mergeDeleteSets, addToDeleteSet, createDeleteSet, createDeleteSetFromStructStore, writeDeleteSet, readDeleteSet, readAndApplyDeleteSet, equalDeleteSets, generateNewClientId, Doc, DSDecoderV1, UpdateDecoderV1, DSDecoderV2, UpdateDecoderV2, DSEncoderV1, UpdateEncoderV1, DSEncoderV2, UpdateEncoderV2, writeStructs, writeClientsStructs, readClientsStructRefs, integrateStructs, writeStructsFromTransaction, readUpdateV2, readUpdate, applyUpdateV2, applyUpdate, writeStateAsUpdate, encodeStateAsUpdateV2, encodeStateAsUpdate, readStateVector, decodeStateVector, writeStateVector, writeDocumentStateVector, encodeStateVectorV2, encodeStateVector, EventHandler, createEventHandler, addEventHandlerListener, removeEventHandlerListener, callEventHandlerListeners, ID, compareIDs, createID, writeID, readID, findRootTypeKey, isParentOf, logType, PermanentUserData, RelativePosition, relativePositionToJSON, createRelativePositionFromJSON, AbsolutePosition, createAbsolutePosition, createRelativePosition, createRelativePositionFromTypeIndex, writeRelativePosition, encodeRelativePosition, readRelativePosition, decodeRelativePosition, getItemWithOffset, createAbsolutePositionFromRelativePosition, compareRelativePositions, Snapshot, equalSnapshots, encodeSnapshotV2, encodeSnapshot, decodeSnapshotV2, decodeSnapshot, createSnapshot, emptySnapshot, snapshot, isVisible, splitSnapshotAffectedStructs, createDocFromSnapshot, snapshotContainsUpdateV2, snapshotContainsUpdate, StructStore, getStateVector, getState, addStruct, findIndexSS, find, getItem, findIndexCleanStart, getItemCleanStart, getItemCleanEnd, replaceStruct, iterateStructs, Transaction, writeUpdateMessageFromTransaction, addChangedTypeToTransaction, tryToMergeWithLefts, tryGcDeleteSet, tryMergeDeleteSet, tryGc, cleanupTransactions, transact, StackItem, clearUndoManagerStackItem, popStackItem, UndoManager, LazyStructReader, logUpdate, logUpdateV2, decodeUpdate, decodeUpdateV2, LazyStructWriter, mergeUpdates, encodeStateVectorFromUpdateV2, encodeStateVectorFromUpdate, parseUpdateMetaV2, parseUpdateMeta, sliceStruct, mergeUpdatesV2, diffUpdateV2, diffUpdate, flushLazyStructWriter, writeStructToLazyStructWriter, finishLazyStructWriting, convertUpdateFormat, createObfuscator, obfuscateUpdate, obfuscateUpdateV2, convertUpdateFormatV1ToV2, convertUpdateFormatV2ToV1, errorComputeChanges, YEvent, getPathTo, warnPrematureAccess, maxSearchMarker, globalSearchMarkerTimestamp, ArraySearchMarker, refreshMarkerTimestamp, overwriteMarker, markPosition, findMarker, updateMarkerChanges, getTypeChildren, callTypeObservers, AbstractType, typeListSlice, typeListToArray, typeListToArraySnapshot, typeListForEach, typeListMap, typeListCreateIterator, typeListGet, typeListInsertGenericsAfter, lengthExceeded, typeListInsertGenerics, typeListPushGenerics, typeListDelete, typeMapDelete, typeMapSet, typeMapGet, typeMapGetAll, typeMapHas, typeMapGetSnapshot, typeMapGetAllSnapshot, createMapIterator, YArrayEvent, YArray, readYArray, YMapEvent, YMap, readYMap, equalAttrs, ItemTextListPosition, findNextPosition, findPosition, insertNegatedAttributes, updateCurrentAttributes, minimizeAttributeChanges, insertAttributes, insertText, formatText, cleanupFormattingGap, cleanupContextlessFormattingGap, cleanupYTextFormatting, cleanupYTextAfterTransaction, deleteText, YTextEvent, YText, readYText, YXmlTreeWalker, YXmlFragment, readYXmlFragment, YXmlElement, readYXmlElement, YXmlEvent, YXmlHook, readYXmlHook, YXmlText, readYXmlText, AbstractStruct, structGCRefNumber, GC, ContentBinary, readContentBinary, ContentDeleted, readContentDeleted, createDocFromOpts, ContentDoc, readContentDoc, ContentEmbed, readContentEmbed, ContentFormat, readContentFormat, ContentJSON, readContentJSON, isDevMode, ContentAny, readContentAny, ContentString, readContentString, typeRefs, YArrayRefID, YMapRefID, YTextRefID, YXmlElementRefID, YXmlFragmentRefID, YXmlHookRefID, YXmlTextRefID, ContentType, readContentType, followRedone, keepItem, splitItem, isDeletedByUndoStack, redoItem, Item, readItemContent, contentRefs, structSkipRefNumber, Skip, glo, importIdentifier;
var init_yjs = __esm({
  "node_modules/yjs/dist/yjs.mjs"() {
    init_observable();
    init_array();
    init_math();
    init_map();
    init_encoding();
    init_decoding();
    init_random();
    init_promise();
    init_buffer();
    init_error();
    init_binary();
    init_function();
    init_function();
    init_set();
    init_logging_node();
    init_time();
    init_string();
    init_iterator();
    init_object();
    init_environment();
    AbstractConnector = class extends ObservableV2 {
      /**
       * @param {Doc} ydoc
       * @param {any} awareness
       */
      constructor(ydoc, awareness) {
        super();
        this.doc = ydoc;
        this.awareness = awareness;
      }
    };
    DeleteItem = class {
      /**
       * @param {number} clock
       * @param {number} len
       */
      constructor(clock, len) {
        this.clock = clock;
        this.len = len;
      }
    };
    DeleteSet = class {
      constructor() {
        this.clients = /* @__PURE__ */ new Map();
      }
    };
    iterateDeletedStructs = (transaction, ds, f) => ds.clients.forEach((deletes, clientid) => {
      const structs = (
        /** @type {Array<GC|Item>} */
        transaction.doc.store.clients.get(clientid)
      );
      if (structs != null) {
        const lastStruct = structs[structs.length - 1];
        const clockState = lastStruct.id.clock + lastStruct.length;
        for (let i = 0, del = deletes[i]; i < deletes.length && del.clock < clockState; del = deletes[++i]) {
          iterateStructs(transaction, structs, del.clock, del.len, f);
        }
      }
    });
    findIndexDS = (dis, clock) => {
      let left = 0;
      let right = dis.length - 1;
      while (left <= right) {
        const midindex = floor((left + right) / 2);
        const mid = dis[midindex];
        const midclock = mid.clock;
        if (midclock <= clock) {
          if (clock < midclock + mid.len) {
            return midindex;
          }
          left = midindex + 1;
        } else {
          right = midindex - 1;
        }
      }
      return null;
    };
    isDeleted = (ds, id2) => {
      const dis = ds.clients.get(id2.client);
      return dis !== void 0 && findIndexDS(dis, id2.clock) !== null;
    };
    sortAndMergeDeleteSet = (ds) => {
      ds.clients.forEach((dels) => {
        dels.sort((a, b) => a.clock - b.clock);
        let i, j;
        for (i = 1, j = 1; i < dels.length; i++) {
          const left = dels[j - 1];
          const right = dels[i];
          if (left.clock + left.len >= right.clock) {
            dels[j - 1] = new DeleteItem(left.clock, max(left.len, right.clock + right.len - left.clock));
          } else {
            if (j < i) {
              dels[j] = right;
            }
            j++;
          }
        }
        dels.length = j;
      });
    };
    mergeDeleteSets = (dss) => {
      const merged = new DeleteSet();
      for (let dssI = 0; dssI < dss.length; dssI++) {
        dss[dssI].clients.forEach((delsLeft, client) => {
          if (!merged.clients.has(client)) {
            const dels = delsLeft.slice();
            for (let i = dssI + 1; i < dss.length; i++) {
              appendTo(dels, dss[i].clients.get(client) || []);
            }
            merged.clients.set(client, dels);
          }
        });
      }
      sortAndMergeDeleteSet(merged);
      return merged;
    };
    addToDeleteSet = (ds, client, clock, length2) => {
      setIfUndefined(ds.clients, client, () => (
        /** @type {Array<DeleteItem>} */
        []
      )).push(new DeleteItem(clock, length2));
    };
    createDeleteSet = () => new DeleteSet();
    createDeleteSetFromStructStore = (ss) => {
      const ds = createDeleteSet();
      ss.clients.forEach((structs, client) => {
        const dsitems = [];
        for (let i = 0; i < structs.length; i++) {
          const struct = structs[i];
          if (struct.deleted) {
            const clock = struct.id.clock;
            let len = struct.length;
            if (i + 1 < structs.length) {
              for (let next = structs[i + 1]; i + 1 < structs.length && next.deleted; next = structs[++i + 1]) {
                len += next.length;
              }
            }
            dsitems.push(new DeleteItem(clock, len));
          }
        }
        if (dsitems.length > 0) {
          ds.clients.set(client, dsitems);
        }
      });
      return ds;
    };
    writeDeleteSet = (encoder, ds) => {
      writeVarUint(encoder.restEncoder, ds.clients.size);
      from(ds.clients.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, dsitems]) => {
        encoder.resetDsCurVal();
        writeVarUint(encoder.restEncoder, client);
        const len = dsitems.length;
        writeVarUint(encoder.restEncoder, len);
        for (let i = 0; i < len; i++) {
          const item = dsitems[i];
          encoder.writeDsClock(item.clock);
          encoder.writeDsLen(item.len);
        }
      });
    };
    readDeleteSet = (decoder) => {
      const ds = new DeleteSet();
      const numClients = readVarUint(decoder.restDecoder);
      for (let i = 0; i < numClients; i++) {
        decoder.resetDsCurVal();
        const client = readVarUint(decoder.restDecoder);
        const numberOfDeletes = readVarUint(decoder.restDecoder);
        if (numberOfDeletes > 0) {
          const dsField = setIfUndefined(ds.clients, client, () => (
            /** @type {Array<DeleteItem>} */
            []
          ));
          for (let i2 = 0; i2 < numberOfDeletes; i2++) {
            dsField.push(new DeleteItem(decoder.readDsClock(), decoder.readDsLen()));
          }
        }
      }
      return ds;
    };
    readAndApplyDeleteSet = (decoder, transaction, store) => {
      const unappliedDS = new DeleteSet();
      const numClients = readVarUint(decoder.restDecoder);
      for (let i = 0; i < numClients; i++) {
        decoder.resetDsCurVal();
        const client = readVarUint(decoder.restDecoder);
        const numberOfDeletes = readVarUint(decoder.restDecoder);
        const structs = store.clients.get(client) || [];
        const state = getState(store, client);
        for (let i2 = 0; i2 < numberOfDeletes; i2++) {
          const clock = decoder.readDsClock();
          const clockEnd = clock + decoder.readDsLen();
          if (clock < state) {
            if (state < clockEnd) {
              addToDeleteSet(unappliedDS, client, state, clockEnd - state);
            }
            let index = findIndexSS(structs, clock);
            let struct = structs[index];
            if (!struct.deleted && struct.id.clock < clock) {
              structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
              index++;
            }
            while (index < structs.length) {
              struct = structs[index++];
              if (struct.id.clock < clockEnd) {
                if (!struct.deleted) {
                  if (clockEnd < struct.id.clock + struct.length) {
                    structs.splice(index, 0, splitItem(transaction, struct, clockEnd - struct.id.clock));
                  }
                  struct.delete(transaction);
                }
              } else {
                break;
              }
            }
          } else {
            addToDeleteSet(unappliedDS, client, clock, clockEnd - clock);
          }
        }
      }
      if (unappliedDS.clients.size > 0) {
        const ds = new UpdateEncoderV2();
        writeVarUint(ds.restEncoder, 0);
        writeDeleteSet(ds, unappliedDS);
        return ds.toUint8Array();
      }
      return null;
    };
    equalDeleteSets = (ds1, ds2) => {
      if (ds1.clients.size !== ds2.clients.size) return false;
      for (const [client, deleteItems1] of ds1.clients.entries()) {
        const deleteItems2 = (
          /** @type {Array<import('../internals.js').DeleteItem>} */
          ds2.clients.get(client)
        );
        if (deleteItems2 === void 0 || deleteItems1.length !== deleteItems2.length) return false;
        for (let i = 0; i < deleteItems1.length; i++) {
          const di1 = deleteItems1[i];
          const di2 = deleteItems2[i];
          if (di1.clock !== di2.clock || di1.len !== di2.len) {
            return false;
          }
        }
      }
      return true;
    };
    generateNewClientId = uint32;
    Doc = class _Doc extends ObservableV2 {
      /**
       * @param {DocOpts} opts configuration
       */
      constructor({ guid = uuidv4(), collectionid = null, gc = true, gcFilter = () => true, meta = null, autoLoad = false, shouldLoad = true } = {}) {
        super();
        this.gc = gc;
        this.gcFilter = gcFilter;
        this.clientID = generateNewClientId();
        this.guid = guid;
        this.collectionid = collectionid;
        this.share = /* @__PURE__ */ new Map();
        this.store = new StructStore();
        this._transaction = null;
        this._transactionCleanups = [];
        this.subdocs = /* @__PURE__ */ new Set();
        this._item = null;
        this.shouldLoad = shouldLoad;
        this.autoLoad = autoLoad;
        this.meta = meta;
        this.isLoaded = false;
        this.isSynced = false;
        this.isDestroyed = false;
        this.whenLoaded = create4((resolve) => {
          this.on("load", () => {
            this.isLoaded = true;
            resolve(this);
          });
        });
        const provideSyncedPromise = () => create4((resolve) => {
          const eventHandler = (isSynced) => {
            if (isSynced === void 0 || isSynced === true) {
              this.off("sync", eventHandler);
              resolve();
            }
          };
          this.on("sync", eventHandler);
        });
        this.on("sync", (isSynced) => {
          if (isSynced === false && this.isSynced) {
            this.whenSynced = provideSyncedPromise();
          }
          this.isSynced = isSynced === void 0 || isSynced === true;
          if (this.isSynced && !this.isLoaded) {
            this.emit("load", [this]);
          }
        });
        this.whenSynced = provideSyncedPromise();
      }
      /**
       * Notify the parent document that you request to load data into this subdocument (if it is a subdocument).
       *
       * `load()` might be used in the future to request any provider to load the most current data.
       *
       * It is safe to call `load()` multiple times.
       */
      load() {
        const item = this._item;
        if (item !== null && !this.shouldLoad) {
          transact(
            /** @type {any} */
            item.parent.doc,
            (transaction) => {
              transaction.subdocsLoaded.add(this);
            },
            null,
            true
          );
        }
        this.shouldLoad = true;
      }
      getSubdocs() {
        return this.subdocs;
      }
      getSubdocGuids() {
        return new Set(from(this.subdocs).map((doc) => doc.guid));
      }
      /**
       * Changes that happen inside of a transaction are bundled. This means that
       * the observer fires _after_ the transaction is finished and that all changes
       * that happened inside of the transaction are sent as one message to the
       * other peers.
       *
       * @template T
       * @param {function(Transaction):T} f The function that should be executed as a transaction
       * @param {any} [origin] Origin of who started the transaction. Will be stored on transaction.origin
       * @return T
       *
       * @public
       */
      transact(f, origin = null) {
        return transact(this, f, origin);
      }
      /**
       * Define a shared data type.
       *
       * Multiple calls of `ydoc.get(name, TypeConstructor)` yield the same result
       * and do not overwrite each other. I.e.
       * `ydoc.get(name, Y.Array) === ydoc.get(name, Y.Array)`
       *
       * After this method is called, the type is also available on `ydoc.share.get(name)`.
       *
       * *Best Practices:*
       * Define all types right after the Y.Doc instance is created and store them in a separate object.
       * Also use the typed methods `getText(name)`, `getArray(name)`, ..
       *
       * @template {typeof AbstractType<any>} Type
       * @example
       *   const ydoc = new Y.Doc(..)
       *   const appState = {
       *     document: ydoc.getText('document')
       *     comments: ydoc.getArray('comments')
       *   }
       *
       * @param {string} name
       * @param {Type} TypeConstructor The constructor of the type definition. E.g. Y.Text, Y.Array, Y.Map, ...
       * @return {InstanceType<Type>} The created type. Constructed with TypeConstructor
       *
       * @public
       */
      get(name, TypeConstructor = (
        /** @type {any} */
        AbstractType
      )) {
        const type = setIfUndefined(this.share, name, () => {
          const t = new TypeConstructor();
          t._integrate(this, null);
          return t;
        });
        const Constr = type.constructor;
        if (TypeConstructor !== AbstractType && Constr !== TypeConstructor) {
          if (Constr === AbstractType) {
            const t = new TypeConstructor();
            t._map = type._map;
            type._map.forEach(
              /** @param {Item?} n */
              (n) => {
                for (; n !== null; n = n.left) {
                  n.parent = t;
                }
              }
            );
            t._start = type._start;
            for (let n = t._start; n !== null; n = n.right) {
              n.parent = t;
            }
            t._length = type._length;
            this.share.set(name, t);
            t._integrate(this, null);
            return (
              /** @type {InstanceType<Type>} */
              t
            );
          } else {
            throw new Error(`Type with the name ${name} has already been defined with a different constructor`);
          }
        }
        return (
          /** @type {InstanceType<Type>} */
          type
        );
      }
      /**
       * @template T
       * @param {string} [name]
       * @return {YArray<T>}
       *
       * @public
       */
      getArray(name = "") {
        return (
          /** @type {YArray<T>} */
          this.get(name, YArray)
        );
      }
      /**
       * @param {string} [name]
       * @return {YText}
       *
       * @public
       */
      getText(name = "") {
        return this.get(name, YText);
      }
      /**
       * @template T
       * @param {string} [name]
       * @return {YMap<T>}
       *
       * @public
       */
      getMap(name = "") {
        return (
          /** @type {YMap<T>} */
          this.get(name, YMap)
        );
      }
      /**
       * @param {string} [name]
       * @return {YXmlElement}
       *
       * @public
       */
      getXmlElement(name = "") {
        return (
          /** @type {YXmlElement<{[key:string]:string}>} */
          this.get(name, YXmlElement)
        );
      }
      /**
       * @param {string} [name]
       * @return {YXmlFragment}
       *
       * @public
       */
      getXmlFragment(name = "") {
        return this.get(name, YXmlFragment);
      }
      /**
       * Converts the entire document into a js object, recursively traversing each yjs type
       * Doesn't log types that have not been defined (using ydoc.getType(..)).
       *
       * @deprecated Do not use this method and rather call toJSON directly on the shared types.
       *
       * @return {Object<string, any>}
       */
      toJSON() {
        const doc = {};
        this.share.forEach((value, key) => {
          doc[key] = value.toJSON();
        });
        return doc;
      }
      /**
       * Emit `destroy` event and unregister all event handlers.
       */
      destroy() {
        this.isDestroyed = true;
        from(this.subdocs).forEach((subdoc) => subdoc.destroy());
        const item = this._item;
        if (item !== null) {
          this._item = null;
          const content = (
            /** @type {ContentDoc} */
            item.content
          );
          content.doc = new _Doc({ guid: this.guid, ...content.opts, shouldLoad: false });
          content.doc._item = item;
          transact(
            /** @type {any} */
            item.parent.doc,
            (transaction) => {
              const doc = content.doc;
              if (!item.deleted) {
                transaction.subdocsAdded.add(doc);
              }
              transaction.subdocsRemoved.add(this);
            },
            null,
            true
          );
        }
        this.emit("destroyed", [true]);
        this.emit("destroy", [this]);
        super.destroy();
      }
    };
    DSDecoderV1 = class {
      /**
       * @param {decoding.Decoder} decoder
       */
      constructor(decoder) {
        this.restDecoder = decoder;
      }
      resetDsCurVal() {
      }
      /**
       * @return {number}
       */
      readDsClock() {
        return readVarUint(this.restDecoder);
      }
      /**
       * @return {number}
       */
      readDsLen() {
        return readVarUint(this.restDecoder);
      }
    };
    UpdateDecoderV1 = class extends DSDecoderV1 {
      /**
       * @return {ID}
       */
      readLeftID() {
        return createID(readVarUint(this.restDecoder), readVarUint(this.restDecoder));
      }
      /**
       * @return {ID}
       */
      readRightID() {
        return createID(readVarUint(this.restDecoder), readVarUint(this.restDecoder));
      }
      /**
       * Read the next client id.
       * Use this in favor of readID whenever possible to reduce the number of objects created.
       */
      readClient() {
        return readVarUint(this.restDecoder);
      }
      /**
       * @return {number} info An unsigned 8-bit integer
       */
      readInfo() {
        return readUint8(this.restDecoder);
      }
      /**
       * @return {string}
       */
      readString() {
        return readVarString(this.restDecoder);
      }
      /**
       * @return {boolean} isKey
       */
      readParentInfo() {
        return readVarUint(this.restDecoder) === 1;
      }
      /**
       * @return {number} info An unsigned 8-bit integer
       */
      readTypeRef() {
        return readVarUint(this.restDecoder);
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @return {number} len
       */
      readLen() {
        return readVarUint(this.restDecoder);
      }
      /**
       * @return {any}
       */
      readAny() {
        return readAny(this.restDecoder);
      }
      /**
       * @return {Uint8Array}
       */
      readBuf() {
        return copyUint8Array(readVarUint8Array(this.restDecoder));
      }
      /**
       * Legacy implementation uses JSON parse. We use any-decoding in v2.
       *
       * @return {any}
       */
      readJSON() {
        return JSON.parse(readVarString(this.restDecoder));
      }
      /**
       * @return {string}
       */
      readKey() {
        return readVarString(this.restDecoder);
      }
    };
    DSDecoderV2 = class {
      /**
       * @param {decoding.Decoder} decoder
       */
      constructor(decoder) {
        this.dsCurrVal = 0;
        this.restDecoder = decoder;
      }
      resetDsCurVal() {
        this.dsCurrVal = 0;
      }
      /**
       * @return {number}
       */
      readDsClock() {
        this.dsCurrVal += readVarUint(this.restDecoder);
        return this.dsCurrVal;
      }
      /**
       * @return {number}
       */
      readDsLen() {
        const diff = readVarUint(this.restDecoder) + 1;
        this.dsCurrVal += diff;
        return diff;
      }
    };
    UpdateDecoderV2 = class extends DSDecoderV2 {
      /**
       * @param {decoding.Decoder} decoder
       */
      constructor(decoder) {
        super(decoder);
        this.keys = [];
        readVarUint(decoder);
        this.keyClockDecoder = new IntDiffOptRleDecoder(readVarUint8Array(decoder));
        this.clientDecoder = new UintOptRleDecoder(readVarUint8Array(decoder));
        this.leftClockDecoder = new IntDiffOptRleDecoder(readVarUint8Array(decoder));
        this.rightClockDecoder = new IntDiffOptRleDecoder(readVarUint8Array(decoder));
        this.infoDecoder = new RleDecoder(readVarUint8Array(decoder), readUint8);
        this.stringDecoder = new StringDecoder(readVarUint8Array(decoder));
        this.parentInfoDecoder = new RleDecoder(readVarUint8Array(decoder), readUint8);
        this.typeRefDecoder = new UintOptRleDecoder(readVarUint8Array(decoder));
        this.lenDecoder = new UintOptRleDecoder(readVarUint8Array(decoder));
      }
      /**
       * @return {ID}
       */
      readLeftID() {
        return new ID(this.clientDecoder.read(), this.leftClockDecoder.read());
      }
      /**
       * @return {ID}
       */
      readRightID() {
        return new ID(this.clientDecoder.read(), this.rightClockDecoder.read());
      }
      /**
       * Read the next client id.
       * Use this in favor of readID whenever possible to reduce the number of objects created.
       */
      readClient() {
        return this.clientDecoder.read();
      }
      /**
       * @return {number} info An unsigned 8-bit integer
       */
      readInfo() {
        return (
          /** @type {number} */
          this.infoDecoder.read()
        );
      }
      /**
       * @return {string}
       */
      readString() {
        return this.stringDecoder.read();
      }
      /**
       * @return {boolean}
       */
      readParentInfo() {
        return this.parentInfoDecoder.read() === 1;
      }
      /**
       * @return {number} An unsigned 8-bit integer
       */
      readTypeRef() {
        return this.typeRefDecoder.read();
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @return {number}
       */
      readLen() {
        return this.lenDecoder.read();
      }
      /**
       * @return {any}
       */
      readAny() {
        return readAny(this.restDecoder);
      }
      /**
       * @return {Uint8Array}
       */
      readBuf() {
        return readVarUint8Array(this.restDecoder);
      }
      /**
       * This is mainly here for legacy purposes.
       *
       * Initial we incoded objects using JSON. Now we use the much faster lib0/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
       *
       * @return {any}
       */
      readJSON() {
        return readAny(this.restDecoder);
      }
      /**
       * @return {string}
       */
      readKey() {
        const keyClock = this.keyClockDecoder.read();
        if (keyClock < this.keys.length) {
          return this.keys[keyClock];
        } else {
          const key = this.stringDecoder.read();
          this.keys.push(key);
          return key;
        }
      }
    };
    DSEncoderV1 = class {
      constructor() {
        this.restEncoder = createEncoder();
      }
      toUint8Array() {
        return toUint8Array(this.restEncoder);
      }
      resetDsCurVal() {
      }
      /**
       * @param {number} clock
       */
      writeDsClock(clock) {
        writeVarUint(this.restEncoder, clock);
      }
      /**
       * @param {number} len
       */
      writeDsLen(len) {
        writeVarUint(this.restEncoder, len);
      }
    };
    UpdateEncoderV1 = class extends DSEncoderV1 {
      /**
       * @param {ID} id
       */
      writeLeftID(id2) {
        writeVarUint(this.restEncoder, id2.client);
        writeVarUint(this.restEncoder, id2.clock);
      }
      /**
       * @param {ID} id
       */
      writeRightID(id2) {
        writeVarUint(this.restEncoder, id2.client);
        writeVarUint(this.restEncoder, id2.clock);
      }
      /**
       * Use writeClient and writeClock instead of writeID if possible.
       * @param {number} client
       */
      writeClient(client) {
        writeVarUint(this.restEncoder, client);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeInfo(info) {
        writeUint8(this.restEncoder, info);
      }
      /**
       * @param {string} s
       */
      writeString(s) {
        writeVarString(this.restEncoder, s);
      }
      /**
       * @param {boolean} isYKey
       */
      writeParentInfo(isYKey) {
        writeVarUint(this.restEncoder, isYKey ? 1 : 0);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeTypeRef(info) {
        writeVarUint(this.restEncoder, info);
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @param {number} len
       */
      writeLen(len) {
        writeVarUint(this.restEncoder, len);
      }
      /**
       * @param {any} any
       */
      writeAny(any2) {
        writeAny(this.restEncoder, any2);
      }
      /**
       * @param {Uint8Array} buf
       */
      writeBuf(buf) {
        writeVarUint8Array(this.restEncoder, buf);
      }
      /**
       * @param {any} embed
       */
      writeJSON(embed) {
        writeVarString(this.restEncoder, JSON.stringify(embed));
      }
      /**
       * @param {string} key
       */
      writeKey(key) {
        writeVarString(this.restEncoder, key);
      }
    };
    DSEncoderV2 = class {
      constructor() {
        this.restEncoder = createEncoder();
        this.dsCurrVal = 0;
      }
      toUint8Array() {
        return toUint8Array(this.restEncoder);
      }
      resetDsCurVal() {
        this.dsCurrVal = 0;
      }
      /**
       * @param {number} clock
       */
      writeDsClock(clock) {
        const diff = clock - this.dsCurrVal;
        this.dsCurrVal = clock;
        writeVarUint(this.restEncoder, diff);
      }
      /**
       * @param {number} len
       */
      writeDsLen(len) {
        if (len === 0) {
          unexpectedCase();
        }
        writeVarUint(this.restEncoder, len - 1);
        this.dsCurrVal += len;
      }
    };
    UpdateEncoderV2 = class extends DSEncoderV2 {
      constructor() {
        super();
        this.keyMap = /* @__PURE__ */ new Map();
        this.keyClock = 0;
        this.keyClockEncoder = new IntDiffOptRleEncoder();
        this.clientEncoder = new UintOptRleEncoder();
        this.leftClockEncoder = new IntDiffOptRleEncoder();
        this.rightClockEncoder = new IntDiffOptRleEncoder();
        this.infoEncoder = new RleEncoder(writeUint8);
        this.stringEncoder = new StringEncoder();
        this.parentInfoEncoder = new RleEncoder(writeUint8);
        this.typeRefEncoder = new UintOptRleEncoder();
        this.lenEncoder = new UintOptRleEncoder();
      }
      toUint8Array() {
        const encoder = createEncoder();
        writeVarUint(encoder, 0);
        writeVarUint8Array(encoder, this.keyClockEncoder.toUint8Array());
        writeVarUint8Array(encoder, this.clientEncoder.toUint8Array());
        writeVarUint8Array(encoder, this.leftClockEncoder.toUint8Array());
        writeVarUint8Array(encoder, this.rightClockEncoder.toUint8Array());
        writeVarUint8Array(encoder, toUint8Array(this.infoEncoder));
        writeVarUint8Array(encoder, this.stringEncoder.toUint8Array());
        writeVarUint8Array(encoder, toUint8Array(this.parentInfoEncoder));
        writeVarUint8Array(encoder, this.typeRefEncoder.toUint8Array());
        writeVarUint8Array(encoder, this.lenEncoder.toUint8Array());
        writeUint8Array(encoder, toUint8Array(this.restEncoder));
        return toUint8Array(encoder);
      }
      /**
       * @param {ID} id
       */
      writeLeftID(id2) {
        this.clientEncoder.write(id2.client);
        this.leftClockEncoder.write(id2.clock);
      }
      /**
       * @param {ID} id
       */
      writeRightID(id2) {
        this.clientEncoder.write(id2.client);
        this.rightClockEncoder.write(id2.clock);
      }
      /**
       * @param {number} client
       */
      writeClient(client) {
        this.clientEncoder.write(client);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeInfo(info) {
        this.infoEncoder.write(info);
      }
      /**
       * @param {string} s
       */
      writeString(s) {
        this.stringEncoder.write(s);
      }
      /**
       * @param {boolean} isYKey
       */
      writeParentInfo(isYKey) {
        this.parentInfoEncoder.write(isYKey ? 1 : 0);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeTypeRef(info) {
        this.typeRefEncoder.write(info);
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @param {number} len
       */
      writeLen(len) {
        this.lenEncoder.write(len);
      }
      /**
       * @param {any} any
       */
      writeAny(any2) {
        writeAny(this.restEncoder, any2);
      }
      /**
       * @param {Uint8Array} buf
       */
      writeBuf(buf) {
        writeVarUint8Array(this.restEncoder, buf);
      }
      /**
       * This is mainly here for legacy purposes.
       *
       * Initial we incoded objects using JSON. Now we use the much faster lib0/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
       *
       * @param {any} embed
       */
      writeJSON(embed) {
        writeAny(this.restEncoder, embed);
      }
      /**
       * Property keys are often reused. For example, in y-prosemirror the key `bold` might
       * occur very often. For a 3d application, the key `position` might occur very often.
       *
       * We cache these keys in a Map and refer to them via a unique number.
       *
       * @param {string} key
       */
      writeKey(key) {
        const clock = this.keyMap.get(key);
        if (clock === void 0) {
          this.keyClockEncoder.write(this.keyClock++);
          this.stringEncoder.write(key);
        } else {
          this.keyClockEncoder.write(clock);
        }
      }
    };
    writeStructs = (encoder, structs, client, clock) => {
      clock = max(clock, structs[0].id.clock);
      const startNewStructs = findIndexSS(structs, clock);
      writeVarUint(encoder.restEncoder, structs.length - startNewStructs);
      encoder.writeClient(client);
      writeVarUint(encoder.restEncoder, clock);
      const firstStruct = structs[startNewStructs];
      firstStruct.write(encoder, clock - firstStruct.id.clock);
      for (let i = startNewStructs + 1; i < structs.length; i++) {
        structs[i].write(encoder, 0);
      }
    };
    writeClientsStructs = (encoder, store, _sm) => {
      const sm = /* @__PURE__ */ new Map();
      _sm.forEach((clock, client) => {
        if (getState(store, client) > clock) {
          sm.set(client, clock);
        }
      });
      getStateVector(store).forEach((_clock, client) => {
        if (!_sm.has(client)) {
          sm.set(client, 0);
        }
      });
      writeVarUint(encoder.restEncoder, sm.size);
      from(sm.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
        writeStructs(
          encoder,
          /** @type {Array<GC|Item>} */
          store.clients.get(client),
          client,
          clock
        );
      });
    };
    readClientsStructRefs = (decoder, doc) => {
      const clientRefs = create();
      const numOfStateUpdates = readVarUint(decoder.restDecoder);
      for (let i = 0; i < numOfStateUpdates; i++) {
        const numberOfStructs = readVarUint(decoder.restDecoder);
        const refs = new Array(numberOfStructs);
        const client = decoder.readClient();
        let clock = readVarUint(decoder.restDecoder);
        clientRefs.set(client, { i: 0, refs });
        for (let i2 = 0; i2 < numberOfStructs; i2++) {
          const info = decoder.readInfo();
          switch (BITS5 & info) {
            case 0: {
              const len = decoder.readLen();
              refs[i2] = new GC(createID(client, clock), len);
              clock += len;
              break;
            }
            case 10: {
              const len = readVarUint(decoder.restDecoder);
              refs[i2] = new Skip(createID(client, clock), len);
              clock += len;
              break;
            }
            default: {
              const cantCopyParentInfo = (info & (BIT7 | BIT8)) === 0;
              const struct = new Item(
                createID(client, clock),
                null,
                // left
                (info & BIT8) === BIT8 ? decoder.readLeftID() : null,
                // origin
                null,
                // right
                (info & BIT7) === BIT7 ? decoder.readRightID() : null,
                // right origin
                cantCopyParentInfo ? decoder.readParentInfo() ? doc.get(decoder.readString()) : decoder.readLeftID() : null,
                // parent
                cantCopyParentInfo && (info & BIT6) === BIT6 ? decoder.readString() : null,
                // parentSub
                readItemContent(decoder, info)
                // item content
              );
              refs[i2] = struct;
              clock += struct.length;
            }
          }
        }
      }
      return clientRefs;
    };
    integrateStructs = (transaction, store, clientsStructRefs) => {
      const stack = [];
      let clientsStructRefsIds = from(clientsStructRefs.keys()).sort((a, b) => a - b);
      if (clientsStructRefsIds.length === 0) {
        return null;
      }
      const getNextStructTarget = () => {
        if (clientsStructRefsIds.length === 0) {
          return null;
        }
        let nextStructsTarget = (
          /** @type {{i:number,refs:Array<GC|Item>}} */
          clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1])
        );
        while (nextStructsTarget.refs.length === nextStructsTarget.i) {
          clientsStructRefsIds.pop();
          if (clientsStructRefsIds.length > 0) {
            nextStructsTarget = /** @type {{i:number,refs:Array<GC|Item>}} */
            clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]);
          } else {
            return null;
          }
        }
        return nextStructsTarget;
      };
      let curStructsTarget = getNextStructTarget();
      if (curStructsTarget === null) {
        return null;
      }
      const restStructs = new StructStore();
      const missingSV = /* @__PURE__ */ new Map();
      const updateMissingSv = (client, clock) => {
        const mclock = missingSV.get(client);
        if (mclock == null || mclock > clock) {
          missingSV.set(client, clock);
        }
      };
      let stackHead = (
        /** @type {any} */
        curStructsTarget.refs[
          /** @type {any} */
          curStructsTarget.i++
        ]
      );
      const state = /* @__PURE__ */ new Map();
      const addStackToRestSS = () => {
        for (const item of stack) {
          const client = item.id.client;
          const inapplicableItems = clientsStructRefs.get(client);
          if (inapplicableItems) {
            inapplicableItems.i--;
            restStructs.clients.set(client, inapplicableItems.refs.slice(inapplicableItems.i));
            clientsStructRefs.delete(client);
            inapplicableItems.i = 0;
            inapplicableItems.refs = [];
          } else {
            restStructs.clients.set(client, [item]);
          }
          clientsStructRefsIds = clientsStructRefsIds.filter((c) => c !== client);
        }
        stack.length = 0;
      };
      while (true) {
        if (stackHead.constructor !== Skip) {
          const localClock = setIfUndefined(state, stackHead.id.client, () => getState(store, stackHead.id.client));
          const offset = localClock - stackHead.id.clock;
          if (offset < 0) {
            stack.push(stackHead);
            updateMissingSv(stackHead.id.client, stackHead.id.clock - 1);
            addStackToRestSS();
          } else {
            const missing = stackHead.getMissing(transaction, store);
            if (missing !== null) {
              stack.push(stackHead);
              const structRefs = clientsStructRefs.get(
                /** @type {number} */
                missing
              ) || { refs: [], i: 0 };
              if (structRefs.refs.length === structRefs.i) {
                updateMissingSv(
                  /** @type {number} */
                  missing,
                  getState(store, missing)
                );
                addStackToRestSS();
              } else {
                stackHead = structRefs.refs[structRefs.i++];
                continue;
              }
            } else if (offset === 0 || offset < stackHead.length) {
              stackHead.integrate(transaction, offset);
              state.set(stackHead.id.client, stackHead.id.clock + stackHead.length);
            }
          }
        }
        if (stack.length > 0) {
          stackHead = /** @type {GC|Item} */
          stack.pop();
        } else if (curStructsTarget !== null && curStructsTarget.i < curStructsTarget.refs.length) {
          stackHead = /** @type {GC|Item} */
          curStructsTarget.refs[curStructsTarget.i++];
        } else {
          curStructsTarget = getNextStructTarget();
          if (curStructsTarget === null) {
            break;
          } else {
            stackHead = /** @type {GC|Item} */
            curStructsTarget.refs[curStructsTarget.i++];
          }
        }
      }
      if (restStructs.clients.size > 0) {
        const encoder = new UpdateEncoderV2();
        writeClientsStructs(encoder, restStructs, /* @__PURE__ */ new Map());
        writeVarUint(encoder.restEncoder, 0);
        return { missing: missingSV, update: encoder.toUint8Array() };
      }
      return null;
    };
    writeStructsFromTransaction = (encoder, transaction) => writeClientsStructs(encoder, transaction.doc.store, transaction.beforeState);
    readUpdateV2 = (decoder, ydoc, transactionOrigin, structDecoder = new UpdateDecoderV2(decoder)) => transact(ydoc, (transaction) => {
      transaction.local = false;
      let retry = false;
      const doc = transaction.doc;
      const store = doc.store;
      const ss = readClientsStructRefs(structDecoder, doc);
      const restStructs = integrateStructs(transaction, store, ss);
      const pending = store.pendingStructs;
      if (pending) {
        for (const [client, clock] of pending.missing) {
          if (clock < getState(store, client)) {
            retry = true;
            break;
          }
        }
        if (restStructs) {
          for (const [client, clock] of restStructs.missing) {
            const mclock = pending.missing.get(client);
            if (mclock == null || mclock > clock) {
              pending.missing.set(client, clock);
            }
          }
          pending.update = mergeUpdatesV2([pending.update, restStructs.update]);
        }
      } else {
        store.pendingStructs = restStructs;
      }
      const dsRest = readAndApplyDeleteSet(structDecoder, transaction, store);
      if (store.pendingDs) {
        const pendingDSUpdate = new UpdateDecoderV2(createDecoder(store.pendingDs));
        readVarUint(pendingDSUpdate.restDecoder);
        const dsRest2 = readAndApplyDeleteSet(pendingDSUpdate, transaction, store);
        if (dsRest && dsRest2) {
          store.pendingDs = mergeUpdatesV2([dsRest, dsRest2]);
        } else {
          store.pendingDs = dsRest || dsRest2;
        }
      } else {
        store.pendingDs = dsRest;
      }
      if (retry) {
        const update = (
          /** @type {{update: Uint8Array}} */
          store.pendingStructs.update
        );
        store.pendingStructs = null;
        applyUpdateV2(transaction.doc, update);
      }
    }, transactionOrigin, false);
    readUpdate = (decoder, ydoc, transactionOrigin) => readUpdateV2(decoder, ydoc, transactionOrigin, new UpdateDecoderV1(decoder));
    applyUpdateV2 = (ydoc, update, transactionOrigin, YDecoder = UpdateDecoderV2) => {
      const decoder = createDecoder(update);
      readUpdateV2(decoder, ydoc, transactionOrigin, new YDecoder(decoder));
    };
    applyUpdate = (ydoc, update, transactionOrigin) => applyUpdateV2(ydoc, update, transactionOrigin, UpdateDecoderV1);
    writeStateAsUpdate = (encoder, doc, targetStateVector = /* @__PURE__ */ new Map()) => {
      writeClientsStructs(encoder, doc.store, targetStateVector);
      writeDeleteSet(encoder, createDeleteSetFromStructStore(doc.store));
    };
    encodeStateAsUpdateV2 = (doc, encodedTargetStateVector = new Uint8Array([0]), encoder = new UpdateEncoderV2()) => {
      const targetStateVector = decodeStateVector(encodedTargetStateVector);
      writeStateAsUpdate(encoder, doc, targetStateVector);
      const updates = [encoder.toUint8Array()];
      if (doc.store.pendingDs) {
        updates.push(doc.store.pendingDs);
      }
      if (doc.store.pendingStructs) {
        updates.push(diffUpdateV2(doc.store.pendingStructs.update, encodedTargetStateVector));
      }
      if (updates.length > 1) {
        if (encoder.constructor === UpdateEncoderV1) {
          return mergeUpdates(updates.map((update, i) => i === 0 ? update : convertUpdateFormatV2ToV1(update)));
        } else if (encoder.constructor === UpdateEncoderV2) {
          return mergeUpdatesV2(updates);
        }
      }
      return updates[0];
    };
    encodeStateAsUpdate = (doc, encodedTargetStateVector) => encodeStateAsUpdateV2(doc, encodedTargetStateVector, new UpdateEncoderV1());
    readStateVector = (decoder) => {
      const ss = /* @__PURE__ */ new Map();
      const ssLength = readVarUint(decoder.restDecoder);
      for (let i = 0; i < ssLength; i++) {
        const client = readVarUint(decoder.restDecoder);
        const clock = readVarUint(decoder.restDecoder);
        ss.set(client, clock);
      }
      return ss;
    };
    decodeStateVector = (decodedState) => readStateVector(new DSDecoderV1(createDecoder(decodedState)));
    writeStateVector = (encoder, sv) => {
      writeVarUint(encoder.restEncoder, sv.size);
      from(sv.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
        writeVarUint(encoder.restEncoder, client);
        writeVarUint(encoder.restEncoder, clock);
      });
      return encoder;
    };
    writeDocumentStateVector = (encoder, doc) => writeStateVector(encoder, getStateVector(doc.store));
    encodeStateVectorV2 = (doc, encoder = new DSEncoderV2()) => {
      if (doc instanceof Map) {
        writeStateVector(encoder, doc);
      } else {
        writeDocumentStateVector(encoder, doc);
      }
      return encoder.toUint8Array();
    };
    encodeStateVector = (doc) => encodeStateVectorV2(doc, new DSEncoderV1());
    EventHandler = class {
      constructor() {
        this.l = [];
      }
    };
    createEventHandler = () => new EventHandler();
    addEventHandlerListener = (eventHandler, f) => eventHandler.l.push(f);
    removeEventHandlerListener = (eventHandler, f) => {
      const l = eventHandler.l;
      const len = l.length;
      eventHandler.l = l.filter((g) => f !== g);
      if (len === eventHandler.l.length) {
        console.error("[yjs] Tried to remove event handler that doesn't exist.");
      }
    };
    callEventHandlerListeners = (eventHandler, arg0, arg1) => callAll(eventHandler.l, [arg0, arg1]);
    ID = class {
      /**
       * @param {number} client client id
       * @param {number} clock unique per client id, continuous number
       */
      constructor(client, clock) {
        this.client = client;
        this.clock = clock;
      }
    };
    compareIDs = (a, b) => a === b || a !== null && b !== null && a.client === b.client && a.clock === b.clock;
    createID = (client, clock) => new ID(client, clock);
    writeID = (encoder, id2) => {
      writeVarUint(encoder, id2.client);
      writeVarUint(encoder, id2.clock);
    };
    readID = (decoder) => createID(readVarUint(decoder), readVarUint(decoder));
    findRootTypeKey = (type) => {
      for (const [key, value] of type.doc.share.entries()) {
        if (value === type) {
          return key;
        }
      }
      throw unexpectedCase();
    };
    isParentOf = (parent, child) => {
      while (child !== null) {
        if (child.parent === parent) {
          return true;
        }
        child = /** @type {AbstractType<any>} */
        child.parent._item;
      }
      return false;
    };
    logType = (type) => {
      const res = [];
      let n = type._start;
      while (n) {
        res.push(n);
        n = n.right;
      }
      console.log("Children: ", res);
      console.log("Children content: ", res.filter((m) => !m.deleted).map((m) => m.content));
    };
    PermanentUserData = class {
      /**
       * @param {Doc} doc
       * @param {YMap<any>} [storeType]
       */
      constructor(doc, storeType = doc.getMap("users")) {
        const dss = /* @__PURE__ */ new Map();
        this.yusers = storeType;
        this.doc = doc;
        this.clients = /* @__PURE__ */ new Map();
        this.dss = dss;
        const initUser = (user, userDescription) => {
          const ds = user.get("ds");
          const ids = user.get("ids");
          const addClientId = (
            /** @param {number} clientid */
            (clientid) => this.clients.set(clientid, userDescription)
          );
          ds.observe(
            /** @param {YArrayEvent<any>} event */
            (event) => {
              event.changes.added.forEach((item) => {
                item.content.getContent().forEach((encodedDs) => {
                  if (encodedDs instanceof Uint8Array) {
                    this.dss.set(userDescription, mergeDeleteSets([this.dss.get(userDescription) || createDeleteSet(), readDeleteSet(new DSDecoderV1(createDecoder(encodedDs)))]));
                  }
                });
              });
            }
          );
          this.dss.set(userDescription, mergeDeleteSets(ds.map((encodedDs) => readDeleteSet(new DSDecoderV1(createDecoder(encodedDs))))));
          ids.observe(
            /** @param {YArrayEvent<any>} event */
            (event) => event.changes.added.forEach((item) => item.content.getContent().forEach(addClientId))
          );
          ids.forEach(addClientId);
        };
        storeType.observe((event) => {
          event.keysChanged.forEach(
            (userDescription) => initUser(storeType.get(userDescription), userDescription)
          );
        });
        storeType.forEach(initUser);
      }
      /**
       * @param {Doc} doc
       * @param {number} clientid
       * @param {string} userDescription
       * @param {Object} conf
       * @param {function(Transaction, DeleteSet):boolean} [conf.filter]
       */
      setUserMapping(doc, clientid, userDescription, { filter = () => true } = {}) {
        const users = this.yusers;
        let user = users.get(userDescription);
        if (!user) {
          user = new YMap();
          user.set("ids", new YArray());
          user.set("ds", new YArray());
          users.set(userDescription, user);
        }
        user.get("ids").push([clientid]);
        users.observe((_event) => {
          setTimeout(() => {
            const userOverwrite = users.get(userDescription);
            if (userOverwrite !== user) {
              user = userOverwrite;
              this.clients.forEach((_userDescription, clientid2) => {
                if (userDescription === _userDescription) {
                  user.get("ids").push([clientid2]);
                }
              });
              const encoder = new DSEncoderV1();
              const ds = this.dss.get(userDescription);
              if (ds) {
                writeDeleteSet(encoder, ds);
                user.get("ds").push([encoder.toUint8Array()]);
              }
            }
          }, 0);
        });
        doc.on(
          "afterTransaction",
          /** @param {Transaction} transaction */
          (transaction) => {
            setTimeout(() => {
              const yds = user.get("ds");
              const ds = transaction.deleteSet;
              if (transaction.local && ds.clients.size > 0 && filter(transaction, ds)) {
                const encoder = new DSEncoderV1();
                writeDeleteSet(encoder, ds);
                yds.push([encoder.toUint8Array()]);
              }
            });
          }
        );
      }
      /**
       * @param {number} clientid
       * @return {any}
       */
      getUserByClientId(clientid) {
        return this.clients.get(clientid) || null;
      }
      /**
       * @param {ID} id
       * @return {string | null}
       */
      getUserByDeletedId(id2) {
        for (const [userDescription, ds] of this.dss.entries()) {
          if (isDeleted(ds, id2)) {
            return userDescription;
          }
        }
        return null;
      }
    };
    RelativePosition = class {
      /**
       * @param {ID|null} type
       * @param {string|null} tname
       * @param {ID|null} item
       * @param {number} assoc
       */
      constructor(type, tname, item, assoc = 0) {
        this.type = type;
        this.tname = tname;
        this.item = item;
        this.assoc = assoc;
      }
    };
    relativePositionToJSON = (rpos) => {
      const json = {};
      if (rpos.type) {
        json.type = rpos.type;
      }
      if (rpos.tname) {
        json.tname = rpos.tname;
      }
      if (rpos.item) {
        json.item = rpos.item;
      }
      if (rpos.assoc != null) {
        json.assoc = rpos.assoc;
      }
      return json;
    };
    createRelativePositionFromJSON = (json) => new RelativePosition(json.type == null ? null : createID(json.type.client, json.type.clock), json.tname ?? null, json.item == null ? null : createID(json.item.client, json.item.clock), json.assoc == null ? 0 : json.assoc);
    AbsolutePosition = class {
      /**
       * @param {AbstractType<any>} type
       * @param {number} index
       * @param {number} [assoc]
       */
      constructor(type, index, assoc = 0) {
        this.type = type;
        this.index = index;
        this.assoc = assoc;
      }
    };
    createAbsolutePosition = (type, index, assoc = 0) => new AbsolutePosition(type, index, assoc);
    createRelativePosition = (type, item, assoc) => {
      let typeid = null;
      let tname = null;
      if (type._item === null) {
        tname = findRootTypeKey(type);
      } else {
        typeid = createID(type._item.id.client, type._item.id.clock);
      }
      return new RelativePosition(typeid, tname, item, assoc);
    };
    createRelativePositionFromTypeIndex = (type, index, assoc = 0) => {
      let t = type._start;
      if (assoc < 0) {
        if (index === 0) {
          return createRelativePosition(type, null, assoc);
        }
        index--;
      }
      while (t !== null) {
        if (!t.deleted && t.countable) {
          if (t.length > index) {
            return createRelativePosition(type, createID(t.id.client, t.id.clock + index), assoc);
          }
          index -= t.length;
        }
        if (t.right === null && assoc < 0) {
          return createRelativePosition(type, t.lastId, assoc);
        }
        t = t.right;
      }
      return createRelativePosition(type, null, assoc);
    };
    writeRelativePosition = (encoder, rpos) => {
      const { type, tname, item, assoc } = rpos;
      if (item !== null) {
        writeVarUint(encoder, 0);
        writeID(encoder, item);
      } else if (tname !== null) {
        writeUint8(encoder, 1);
        writeVarString(encoder, tname);
      } else if (type !== null) {
        writeUint8(encoder, 2);
        writeID(encoder, type);
      } else {
        throw unexpectedCase();
      }
      writeVarInt(encoder, assoc);
      return encoder;
    };
    encodeRelativePosition = (rpos) => {
      const encoder = createEncoder();
      writeRelativePosition(encoder, rpos);
      return toUint8Array(encoder);
    };
    readRelativePosition = (decoder) => {
      let type = null;
      let tname = null;
      let itemID = null;
      switch (readVarUint(decoder)) {
        case 0:
          itemID = readID(decoder);
          break;
        case 1:
          tname = readVarString(decoder);
          break;
        case 2: {
          type = readID(decoder);
        }
      }
      const assoc = hasContent(decoder) ? readVarInt(decoder) : 0;
      return new RelativePosition(type, tname, itemID, assoc);
    };
    decodeRelativePosition = (uint8Array) => readRelativePosition(createDecoder(uint8Array));
    getItemWithOffset = (store, id2) => {
      const item = getItem(store, id2);
      const diff = id2.clock - item.id.clock;
      return {
        item,
        diff
      };
    };
    createAbsolutePositionFromRelativePosition = (rpos, doc, followUndoneDeletions = true) => {
      const store = doc.store;
      const rightID = rpos.item;
      const typeID = rpos.type;
      const tname = rpos.tname;
      const assoc = rpos.assoc;
      let type = null;
      let index = 0;
      if (rightID !== null) {
        if (getState(store, rightID.client) <= rightID.clock) {
          return null;
        }
        const res = followUndoneDeletions ? followRedone(store, rightID) : getItemWithOffset(store, rightID);
        const right = res.item;
        if (!(right instanceof Item)) {
          return null;
        }
        type = /** @type {AbstractType<any>} */
        right.parent;
        if (type._item === null || !type._item.deleted) {
          index = right.deleted || !right.countable ? 0 : res.diff + (assoc >= 0 ? 0 : 1);
          let n = right.left;
          while (n !== null) {
            if (!n.deleted && n.countable) {
              index += n.length;
            }
            n = n.left;
          }
        }
      } else {
        if (tname !== null) {
          type = doc.get(tname);
        } else if (typeID !== null) {
          if (getState(store, typeID.client) <= typeID.clock) {
            return null;
          }
          const { item } = followUndoneDeletions ? followRedone(store, typeID) : { item: getItem(store, typeID) };
          if (item instanceof Item && item.content instanceof ContentType) {
            type = item.content.type;
          } else {
            return null;
          }
        } else {
          throw unexpectedCase();
        }
        if (assoc >= 0) {
          index = type._length;
        } else {
          index = 0;
        }
      }
      return createAbsolutePosition(type, index, rpos.assoc);
    };
    compareRelativePositions = (a, b) => a === b || a !== null && b !== null && a.tname === b.tname && compareIDs(a.item, b.item) && compareIDs(a.type, b.type) && a.assoc === b.assoc;
    Snapshot = class {
      /**
       * @param {DeleteSet} ds
       * @param {Map<number,number>} sv state map
       */
      constructor(ds, sv) {
        this.ds = ds;
        this.sv = sv;
      }
    };
    equalSnapshots = (snap1, snap2) => {
      const ds1 = snap1.ds.clients;
      const ds2 = snap2.ds.clients;
      const sv1 = snap1.sv;
      const sv2 = snap2.sv;
      if (sv1.size !== sv2.size || ds1.size !== ds2.size) {
        return false;
      }
      for (const [key, value] of sv1.entries()) {
        if (sv2.get(key) !== value) {
          return false;
        }
      }
      for (const [client, dsitems1] of ds1.entries()) {
        const dsitems2 = ds2.get(client) || [];
        if (dsitems1.length !== dsitems2.length) {
          return false;
        }
        for (let i = 0; i < dsitems1.length; i++) {
          const dsitem1 = dsitems1[i];
          const dsitem2 = dsitems2[i];
          if (dsitem1.clock !== dsitem2.clock || dsitem1.len !== dsitem2.len) {
            return false;
          }
        }
      }
      return true;
    };
    encodeSnapshotV2 = (snapshot2, encoder = new DSEncoderV2()) => {
      writeDeleteSet(encoder, snapshot2.ds);
      writeStateVector(encoder, snapshot2.sv);
      return encoder.toUint8Array();
    };
    encodeSnapshot = (snapshot2) => encodeSnapshotV2(snapshot2, new DSEncoderV1());
    decodeSnapshotV2 = (buf, decoder = new DSDecoderV2(createDecoder(buf))) => {
      return new Snapshot(readDeleteSet(decoder), readStateVector(decoder));
    };
    decodeSnapshot = (buf) => decodeSnapshotV2(buf, new DSDecoderV1(createDecoder(buf)));
    createSnapshot = (ds, sm) => new Snapshot(ds, sm);
    emptySnapshot = createSnapshot(createDeleteSet(), /* @__PURE__ */ new Map());
    snapshot = (doc) => createSnapshot(createDeleteSetFromStructStore(doc.store), getStateVector(doc.store));
    isVisible = (item, snapshot2) => snapshot2 === void 0 ? !item.deleted : snapshot2.sv.has(item.id.client) && (snapshot2.sv.get(item.id.client) || 0) > item.id.clock && !isDeleted(snapshot2.ds, item.id);
    splitSnapshotAffectedStructs = (transaction, snapshot2) => {
      const meta = setIfUndefined(transaction.meta, splitSnapshotAffectedStructs, create2);
      const store = transaction.doc.store;
      if (!meta.has(snapshot2)) {
        snapshot2.sv.forEach((clock, client) => {
          if (clock < getState(store, client)) {
            getItemCleanStart(transaction, createID(client, clock));
          }
        });
        iterateDeletedStructs(transaction, snapshot2.ds, (_item) => {
        });
        meta.add(snapshot2);
      }
    };
    createDocFromSnapshot = (originDoc, snapshot2, newDoc = new Doc()) => {
      if (originDoc.gc) {
        throw new Error("Garbage-collection must be disabled in `originDoc`!");
      }
      const { sv, ds } = snapshot2;
      const encoder = new UpdateEncoderV2();
      originDoc.transact((transaction) => {
        let size2 = 0;
        sv.forEach((clock) => {
          if (clock > 0) {
            size2++;
          }
        });
        writeVarUint(encoder.restEncoder, size2);
        for (const [client, clock] of sv) {
          if (clock === 0) {
            continue;
          }
          if (clock < getState(originDoc.store, client)) {
            getItemCleanStart(transaction, createID(client, clock));
          }
          const structs = originDoc.store.clients.get(client) || [];
          const lastStructIndex = findIndexSS(structs, clock - 1);
          writeVarUint(encoder.restEncoder, lastStructIndex + 1);
          encoder.writeClient(client);
          writeVarUint(encoder.restEncoder, 0);
          for (let i = 0; i <= lastStructIndex; i++) {
            structs[i].write(encoder, 0);
          }
        }
        writeDeleteSet(encoder, ds);
      });
      applyUpdateV2(newDoc, encoder.toUint8Array(), "snapshot");
      return newDoc;
    };
    snapshotContainsUpdateV2 = (snapshot2, update, YDecoder = UpdateDecoderV2) => {
      const updateDecoder = new YDecoder(createDecoder(update));
      const lazyDecoder = new LazyStructReader(updateDecoder, false);
      for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
        if ((snapshot2.sv.get(curr.id.client) || 0) < curr.id.clock + curr.length) {
          return false;
        }
      }
      const mergedDS = mergeDeleteSets([snapshot2.ds, readDeleteSet(updateDecoder)]);
      return equalDeleteSets(snapshot2.ds, mergedDS);
    };
    snapshotContainsUpdate = (snapshot2, update) => snapshotContainsUpdateV2(snapshot2, update, UpdateDecoderV1);
    StructStore = class {
      constructor() {
        this.clients = /* @__PURE__ */ new Map();
        this.pendingStructs = null;
        this.pendingDs = null;
      }
    };
    getStateVector = (store) => {
      const sm = /* @__PURE__ */ new Map();
      store.clients.forEach((structs, client) => {
        const struct = structs[structs.length - 1];
        sm.set(client, struct.id.clock + struct.length);
      });
      return sm;
    };
    getState = (store, client) => {
      const structs = store.clients.get(client);
      if (structs === void 0) {
        return 0;
      }
      const lastStruct = structs[structs.length - 1];
      return lastStruct.id.clock + lastStruct.length;
    };
    addStruct = (store, struct) => {
      let structs = store.clients.get(struct.id.client);
      if (structs === void 0) {
        structs = [];
        store.clients.set(struct.id.client, structs);
      } else {
        const lastStruct = structs[structs.length - 1];
        if (lastStruct.id.clock + lastStruct.length !== struct.id.clock) {
          throw unexpectedCase();
        }
      }
      structs.push(struct);
    };
    findIndexSS = (structs, clock) => {
      let left = 0;
      let right = structs.length - 1;
      let mid = structs[right];
      let midclock = mid.id.clock;
      if (midclock === clock) {
        return right;
      }
      let midindex = floor(clock / (midclock + mid.length - 1) * right);
      while (left <= right) {
        mid = structs[midindex];
        midclock = mid.id.clock;
        if (midclock <= clock) {
          if (clock < midclock + mid.length) {
            return midindex;
          }
          left = midindex + 1;
        } else {
          right = midindex - 1;
        }
        midindex = floor((left + right) / 2);
      }
      throw unexpectedCase();
    };
    find = (store, id2) => {
      const structs = store.clients.get(id2.client);
      return structs[findIndexSS(structs, id2.clock)];
    };
    getItem = /** @type {function(StructStore,ID):Item} */
    find;
    findIndexCleanStart = (transaction, structs, clock) => {
      const index = findIndexSS(structs, clock);
      const struct = structs[index];
      if (struct.id.clock < clock && struct instanceof Item) {
        structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
        return index + 1;
      }
      return index;
    };
    getItemCleanStart = (transaction, id2) => {
      const structs = (
        /** @type {Array<Item>} */
        transaction.doc.store.clients.get(id2.client)
      );
      return structs[findIndexCleanStart(transaction, structs, id2.clock)];
    };
    getItemCleanEnd = (transaction, store, id2) => {
      const structs = store.clients.get(id2.client);
      const index = findIndexSS(structs, id2.clock);
      const struct = structs[index];
      if (id2.clock !== struct.id.clock + struct.length - 1 && struct.constructor !== GC) {
        structs.splice(index + 1, 0, splitItem(transaction, struct, id2.clock - struct.id.clock + 1));
      }
      return struct;
    };
    replaceStruct = (store, struct, newStruct) => {
      const structs = (
        /** @type {Array<GC|Item>} */
        store.clients.get(struct.id.client)
      );
      structs[findIndexSS(structs, struct.id.clock)] = newStruct;
    };
    iterateStructs = (transaction, structs, clockStart, len, f) => {
      if (len === 0) {
        return;
      }
      const clockEnd = clockStart + len;
      let index = findIndexCleanStart(transaction, structs, clockStart);
      let struct;
      do {
        struct = structs[index++];
        if (clockEnd < struct.id.clock + struct.length) {
          findIndexCleanStart(transaction, structs, clockEnd);
        }
        f(struct);
      } while (index < structs.length && structs[index].id.clock < clockEnd);
    };
    Transaction = class {
      /**
       * @param {Doc} doc
       * @param {any} origin
       * @param {boolean} local
       */
      constructor(doc, origin, local) {
        this.doc = doc;
        this.deleteSet = new DeleteSet();
        this.beforeState = getStateVector(doc.store);
        this.afterState = /* @__PURE__ */ new Map();
        this.changed = /* @__PURE__ */ new Map();
        this.changedParentTypes = /* @__PURE__ */ new Map();
        this._mergeStructs = [];
        this.origin = origin;
        this.meta = /* @__PURE__ */ new Map();
        this.local = local;
        this.subdocsAdded = /* @__PURE__ */ new Set();
        this.subdocsRemoved = /* @__PURE__ */ new Set();
        this.subdocsLoaded = /* @__PURE__ */ new Set();
        this._needFormattingCleanup = false;
      }
    };
    writeUpdateMessageFromTransaction = (encoder, transaction) => {
      if (transaction.deleteSet.clients.size === 0 && !any(transaction.afterState, (clock, client) => transaction.beforeState.get(client) !== clock)) {
        return false;
      }
      sortAndMergeDeleteSet(transaction.deleteSet);
      writeStructsFromTransaction(encoder, transaction);
      writeDeleteSet(encoder, transaction.deleteSet);
      return true;
    };
    addChangedTypeToTransaction = (transaction, type, parentSub) => {
      const item = type._item;
      if (item === null || item.id.clock < (transaction.beforeState.get(item.id.client) || 0) && !item.deleted) {
        setIfUndefined(transaction.changed, type, create2).add(parentSub);
      }
    };
    tryToMergeWithLefts = (structs, pos) => {
      let right = structs[pos];
      let left = structs[pos - 1];
      let i = pos;
      for (; i > 0; right = left, left = structs[--i - 1]) {
        if (left.deleted === right.deleted && left.constructor === right.constructor) {
          if (left.mergeWith(right)) {
            if (right instanceof Item && right.parentSub !== null && /** @type {AbstractType<any>} */
            right.parent._map.get(right.parentSub) === right) {
              right.parent._map.set(
                right.parentSub,
                /** @type {Item} */
                left
              );
            }
            continue;
          }
        }
        break;
      }
      const merged = pos - i;
      if (merged) {
        structs.splice(pos + 1 - merged, merged);
      }
      return merged;
    };
    tryGcDeleteSet = (ds, store, gcFilter) => {
      for (const [client, deleteItems] of ds.clients.entries()) {
        const structs = (
          /** @type {Array<GC|Item>} */
          store.clients.get(client)
        );
        for (let di = deleteItems.length - 1; di >= 0; di--) {
          const deleteItem = deleteItems[di];
          const endDeleteItemClock = deleteItem.clock + deleteItem.len;
          for (let si = findIndexSS(structs, deleteItem.clock), struct = structs[si]; si < structs.length && struct.id.clock < endDeleteItemClock; struct = structs[++si]) {
            const struct2 = structs[si];
            if (deleteItem.clock + deleteItem.len <= struct2.id.clock) {
              break;
            }
            if (struct2 instanceof Item && struct2.deleted && !struct2.keep && gcFilter(struct2)) {
              struct2.gc(store, false);
            }
          }
        }
      }
    };
    tryMergeDeleteSet = (ds, store) => {
      ds.clients.forEach((deleteItems, client) => {
        const structs = (
          /** @type {Array<GC|Item>} */
          store.clients.get(client)
        );
        for (let di = deleteItems.length - 1; di >= 0; di--) {
          const deleteItem = deleteItems[di];
          const mostRightIndexToCheck = min(structs.length - 1, 1 + findIndexSS(structs, deleteItem.clock + deleteItem.len - 1));
          for (let si = mostRightIndexToCheck, struct = structs[si]; si > 0 && struct.id.clock >= deleteItem.clock; struct = structs[si]) {
            si -= 1 + tryToMergeWithLefts(structs, si);
          }
        }
      });
    };
    tryGc = (ds, store, gcFilter) => {
      tryGcDeleteSet(ds, store, gcFilter);
      tryMergeDeleteSet(ds, store);
    };
    cleanupTransactions = (transactionCleanups, i) => {
      if (i < transactionCleanups.length) {
        const transaction = transactionCleanups[i];
        const doc = transaction.doc;
        const store = doc.store;
        const ds = transaction.deleteSet;
        const mergeStructs = transaction._mergeStructs;
        try {
          sortAndMergeDeleteSet(ds);
          transaction.afterState = getStateVector(transaction.doc.store);
          doc.emit("beforeObserverCalls", [transaction, doc]);
          const fs = [];
          transaction.changed.forEach(
            (subs, itemtype) => fs.push(() => {
              if (itemtype._item === null || !itemtype._item.deleted) {
                itemtype._callObserver(transaction, subs);
              }
            })
          );
          fs.push(() => {
            transaction.changedParentTypes.forEach((events, type) => {
              if (type._dEH.l.length > 0 && (type._item === null || !type._item.deleted)) {
                fs.push(() => {
                  events = events.filter(
                    (event) => event.target._item === null || !event.target._item.deleted
                  );
                  events.forEach((event) => {
                    event.currentTarget = type;
                    event._path = null;
                  });
                  events.sort((event1, event2) => event1.path.length - event2.path.length);
                  callEventHandlerListeners(type._dEH, events, transaction);
                });
              }
            });
            fs.push(() => doc.emit("afterTransaction", [transaction, doc]));
            fs.push(() => {
              if (transaction._needFormattingCleanup) {
                cleanupYTextAfterTransaction(transaction);
              }
            });
          });
          callAll(fs, []);
        } finally {
          if (doc.gc) {
            tryGcDeleteSet(ds, store, doc.gcFilter);
          }
          tryMergeDeleteSet(ds, store);
          transaction.afterState.forEach((clock, client) => {
            const beforeClock = transaction.beforeState.get(client) || 0;
            if (beforeClock !== clock) {
              const structs = (
                /** @type {Array<GC|Item>} */
                store.clients.get(client)
              );
              const firstChangePos = max(findIndexSS(structs, beforeClock), 1);
              for (let i2 = structs.length - 1; i2 >= firstChangePos; ) {
                i2 -= 1 + tryToMergeWithLefts(structs, i2);
              }
            }
          });
          for (let i2 = mergeStructs.length - 1; i2 >= 0; i2--) {
            const { client, clock } = mergeStructs[i2].id;
            const structs = (
              /** @type {Array<GC|Item>} */
              store.clients.get(client)
            );
            const replacedStructPos = findIndexSS(structs, clock);
            if (replacedStructPos + 1 < structs.length) {
              if (tryToMergeWithLefts(structs, replacedStructPos + 1) > 1) {
                continue;
              }
            }
            if (replacedStructPos > 0) {
              tryToMergeWithLefts(structs, replacedStructPos);
            }
          }
          if (!transaction.local && transaction.afterState.get(doc.clientID) !== transaction.beforeState.get(doc.clientID)) {
            print(ORANGE, BOLD, "[yjs] ", UNBOLD, RED, "Changed the client-id because another client seems to be using it.");
            doc.clientID = generateNewClientId();
          }
          doc.emit("afterTransactionCleanup", [transaction, doc]);
          if (doc._observers.has("update")) {
            const encoder = new UpdateEncoderV1();
            const hasContent2 = writeUpdateMessageFromTransaction(encoder, transaction);
            if (hasContent2) {
              doc.emit("update", [encoder.toUint8Array(), transaction.origin, doc, transaction]);
            }
          }
          if (doc._observers.has("updateV2")) {
            const encoder = new UpdateEncoderV2();
            const hasContent2 = writeUpdateMessageFromTransaction(encoder, transaction);
            if (hasContent2) {
              doc.emit("updateV2", [encoder.toUint8Array(), transaction.origin, doc, transaction]);
            }
          }
          const { subdocsAdded, subdocsLoaded, subdocsRemoved } = transaction;
          if (subdocsAdded.size > 0 || subdocsRemoved.size > 0 || subdocsLoaded.size > 0) {
            subdocsAdded.forEach((subdoc) => {
              subdoc.clientID = doc.clientID;
              if (subdoc.collectionid == null) {
                subdoc.collectionid = doc.collectionid;
              }
              doc.subdocs.add(subdoc);
            });
            subdocsRemoved.forEach((subdoc) => doc.subdocs.delete(subdoc));
            doc.emit("subdocs", [{ loaded: subdocsLoaded, added: subdocsAdded, removed: subdocsRemoved }, doc, transaction]);
            subdocsRemoved.forEach((subdoc) => subdoc.destroy());
          }
          if (transactionCleanups.length <= i + 1) {
            doc._transactionCleanups = [];
            doc.emit("afterAllTransactions", [doc, transactionCleanups]);
          } else {
            cleanupTransactions(transactionCleanups, i + 1);
          }
        }
      }
    };
    transact = (doc, f, origin = null, local = true) => {
      const transactionCleanups = doc._transactionCleanups;
      let initialCall = false;
      let result = null;
      if (doc._transaction === null) {
        initialCall = true;
        doc._transaction = new Transaction(doc, origin, local);
        transactionCleanups.push(doc._transaction);
        if (transactionCleanups.length === 1) {
          doc.emit("beforeAllTransactions", [doc]);
        }
        doc.emit("beforeTransaction", [doc._transaction, doc]);
      }
      try {
        result = f(doc._transaction);
      } finally {
        if (initialCall) {
          const finishCleanup = doc._transaction === transactionCleanups[0];
          doc._transaction = null;
          if (finishCleanup) {
            cleanupTransactions(transactionCleanups, 0);
          }
        }
      }
      return result;
    };
    StackItem = class {
      /**
       * @param {DeleteSet} deletions
       * @param {DeleteSet} insertions
       */
      constructor(deletions, insertions) {
        this.insertions = insertions;
        this.deletions = deletions;
        this.meta = /* @__PURE__ */ new Map();
      }
    };
    clearUndoManagerStackItem = (tr, um, stackItem) => {
      iterateDeletedStructs(tr, stackItem.deletions, (item) => {
        if (item instanceof Item && um.scope.some((type) => type === tr.doc || isParentOf(
          /** @type {AbstractType<any>} */
          type,
          item
        ))) {
          keepItem(item, false);
        }
      });
    };
    popStackItem = (undoManager, stack, eventType) => {
      let _tr = null;
      const doc = undoManager.doc;
      const scope = undoManager.scope;
      transact(doc, (transaction) => {
        while (stack.length > 0 && undoManager.currStackItem === null) {
          const store = doc.store;
          const stackItem = (
            /** @type {StackItem} */
            stack.pop()
          );
          const itemsToRedo = /* @__PURE__ */ new Set();
          const itemsToDelete = [];
          let performedChange = false;
          iterateDeletedStructs(transaction, stackItem.insertions, (struct) => {
            if (struct instanceof Item) {
              if (struct.redone !== null) {
                let { item, diff } = followRedone(store, struct.id);
                if (diff > 0) {
                  item = getItemCleanStart(transaction, createID(item.id.client, item.id.clock + diff));
                }
                struct = item;
              }
              if (!struct.deleted && scope.some((type) => type === transaction.doc || isParentOf(
                /** @type {AbstractType<any>} */
                type,
                /** @type {Item} */
                struct
              ))) {
                itemsToDelete.push(struct);
              }
            }
          });
          iterateDeletedStructs(transaction, stackItem.deletions, (struct) => {
            if (struct instanceof Item && scope.some((type) => type === transaction.doc || isParentOf(
              /** @type {AbstractType<any>} */
              type,
              struct
            )) && // Never redo structs in stackItem.insertions because they were created and deleted in the same capture interval.
            !isDeleted(stackItem.insertions, struct.id)) {
              itemsToRedo.add(struct);
            }
          });
          itemsToRedo.forEach((struct) => {
            performedChange = redoItem(transaction, struct, itemsToRedo, stackItem.insertions, undoManager.ignoreRemoteMapChanges, undoManager) !== null || performedChange;
          });
          for (let i = itemsToDelete.length - 1; i >= 0; i--) {
            const item = itemsToDelete[i];
            if (undoManager.deleteFilter(item)) {
              item.delete(transaction);
              performedChange = true;
            }
          }
          undoManager.currStackItem = performedChange ? stackItem : null;
        }
        transaction.changed.forEach((subProps, type) => {
          if (subProps.has(null) && type._searchMarker) {
            type._searchMarker.length = 0;
          }
        });
        _tr = transaction;
      }, undoManager);
      const res = undoManager.currStackItem;
      if (res != null) {
        const changedParentTypes = _tr.changedParentTypes;
        undoManager.emit("stack-item-popped", [{ stackItem: res, type: eventType, changedParentTypes, origin: undoManager }, undoManager]);
        undoManager.currStackItem = null;
      }
      return res;
    };
    UndoManager = class extends ObservableV2 {
      /**
       * @param {Doc|AbstractType<any>|Array<AbstractType<any>>} typeScope Limits the scope of the UndoManager. If this is set to a ydoc instance, all changes on that ydoc will be undone. If set to a specific type, only changes on that type or its children will be undone. Also accepts an array of types.
       * @param {UndoManagerOptions} options
       */
      constructor(typeScope, {
        captureTimeout = 500,
        captureTransaction = (_tr) => true,
        deleteFilter = () => true,
        trackedOrigins = /* @__PURE__ */ new Set([null]),
        ignoreRemoteMapChanges = false,
        doc = (
          /** @type {Doc} */
          isArray(typeScope) ? typeScope[0].doc : typeScope instanceof Doc ? typeScope : typeScope.doc
        )
      } = {}) {
        super();
        this.scope = [];
        this.doc = doc;
        this.addToScope(typeScope);
        this.deleteFilter = deleteFilter;
        trackedOrigins.add(this);
        this.trackedOrigins = trackedOrigins;
        this.captureTransaction = captureTransaction;
        this.undoStack = [];
        this.redoStack = [];
        this.undoing = false;
        this.redoing = false;
        this.currStackItem = null;
        this.lastChange = 0;
        this.ignoreRemoteMapChanges = ignoreRemoteMapChanges;
        this.captureTimeout = captureTimeout;
        this.afterTransactionHandler = (transaction) => {
          if (!this.captureTransaction(transaction) || !this.scope.some((type) => transaction.changedParentTypes.has(
            /** @type {AbstractType<any>} */
            type
          ) || type === this.doc) || !this.trackedOrigins.has(transaction.origin) && (!transaction.origin || !this.trackedOrigins.has(transaction.origin.constructor))) {
            return;
          }
          const undoing = this.undoing;
          const redoing = this.redoing;
          const stack = undoing ? this.redoStack : this.undoStack;
          if (undoing) {
            this.stopCapturing();
          } else if (!redoing) {
            this.clear(false, true);
          }
          const insertions = new DeleteSet();
          transaction.afterState.forEach((endClock, client) => {
            const startClock = transaction.beforeState.get(client) || 0;
            const len = endClock - startClock;
            if (len > 0) {
              addToDeleteSet(insertions, client, startClock, len);
            }
          });
          const now = getUnixTime();
          let didAdd = false;
          if (this.lastChange > 0 && now - this.lastChange < this.captureTimeout && stack.length > 0 && !undoing && !redoing) {
            const lastOp = stack[stack.length - 1];
            lastOp.deletions = mergeDeleteSets([lastOp.deletions, transaction.deleteSet]);
            lastOp.insertions = mergeDeleteSets([lastOp.insertions, insertions]);
          } else {
            stack.push(new StackItem(transaction.deleteSet, insertions));
            didAdd = true;
          }
          if (!undoing && !redoing) {
            this.lastChange = now;
          }
          iterateDeletedStructs(
            transaction,
            transaction.deleteSet,
            /** @param {Item|GC} item */
            (item) => {
              if (item instanceof Item && this.scope.some((type) => type === transaction.doc || isParentOf(
                /** @type {AbstractType<any>} */
                type,
                item
              ))) {
                keepItem(item, true);
              }
            }
          );
          const changeEvent = [{ stackItem: stack[stack.length - 1], origin: transaction.origin, type: undoing ? "redo" : "undo", changedParentTypes: transaction.changedParentTypes }, this];
          if (didAdd) {
            this.emit("stack-item-added", changeEvent);
          } else {
            this.emit("stack-item-updated", changeEvent);
          }
        };
        this.destroy = this.destroy.bind(this);
        this.doc.on("afterTransaction", this.afterTransactionHandler);
        this.doc.on("destroy", this.destroy);
      }
      /**
       * Extend the scope.
       *
       * @param {Array<AbstractType<any> | Doc> | AbstractType<any> | Doc} ytypes
       */
      addToScope(ytypes) {
        const tmpSet = new Set(this.scope);
        ytypes = isArray(ytypes) ? ytypes : [ytypes];
        ytypes.forEach((ytype) => {
          if (!tmpSet.has(ytype)) {
            tmpSet.add(ytype);
            if (ytype instanceof AbstractType ? ytype.doc !== this.doc : ytype !== this.doc) warn("[yjs#509] Not same Y.Doc");
            this.scope.push(ytype);
          }
        });
      }
      /**
       * @param {any} origin
       */
      addTrackedOrigin(origin) {
        this.trackedOrigins.add(origin);
      }
      /**
       * @param {any} origin
       */
      removeTrackedOrigin(origin) {
        this.trackedOrigins.delete(origin);
      }
      clear(clearUndoStack = true, clearRedoStack = true) {
        if (clearUndoStack && this.canUndo() || clearRedoStack && this.canRedo()) {
          this.doc.transact((tr) => {
            if (clearUndoStack) {
              this.undoStack.forEach((item) => clearUndoManagerStackItem(tr, this, item));
              this.undoStack = [];
            }
            if (clearRedoStack) {
              this.redoStack.forEach((item) => clearUndoManagerStackItem(tr, this, item));
              this.redoStack = [];
            }
            this.emit("stack-cleared", [{ undoStackCleared: clearUndoStack, redoStackCleared: clearRedoStack }]);
          });
        }
      }
      /**
       * UndoManager merges Undo-StackItem if they are created within time-gap
       * smaller than `options.captureTimeout`. Call `um.stopCapturing()` so that the next
       * StackItem won't be merged.
       *
       *
       * @example
       *     // without stopCapturing
       *     ytext.insert(0, 'a')
       *     ytext.insert(1, 'b')
       *     um.undo()
       *     ytext.toString() // => '' (note that 'ab' was removed)
       *     // with stopCapturing
       *     ytext.insert(0, 'a')
       *     um.stopCapturing()
       *     ytext.insert(0, 'b')
       *     um.undo()
       *     ytext.toString() // => 'a' (note that only 'b' was removed)
       *
       */
      stopCapturing() {
        this.lastChange = 0;
      }
      /**
       * Undo last changes on type.
       *
       * @return {StackItem?} Returns StackItem if a change was applied
       */
      undo() {
        this.undoing = true;
        let res;
        try {
          res = popStackItem(this, this.undoStack, "undo");
        } finally {
          this.undoing = false;
        }
        return res;
      }
      /**
       * Redo last undo operation.
       *
       * @return {StackItem?} Returns StackItem if a change was applied
       */
      redo() {
        this.redoing = true;
        let res;
        try {
          res = popStackItem(this, this.redoStack, "redo");
        } finally {
          this.redoing = false;
        }
        return res;
      }
      /**
       * Are undo steps available?
       *
       * @return {boolean} `true` if undo is possible
       */
      canUndo() {
        return this.undoStack.length > 0;
      }
      /**
       * Are redo steps available?
       *
       * @return {boolean} `true` if redo is possible
       */
      canRedo() {
        return this.redoStack.length > 0;
      }
      destroy() {
        this.trackedOrigins.delete(this);
        this.doc.off("afterTransaction", this.afterTransactionHandler);
        this.doc.off("destroy", this.destroy);
        super.destroy();
      }
    };
    LazyStructReader = class {
      /**
       * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
       * @param {boolean} filterSkips
       */
      constructor(decoder, filterSkips) {
        this.gen = lazyStructReaderGenerator(decoder);
        this.curr = null;
        this.done = false;
        this.filterSkips = filterSkips;
        this.next();
      }
      /**
       * @return {Item | GC | Skip |null}
       */
      next() {
        do {
          this.curr = this.gen.next().value || null;
        } while (this.filterSkips && this.curr !== null && this.curr.constructor === Skip);
        return this.curr;
      }
    };
    logUpdate = (update) => logUpdateV2(update, UpdateDecoderV1);
    logUpdateV2 = (update, YDecoder = UpdateDecoderV2) => {
      const structs = [];
      const updateDecoder = new YDecoder(createDecoder(update));
      const lazyDecoder = new LazyStructReader(updateDecoder, false);
      for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
        structs.push(curr);
      }
      print("Structs: ", structs);
      const ds = readDeleteSet(updateDecoder);
      print("DeleteSet: ", ds);
    };
    decodeUpdate = (update) => decodeUpdateV2(update, UpdateDecoderV1);
    decodeUpdateV2 = (update, YDecoder = UpdateDecoderV2) => {
      const structs = [];
      const updateDecoder = new YDecoder(createDecoder(update));
      const lazyDecoder = new LazyStructReader(updateDecoder, false);
      for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
        structs.push(curr);
      }
      return {
        structs,
        ds: readDeleteSet(updateDecoder)
      };
    };
    LazyStructWriter = class {
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      constructor(encoder) {
        this.currClient = 0;
        this.startClock = 0;
        this.written = 0;
        this.encoder = encoder;
        this.clientStructs = [];
      }
    };
    mergeUpdates = (updates) => mergeUpdatesV2(updates, UpdateDecoderV1, UpdateEncoderV1);
    encodeStateVectorFromUpdateV2 = (update, YEncoder = DSEncoderV2, YDecoder = UpdateDecoderV2) => {
      const encoder = new YEncoder();
      const updateDecoder = new LazyStructReader(new YDecoder(createDecoder(update)), false);
      let curr = updateDecoder.curr;
      if (curr !== null) {
        let size2 = 0;
        let currClient = curr.id.client;
        let stopCounting = curr.id.clock !== 0;
        let currClock = stopCounting ? 0 : curr.id.clock + curr.length;
        for (; curr !== null; curr = updateDecoder.next()) {
          if (currClient !== curr.id.client) {
            if (currClock !== 0) {
              size2++;
              writeVarUint(encoder.restEncoder, currClient);
              writeVarUint(encoder.restEncoder, currClock);
            }
            currClient = curr.id.client;
            currClock = 0;
            stopCounting = curr.id.clock !== 0;
          }
          if (curr.constructor === Skip) {
            stopCounting = true;
          }
          if (!stopCounting) {
            currClock = curr.id.clock + curr.length;
          }
        }
        if (currClock !== 0) {
          size2++;
          writeVarUint(encoder.restEncoder, currClient);
          writeVarUint(encoder.restEncoder, currClock);
        }
        const enc = createEncoder();
        writeVarUint(enc, size2);
        writeBinaryEncoder(enc, encoder.restEncoder);
        encoder.restEncoder = enc;
        return encoder.toUint8Array();
      } else {
        writeVarUint(encoder.restEncoder, 0);
        return encoder.toUint8Array();
      }
    };
    encodeStateVectorFromUpdate = (update) => encodeStateVectorFromUpdateV2(update, DSEncoderV1, UpdateDecoderV1);
    parseUpdateMetaV2 = (update, YDecoder = UpdateDecoderV2) => {
      const from2 = /* @__PURE__ */ new Map();
      const to = /* @__PURE__ */ new Map();
      const updateDecoder = new LazyStructReader(new YDecoder(createDecoder(update)), false);
      let curr = updateDecoder.curr;
      if (curr !== null) {
        let currClient = curr.id.client;
        let currClock = curr.id.clock;
        from2.set(currClient, currClock);
        for (; curr !== null; curr = updateDecoder.next()) {
          if (currClient !== curr.id.client) {
            to.set(currClient, currClock);
            from2.set(curr.id.client, curr.id.clock);
            currClient = curr.id.client;
          }
          currClock = curr.id.clock + curr.length;
        }
        to.set(currClient, currClock);
      }
      return { from: from2, to };
    };
    parseUpdateMeta = (update) => parseUpdateMetaV2(update, UpdateDecoderV1);
    sliceStruct = (left, diff) => {
      if (left.constructor === GC) {
        const { client, clock } = left.id;
        return new GC(createID(client, clock + diff), left.length - diff);
      } else if (left.constructor === Skip) {
        const { client, clock } = left.id;
        return new Skip(createID(client, clock + diff), left.length - diff);
      } else {
        const leftItem = (
          /** @type {Item} */
          left
        );
        const { client, clock } = leftItem.id;
        return new Item(
          createID(client, clock + diff),
          null,
          createID(client, clock + diff - 1),
          null,
          leftItem.rightOrigin,
          leftItem.parent,
          leftItem.parentSub,
          leftItem.content.splice(diff)
        );
      }
    };
    mergeUpdatesV2 = (updates, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
      if (updates.length === 1) {
        return updates[0];
      }
      const updateDecoders = updates.map((update) => new YDecoder(createDecoder(update)));
      let lazyStructDecoders = updateDecoders.map((decoder) => new LazyStructReader(decoder, true));
      let currWrite = null;
      const updateEncoder = new YEncoder();
      const lazyStructEncoder = new LazyStructWriter(updateEncoder);
      while (true) {
        lazyStructDecoders = lazyStructDecoders.filter((dec) => dec.curr !== null);
        lazyStructDecoders.sort(
          /** @type {function(any,any):number} */
          (dec1, dec2) => {
            if (dec1.curr.id.client === dec2.curr.id.client) {
              const clockDiff = dec1.curr.id.clock - dec2.curr.id.clock;
              if (clockDiff === 0) {
                return dec1.curr.constructor === dec2.curr.constructor ? 0 : dec1.curr.constructor === Skip ? 1 : -1;
              } else {
                return clockDiff;
              }
            } else {
              return dec2.curr.id.client - dec1.curr.id.client;
            }
          }
        );
        if (lazyStructDecoders.length === 0) {
          break;
        }
        const currDecoder = lazyStructDecoders[0];
        const firstClient = (
          /** @type {Item | GC} */
          currDecoder.curr.id.client
        );
        if (currWrite !== null) {
          let curr = (
            /** @type {Item | GC | null} */
            currDecoder.curr
          );
          let iterated = false;
          while (curr !== null && curr.id.clock + curr.length <= currWrite.struct.id.clock + currWrite.struct.length && curr.id.client >= currWrite.struct.id.client) {
            curr = currDecoder.next();
            iterated = true;
          }
          if (curr === null || // current decoder is empty
          curr.id.client !== firstClient || // check whether there is another decoder that has has updates from `firstClient`
          iterated && curr.id.clock > currWrite.struct.id.clock + currWrite.struct.length) {
            continue;
          }
          if (firstClient !== currWrite.struct.id.client) {
            writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
            currWrite = { struct: curr, offset: 0 };
            currDecoder.next();
          } else {
            if (currWrite.struct.id.clock + currWrite.struct.length < curr.id.clock) {
              if (currWrite.struct.constructor === Skip) {
                currWrite.struct.length = curr.id.clock + curr.length - currWrite.struct.id.clock;
              } else {
                writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
                const diff = curr.id.clock - currWrite.struct.id.clock - currWrite.struct.length;
                const struct = new Skip(createID(firstClient, currWrite.struct.id.clock + currWrite.struct.length), diff);
                currWrite = { struct, offset: 0 };
              }
            } else {
              const diff = currWrite.struct.id.clock + currWrite.struct.length - curr.id.clock;
              if (diff > 0) {
                if (currWrite.struct.constructor === Skip) {
                  currWrite.struct.length -= diff;
                } else {
                  curr = sliceStruct(curr, diff);
                }
              }
              if (!currWrite.struct.mergeWith(
                /** @type {any} */
                curr
              )) {
                writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
                currWrite = { struct: curr, offset: 0 };
                currDecoder.next();
              }
            }
          }
        } else {
          currWrite = { struct: (
            /** @type {Item | GC} */
            currDecoder.curr
          ), offset: 0 };
          currDecoder.next();
        }
        for (let next = currDecoder.curr; next !== null && next.id.client === firstClient && next.id.clock === currWrite.struct.id.clock + currWrite.struct.length && next.constructor !== Skip; next = currDecoder.next()) {
          writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
          currWrite = { struct: next, offset: 0 };
        }
      }
      if (currWrite !== null) {
        writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
        currWrite = null;
      }
      finishLazyStructWriting(lazyStructEncoder);
      const dss = updateDecoders.map((decoder) => readDeleteSet(decoder));
      const ds = mergeDeleteSets(dss);
      writeDeleteSet(updateEncoder, ds);
      return updateEncoder.toUint8Array();
    };
    diffUpdateV2 = (update, sv, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
      const state = decodeStateVector(sv);
      const encoder = new YEncoder();
      const lazyStructWriter = new LazyStructWriter(encoder);
      const decoder = new YDecoder(createDecoder(update));
      const reader = new LazyStructReader(decoder, false);
      while (reader.curr) {
        const curr = reader.curr;
        const currClient = curr.id.client;
        const svClock = state.get(currClient) || 0;
        if (reader.curr.constructor === Skip) {
          reader.next();
          continue;
        }
        if (curr.id.clock + curr.length > svClock) {
          writeStructToLazyStructWriter(lazyStructWriter, curr, max(svClock - curr.id.clock, 0));
          reader.next();
          while (reader.curr && reader.curr.id.client === currClient) {
            writeStructToLazyStructWriter(lazyStructWriter, reader.curr, 0);
            reader.next();
          }
        } else {
          while (reader.curr && reader.curr.id.client === currClient && reader.curr.id.clock + reader.curr.length <= svClock) {
            reader.next();
          }
        }
      }
      finishLazyStructWriting(lazyStructWriter);
      const ds = readDeleteSet(decoder);
      writeDeleteSet(encoder, ds);
      return encoder.toUint8Array();
    };
    diffUpdate = (update, sv) => diffUpdateV2(update, sv, UpdateDecoderV1, UpdateEncoderV1);
    flushLazyStructWriter = (lazyWriter) => {
      if (lazyWriter.written > 0) {
        lazyWriter.clientStructs.push({ written: lazyWriter.written, restEncoder: toUint8Array(lazyWriter.encoder.restEncoder) });
        lazyWriter.encoder.restEncoder = createEncoder();
        lazyWriter.written = 0;
      }
    };
    writeStructToLazyStructWriter = (lazyWriter, struct, offset) => {
      if (lazyWriter.written > 0 && lazyWriter.currClient !== struct.id.client) {
        flushLazyStructWriter(lazyWriter);
      }
      if (lazyWriter.written === 0) {
        lazyWriter.currClient = struct.id.client;
        lazyWriter.encoder.writeClient(struct.id.client);
        writeVarUint(lazyWriter.encoder.restEncoder, struct.id.clock + offset);
      }
      struct.write(lazyWriter.encoder, offset);
      lazyWriter.written++;
    };
    finishLazyStructWriting = (lazyWriter) => {
      flushLazyStructWriter(lazyWriter);
      const restEncoder = lazyWriter.encoder.restEncoder;
      writeVarUint(restEncoder, lazyWriter.clientStructs.length);
      for (let i = 0; i < lazyWriter.clientStructs.length; i++) {
        const partStructs = lazyWriter.clientStructs[i];
        writeVarUint(restEncoder, partStructs.written);
        writeUint8Array(restEncoder, partStructs.restEncoder);
      }
    };
    convertUpdateFormat = (update, blockTransformer, YDecoder, YEncoder) => {
      const updateDecoder = new YDecoder(createDecoder(update));
      const lazyDecoder = new LazyStructReader(updateDecoder, false);
      const updateEncoder = new YEncoder();
      const lazyWriter = new LazyStructWriter(updateEncoder);
      for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
        writeStructToLazyStructWriter(lazyWriter, blockTransformer(curr), 0);
      }
      finishLazyStructWriting(lazyWriter);
      const ds = readDeleteSet(updateDecoder);
      writeDeleteSet(updateEncoder, ds);
      return updateEncoder.toUint8Array();
    };
    createObfuscator = ({ formatting = true, subdocs = true, yxml = true } = {}) => {
      let i = 0;
      const mapKeyCache = create();
      const nodeNameCache = create();
      const formattingKeyCache = create();
      const formattingValueCache = create();
      formattingValueCache.set(null, null);
      return (block) => {
        switch (block.constructor) {
          case GC:
          case Skip:
            return block;
          case Item: {
            const item = (
              /** @type {Item} */
              block
            );
            const content = item.content;
            switch (content.constructor) {
              case ContentDeleted:
                break;
              case ContentType: {
                if (yxml) {
                  const type = (
                    /** @type {ContentType} */
                    content.type
                  );
                  if (type instanceof YXmlElement) {
                    type.nodeName = setIfUndefined(nodeNameCache, type.nodeName, () => "node-" + i);
                  }
                  if (type instanceof YXmlHook) {
                    type.hookName = setIfUndefined(nodeNameCache, type.hookName, () => "hook-" + i);
                  }
                }
                break;
              }
              case ContentAny: {
                const c = (
                  /** @type {ContentAny} */
                  content
                );
                c.arr = c.arr.map(() => i);
                break;
              }
              case ContentBinary: {
                const c = (
                  /** @type {ContentBinary} */
                  content
                );
                c.content = new Uint8Array([i]);
                break;
              }
              case ContentDoc: {
                const c = (
                  /** @type {ContentDoc} */
                  content
                );
                if (subdocs) {
                  c.opts = {};
                  c.doc.guid = i + "";
                }
                break;
              }
              case ContentEmbed: {
                const c = (
                  /** @type {ContentEmbed} */
                  content
                );
                c.embed = {};
                break;
              }
              case ContentFormat: {
                const c = (
                  /** @type {ContentFormat} */
                  content
                );
                if (formatting) {
                  c.key = setIfUndefined(formattingKeyCache, c.key, () => i + "");
                  c.value = setIfUndefined(formattingValueCache, c.value, () => ({ i }));
                }
                break;
              }
              case ContentJSON: {
                const c = (
                  /** @type {ContentJSON} */
                  content
                );
                c.arr = c.arr.map(() => i);
                break;
              }
              case ContentString: {
                const c = (
                  /** @type {ContentString} */
                  content
                );
                c.str = repeat(i % 10 + "", c.str.length);
                break;
              }
              default:
                unexpectedCase();
            }
            if (item.parentSub) {
              item.parentSub = setIfUndefined(mapKeyCache, item.parentSub, () => i + "");
            }
            i++;
            return block;
          }
          default:
            unexpectedCase();
        }
      };
    };
    obfuscateUpdate = (update, opts) => convertUpdateFormat(update, createObfuscator(opts), UpdateDecoderV1, UpdateEncoderV1);
    obfuscateUpdateV2 = (update, opts) => convertUpdateFormat(update, createObfuscator(opts), UpdateDecoderV2, UpdateEncoderV2);
    convertUpdateFormatV1ToV2 = (update) => convertUpdateFormat(update, id, UpdateDecoderV1, UpdateEncoderV2);
    convertUpdateFormatV2ToV1 = (update) => convertUpdateFormat(update, id, UpdateDecoderV2, UpdateEncoderV1);
    errorComputeChanges = "You must not compute changes after the event-handler fired.";
    YEvent = class {
      /**
       * @param {T} target The changed type.
       * @param {Transaction} transaction
       */
      constructor(target, transaction) {
        this.target = target;
        this.currentTarget = target;
        this.transaction = transaction;
        this._changes = null;
        this._keys = null;
        this._delta = null;
        this._path = null;
      }
      /**
       * Computes the path from `y` to the changed type.
       *
       * @todo v14 should standardize on path: Array<{parent, index}> because that is easier to work with.
       *
       * The following property holds:
       * @example
       *   let type = y
       *   event.path.forEach(dir => {
       *     type = type.get(dir)
       *   })
       *   type === event.target // => true
       */
      get path() {
        return this._path || (this._path = getPathTo(this.currentTarget, this.target));
      }
      /**
       * Check if a struct is deleted by this event.
       *
       * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
       *
       * @param {AbstractStruct} struct
       * @return {boolean}
       */
      deletes(struct) {
        return isDeleted(this.transaction.deleteSet, struct.id);
      }
      /**
       * @type {Map<string, { action: 'add' | 'update' | 'delete', oldValue: any }>}
       */
      get keys() {
        if (this._keys === null) {
          if (this.transaction.doc._transactionCleanups.length === 0) {
            throw create3(errorComputeChanges);
          }
          const keys2 = /* @__PURE__ */ new Map();
          const target = this.target;
          const changed = (
            /** @type Set<string|null> */
            this.transaction.changed.get(target)
          );
          changed.forEach((key) => {
            if (key !== null) {
              const item = (
                /** @type {Item} */
                target._map.get(key)
              );
              let action;
              let oldValue;
              if (this.adds(item)) {
                let prev = item.left;
                while (prev !== null && this.adds(prev)) {
                  prev = prev.left;
                }
                if (this.deletes(item)) {
                  if (prev !== null && this.deletes(prev)) {
                    action = "delete";
                    oldValue = last(prev.content.getContent());
                  } else {
                    return;
                  }
                } else {
                  if (prev !== null && this.deletes(prev)) {
                    action = "update";
                    oldValue = last(prev.content.getContent());
                  } else {
                    action = "add";
                    oldValue = void 0;
                  }
                }
              } else {
                if (this.deletes(item)) {
                  action = "delete";
                  oldValue = last(
                    /** @type {Item} */
                    item.content.getContent()
                  );
                } else {
                  return;
                }
              }
              keys2.set(key, { action, oldValue });
            }
          });
          this._keys = keys2;
        }
        return this._keys;
      }
      /**
       * This is a computed property. Note that this can only be safely computed during the
       * event call. Computing this property after other changes happened might result in
       * unexpected behavior (incorrect computation of deltas). A safe way to collect changes
       * is to store the `changes` or the `delta` object. Avoid storing the `transaction` object.
       *
       * @type {Array<{insert?: string | Array<any> | object | AbstractType<any>, retain?: number, delete?: number, attributes?: Object<string, any>}>}
       */
      get delta() {
        return this.changes.delta;
      }
      /**
       * Check if a struct is added by this event.
       *
       * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
       *
       * @param {AbstractStruct} struct
       * @return {boolean}
       */
      adds(struct) {
        return struct.id.clock >= (this.transaction.beforeState.get(struct.id.client) || 0);
      }
      /**
       * This is a computed property. Note that this can only be safely computed during the
       * event call. Computing this property after other changes happened might result in
       * unexpected behavior (incorrect computation of deltas). A safe way to collect changes
       * is to store the `changes` or the `delta` object. Avoid storing the `transaction` object.
       *
       * @type {{added:Set<Item>,deleted:Set<Item>,keys:Map<string,{action:'add'|'update'|'delete',oldValue:any}>,delta:Array<{insert?:Array<any>|string, delete?:number, retain?:number}>}}
       */
      get changes() {
        let changes = this._changes;
        if (changes === null) {
          if (this.transaction.doc._transactionCleanups.length === 0) {
            throw create3(errorComputeChanges);
          }
          const target = this.target;
          const added = create2();
          const deleted = create2();
          const delta = [];
          changes = {
            added,
            deleted,
            delta,
            keys: this.keys
          };
          const changed = (
            /** @type Set<string|null> */
            this.transaction.changed.get(target)
          );
          if (changed.has(null)) {
            let lastOp = null;
            const packOp = () => {
              if (lastOp) {
                delta.push(lastOp);
              }
            };
            for (let item = target._start; item !== null; item = item.right) {
              if (item.deleted) {
                if (this.deletes(item) && !this.adds(item)) {
                  if (lastOp === null || lastOp.delete === void 0) {
                    packOp();
                    lastOp = { delete: 0 };
                  }
                  lastOp.delete += item.length;
                  deleted.add(item);
                }
              } else {
                if (this.adds(item)) {
                  if (lastOp === null || lastOp.insert === void 0) {
                    packOp();
                    lastOp = { insert: [] };
                  }
                  lastOp.insert = lastOp.insert.concat(item.content.getContent());
                  added.add(item);
                } else {
                  if (lastOp === null || lastOp.retain === void 0) {
                    packOp();
                    lastOp = { retain: 0 };
                  }
                  lastOp.retain += item.length;
                }
              }
            }
            if (lastOp !== null && lastOp.retain === void 0) {
              packOp();
            }
          }
          this._changes = changes;
        }
        return (
          /** @type {any} */
          changes
        );
      }
    };
    getPathTo = (parent, child) => {
      const path = [];
      while (child._item !== null && child !== parent) {
        if (child._item.parentSub !== null) {
          path.unshift(child._item.parentSub);
        } else {
          let i = 0;
          let c = (
            /** @type {AbstractType<any>} */
            child._item.parent._start
          );
          while (c !== child._item && c !== null) {
            if (!c.deleted && c.countable) {
              i += c.length;
            }
            c = c.right;
          }
          path.unshift(i);
        }
        child = /** @type {AbstractType<any>} */
        child._item.parent;
      }
      return path;
    };
    warnPrematureAccess = () => {
      warn("Invalid access: Add Yjs type to a document before reading data.");
    };
    maxSearchMarker = 80;
    globalSearchMarkerTimestamp = 0;
    ArraySearchMarker = class {
      /**
       * @param {Item} p
       * @param {number} index
       */
      constructor(p, index) {
        p.marker = true;
        this.p = p;
        this.index = index;
        this.timestamp = globalSearchMarkerTimestamp++;
      }
    };
    refreshMarkerTimestamp = (marker) => {
      marker.timestamp = globalSearchMarkerTimestamp++;
    };
    overwriteMarker = (marker, p, index) => {
      marker.p.marker = false;
      marker.p = p;
      p.marker = true;
      marker.index = index;
      marker.timestamp = globalSearchMarkerTimestamp++;
    };
    markPosition = (searchMarker, p, index) => {
      if (searchMarker.length >= maxSearchMarker) {
        const marker = searchMarker.reduce((a, b) => a.timestamp < b.timestamp ? a : b);
        overwriteMarker(marker, p, index);
        return marker;
      } else {
        const pm = new ArraySearchMarker(p, index);
        searchMarker.push(pm);
        return pm;
      }
    };
    findMarker = (yarray, index) => {
      if (yarray._start === null || index === 0 || yarray._searchMarker === null) {
        return null;
      }
      const marker = yarray._searchMarker.length === 0 ? null : yarray._searchMarker.reduce((a, b) => abs(index - a.index) < abs(index - b.index) ? a : b);
      let p = yarray._start;
      let pindex = 0;
      if (marker !== null) {
        p = marker.p;
        pindex = marker.index;
        refreshMarkerTimestamp(marker);
      }
      while (p.right !== null && pindex < index) {
        if (!p.deleted && p.countable) {
          if (index < pindex + p.length) {
            break;
          }
          pindex += p.length;
        }
        p = p.right;
      }
      while (p.left !== null && pindex > index) {
        p = p.left;
        if (!p.deleted && p.countable) {
          pindex -= p.length;
        }
      }
      while (p.left !== null && p.left.id.client === p.id.client && p.left.id.clock + p.left.length === p.id.clock) {
        p = p.left;
        if (!p.deleted && p.countable) {
          pindex -= p.length;
        }
      }
      if (marker !== null && abs(marker.index - pindex) < /** @type {YText|YArray<any>} */
      p.parent.length / maxSearchMarker) {
        overwriteMarker(marker, p, pindex);
        return marker;
      } else {
        return markPosition(yarray._searchMarker, p, pindex);
      }
    };
    updateMarkerChanges = (searchMarker, index, len) => {
      for (let i = searchMarker.length - 1; i >= 0; i--) {
        const m = searchMarker[i];
        if (len > 0) {
          let p = m.p;
          p.marker = false;
          while (p && (p.deleted || !p.countable)) {
            p = p.left;
            if (p && !p.deleted && p.countable) {
              m.index -= p.length;
            }
          }
          if (p === null || p.marker === true) {
            searchMarker.splice(i, 1);
            continue;
          }
          m.p = p;
          p.marker = true;
        }
        if (index < m.index || len > 0 && index === m.index) {
          m.index = max(index, m.index + len);
        }
      }
    };
    getTypeChildren = (t) => {
      t.doc ?? warnPrematureAccess();
      let s = t._start;
      const arr = [];
      while (s) {
        arr.push(s);
        s = s.right;
      }
      return arr;
    };
    callTypeObservers = (type, transaction, event) => {
      const changedType = type;
      const changedParentTypes = transaction.changedParentTypes;
      while (true) {
        setIfUndefined(changedParentTypes, type, () => []).push(event);
        if (type._item === null) {
          break;
        }
        type = /** @type {AbstractType<any>} */
        type._item.parent;
      }
      callEventHandlerListeners(changedType._eH, event, transaction);
    };
    AbstractType = class {
      constructor() {
        this._item = null;
        this._map = /* @__PURE__ */ new Map();
        this._start = null;
        this.doc = null;
        this._length = 0;
        this._eH = createEventHandler();
        this._dEH = createEventHandler();
        this._searchMarker = null;
      }
      /**
       * @return {AbstractType<any>|null}
       */
      get parent() {
        return this._item ? (
          /** @type {AbstractType<any>} */
          this._item.parent
        ) : null;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item|null} item
       */
      _integrate(y, item) {
        this.doc = y;
        this._item = item;
      }
      /**
       * @return {AbstractType<EventType>}
       */
      _copy() {
        throw methodUnimplemented();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {AbstractType<EventType>}
       */
      clone() {
        throw methodUnimplemented();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder
       */
      _write(_encoder) {
      }
      /**
       * The first non-deleted item
       */
      get _first() {
        let n = this._start;
        while (n !== null && n.deleted) {
          n = n.right;
        }
        return n;
      }
      /**
       * Creates YEvent and calls all type observers.
       * Must be implemented by each type.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} _parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, _parentSubs) {
        if (!transaction.local && this._searchMarker) {
          this._searchMarker.length = 0;
        }
      }
      /**
       * Observe all events that are created on this type.
       *
       * @param {function(EventType, Transaction):void} f Observer function
       */
      observe(f) {
        addEventHandlerListener(this._eH, f);
      }
      /**
       * Observe all events that are created by this type and its children.
       *
       * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
       */
      observeDeep(f) {
        addEventHandlerListener(this._dEH, f);
      }
      /**
       * Unregister an observer function.
       *
       * @param {function(EventType,Transaction):void} f Observer function
       */
      unobserve(f) {
        removeEventHandlerListener(this._eH, f);
      }
      /**
       * Unregister an observer function.
       *
       * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
       */
      unobserveDeep(f) {
        removeEventHandlerListener(this._dEH, f);
      }
      /**
       * @abstract
       * @return {any}
       */
      toJSON() {
      }
    };
    typeListSlice = (type, start, end) => {
      type.doc ?? warnPrematureAccess();
      if (start < 0) {
        start = type._length + start;
      }
      if (end < 0) {
        end = type._length + end;
      }
      let len = end - start;
      const cs = [];
      let n = type._start;
      while (n !== null && len > 0) {
        if (n.countable && !n.deleted) {
          const c = n.content.getContent();
          if (c.length <= start) {
            start -= c.length;
          } else {
            for (let i = start; i < c.length && len > 0; i++) {
              cs.push(c[i]);
              len--;
            }
            start = 0;
          }
        }
        n = n.right;
      }
      return cs;
    };
    typeListToArray = (type) => {
      type.doc ?? warnPrematureAccess();
      const cs = [];
      let n = type._start;
      while (n !== null) {
        if (n.countable && !n.deleted) {
          const c = n.content.getContent();
          for (let i = 0; i < c.length; i++) {
            cs.push(c[i]);
          }
        }
        n = n.right;
      }
      return cs;
    };
    typeListToArraySnapshot = (type, snapshot2) => {
      const cs = [];
      let n = type._start;
      while (n !== null) {
        if (n.countable && isVisible(n, snapshot2)) {
          const c = n.content.getContent();
          for (let i = 0; i < c.length; i++) {
            cs.push(c[i]);
          }
        }
        n = n.right;
      }
      return cs;
    };
    typeListForEach = (type, f) => {
      let index = 0;
      let n = type._start;
      type.doc ?? warnPrematureAccess();
      while (n !== null) {
        if (n.countable && !n.deleted) {
          const c = n.content.getContent();
          for (let i = 0; i < c.length; i++) {
            f(c[i], index++, type);
          }
        }
        n = n.right;
      }
    };
    typeListMap = (type, f) => {
      const result = [];
      typeListForEach(type, (c, i) => {
        result.push(f(c, i, type));
      });
      return result;
    };
    typeListCreateIterator = (type) => {
      let n = type._start;
      let currentContent = null;
      let currentContentIndex = 0;
      return {
        [Symbol.iterator]() {
          return this;
        },
        next: () => {
          if (currentContent === null) {
            while (n !== null && n.deleted) {
              n = n.right;
            }
            if (n === null) {
              return {
                done: true,
                value: void 0
              };
            }
            currentContent = n.content.getContent();
            currentContentIndex = 0;
            n = n.right;
          }
          const value = currentContent[currentContentIndex++];
          if (currentContent.length <= currentContentIndex) {
            currentContent = null;
          }
          return {
            done: false,
            value
          };
        }
      };
    };
    typeListGet = (type, index) => {
      type.doc ?? warnPrematureAccess();
      const marker = findMarker(type, index);
      let n = type._start;
      if (marker !== null) {
        n = marker.p;
        index -= marker.index;
      }
      for (; n !== null; n = n.right) {
        if (!n.deleted && n.countable) {
          if (index < n.length) {
            return n.content.getContent()[index];
          }
          index -= n.length;
        }
      }
    };
    typeListInsertGenericsAfter = (transaction, parent, referenceItem, content) => {
      let left = referenceItem;
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      const store = doc.store;
      const right = referenceItem === null ? parent._start : referenceItem.right;
      let jsonContent = [];
      const packJsonContent = () => {
        if (jsonContent.length > 0) {
          left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentAny(jsonContent));
          left.integrate(transaction, 0);
          jsonContent = [];
        }
      };
      content.forEach((c) => {
        if (c === null) {
          jsonContent.push(c);
        } else {
          switch (c.constructor) {
            case Number:
            case Object:
            case Boolean:
            case Array:
            case String:
              jsonContent.push(c);
              break;
            default:
              packJsonContent();
              switch (c.constructor) {
                case Uint8Array:
                case ArrayBuffer:
                  left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentBinary(new Uint8Array(
                    /** @type {Uint8Array} */
                    c
                  )));
                  left.integrate(transaction, 0);
                  break;
                case Doc:
                  left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentDoc(
                    /** @type {Doc} */
                    c
                  ));
                  left.integrate(transaction, 0);
                  break;
                default:
                  if (c instanceof AbstractType) {
                    left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentType(c));
                    left.integrate(transaction, 0);
                  } else {
                    throw new Error("Unexpected content type in insert operation");
                  }
              }
          }
        }
      });
      packJsonContent();
    };
    lengthExceeded = () => create3("Length exceeded!");
    typeListInsertGenerics = (transaction, parent, index, content) => {
      if (index > parent._length) {
        throw lengthExceeded();
      }
      if (index === 0) {
        if (parent._searchMarker) {
          updateMarkerChanges(parent._searchMarker, index, content.length);
        }
        return typeListInsertGenericsAfter(transaction, parent, null, content);
      }
      const startIndex = index;
      const marker = findMarker(parent, index);
      let n = parent._start;
      if (marker !== null) {
        n = marker.p;
        index -= marker.index;
        if (index === 0) {
          n = n.prev;
          index += n && n.countable && !n.deleted ? n.length : 0;
        }
      }
      for (; n !== null; n = n.right) {
        if (!n.deleted && n.countable) {
          if (index <= n.length) {
            if (index < n.length) {
              getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index));
            }
            break;
          }
          index -= n.length;
        }
      }
      if (parent._searchMarker) {
        updateMarkerChanges(parent._searchMarker, startIndex, content.length);
      }
      return typeListInsertGenericsAfter(transaction, parent, n, content);
    };
    typeListPushGenerics = (transaction, parent, content) => {
      const marker = (parent._searchMarker || []).reduce((maxMarker, currMarker) => currMarker.index > maxMarker.index ? currMarker : maxMarker, { index: 0, p: parent._start });
      let n = marker.p;
      if (n) {
        while (n.right) {
          n = n.right;
        }
      }
      return typeListInsertGenericsAfter(transaction, parent, n, content);
    };
    typeListDelete = (transaction, parent, index, length2) => {
      if (length2 === 0) {
        return;
      }
      const startIndex = index;
      const startLength = length2;
      const marker = findMarker(parent, index);
      let n = parent._start;
      if (marker !== null) {
        n = marker.p;
        index -= marker.index;
      }
      for (; n !== null && index > 0; n = n.right) {
        if (!n.deleted && n.countable) {
          if (index < n.length) {
            getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index));
          }
          index -= n.length;
        }
      }
      while (length2 > 0 && n !== null) {
        if (!n.deleted) {
          if (length2 < n.length) {
            getItemCleanStart(transaction, createID(n.id.client, n.id.clock + length2));
          }
          n.delete(transaction);
          length2 -= n.length;
        }
        n = n.right;
      }
      if (length2 > 0) {
        throw lengthExceeded();
      }
      if (parent._searchMarker) {
        updateMarkerChanges(
          parent._searchMarker,
          startIndex,
          -startLength + length2
          /* in case we remove the above exception */
        );
      }
    };
    typeMapDelete = (transaction, parent, key) => {
      const c = parent._map.get(key);
      if (c !== void 0) {
        c.delete(transaction);
      }
    };
    typeMapSet = (transaction, parent, key, value) => {
      const left = parent._map.get(key) || null;
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      let content;
      if (value == null) {
        content = new ContentAny([value]);
      } else {
        switch (value.constructor) {
          case Number:
          case Object:
          case Boolean:
          case Array:
          case String:
          case Date:
          case BigInt:
            content = new ContentAny([value]);
            break;
          case Uint8Array:
            content = new ContentBinary(
              /** @type {Uint8Array} */
              value
            );
            break;
          case Doc:
            content = new ContentDoc(
              /** @type {Doc} */
              value
            );
            break;
          default:
            if (value instanceof AbstractType) {
              content = new ContentType(value);
            } else {
              throw new Error("Unexpected content type");
            }
        }
      }
      new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, null, null, parent, key, content).integrate(transaction, 0);
    };
    typeMapGet = (parent, key) => {
      parent.doc ?? warnPrematureAccess();
      const val = parent._map.get(key);
      return val !== void 0 && !val.deleted ? val.content.getContent()[val.length - 1] : void 0;
    };
    typeMapGetAll = (parent) => {
      const res = {};
      parent.doc ?? warnPrematureAccess();
      parent._map.forEach((value, key) => {
        if (!value.deleted) {
          res[key] = value.content.getContent()[value.length - 1];
        }
      });
      return res;
    };
    typeMapHas = (parent, key) => {
      parent.doc ?? warnPrematureAccess();
      const val = parent._map.get(key);
      return val !== void 0 && !val.deleted;
    };
    typeMapGetSnapshot = (parent, key, snapshot2) => {
      let v = parent._map.get(key) || null;
      while (v !== null && (!snapshot2.sv.has(v.id.client) || v.id.clock >= (snapshot2.sv.get(v.id.client) || 0))) {
        v = v.left;
      }
      return v !== null && isVisible(v, snapshot2) ? v.content.getContent()[v.length - 1] : void 0;
    };
    typeMapGetAllSnapshot = (parent, snapshot2) => {
      const res = {};
      parent._map.forEach((value, key) => {
        let v = value;
        while (v !== null && (!snapshot2.sv.has(v.id.client) || v.id.clock >= (snapshot2.sv.get(v.id.client) || 0))) {
          v = v.left;
        }
        if (v !== null && isVisible(v, snapshot2)) {
          res[key] = v.content.getContent()[v.length - 1];
        }
      });
      return res;
    };
    createMapIterator = (type) => {
      type.doc ?? warnPrematureAccess();
      return iteratorFilter(
        type._map.entries(),
        /** @param {any} entry */
        (entry) => !entry[1].deleted
      );
    };
    YArrayEvent = class extends YEvent {
    };
    YArray = class _YArray extends AbstractType {
      constructor() {
        super();
        this._prelimContent = [];
        this._searchMarker = [];
      }
      /**
       * Construct a new YArray containing the specified items.
       * @template {Object<string,any>|Array<any>|number|null|string|Uint8Array} T
       * @param {Array<T>} items
       * @return {YArray<T>}
       */
      static from(items) {
        const a = new _YArray();
        a.push(items);
        return a;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        this.insert(
          0,
          /** @type {Array<any>} */
          this._prelimContent
        );
        this._prelimContent = null;
      }
      /**
       * @return {YArray<T>}
       */
      _copy() {
        return new _YArray();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YArray<T>}
       */
      clone() {
        const arr = new _YArray();
        arr.insert(0, this.toArray().map(
          (el) => el instanceof AbstractType ? (
            /** @type {typeof el} */
            el.clone()
          ) : el
        ));
        return arr;
      }
      get length() {
        this.doc ?? warnPrematureAccess();
        return this._length;
      }
      /**
       * Creates YArrayEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        super._callObserver(transaction, parentSubs);
        callTypeObservers(this, transaction, new YArrayEvent(this, transaction));
      }
      /**
       * Inserts new content at an index.
       *
       * Important: This function expects an array of content. Not just a content
       * object. The reason for this "weirdness" is that inserting several elements
       * is very efficient when it is done as a single operation.
       *
       * @example
       *  // Insert character 'a' at position 0
       *  yarray.insert(0, ['a'])
       *  // Insert numbers 1, 2 at position 1
       *  yarray.insert(1, [1, 2])
       *
       * @param {number} index The index to insert content at.
       * @param {Array<T>} content The array of content
       */
      insert(index, content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListInsertGenerics(
              transaction,
              this,
              index,
              /** @type {any} */
              content
            );
          });
        } else {
          this._prelimContent.splice(index, 0, ...content);
        }
      }
      /**
       * Appends content to this YArray.
       *
       * @param {Array<T>} content Array of content to append.
       *
       * @todo Use the following implementation in all types.
       */
      push(content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListPushGenerics(
              transaction,
              this,
              /** @type {any} */
              content
            );
          });
        } else {
          this._prelimContent.push(...content);
        }
      }
      /**
       * Prepends content to this YArray.
       *
       * @param {Array<T>} content Array of content to prepend.
       */
      unshift(content) {
        this.insert(0, content);
      }
      /**
       * Deletes elements starting from an index.
       *
       * @param {number} index Index at which to start deleting elements
       * @param {number} length The number of elements to remove. Defaults to 1.
       */
      delete(index, length2 = 1) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListDelete(transaction, this, index, length2);
          });
        } else {
          this._prelimContent.splice(index, length2);
        }
      }
      /**
       * Returns the i-th element from a YArray.
       *
       * @param {number} index The index of the element to return from the YArray
       * @return {T}
       */
      get(index) {
        return typeListGet(this, index);
      }
      /**
       * Transforms this YArray to a JavaScript Array.
       *
       * @return {Array<T>}
       */
      toArray() {
        return typeListToArray(this);
      }
      /**
       * Returns a portion of this YArray into a JavaScript Array selected
       * from start to end (end not included).
       *
       * @param {number} [start]
       * @param {number} [end]
       * @return {Array<T>}
       */
      slice(start = 0, end = this.length) {
        return typeListSlice(this, start, end);
      }
      /**
       * Transforms this Shared Type to a JSON object.
       *
       * @return {Array<any>}
       */
      toJSON() {
        return this.map((c) => c instanceof AbstractType ? c.toJSON() : c);
      }
      /**
       * Returns an Array with the result of calling a provided function on every
       * element of this YArray.
       *
       * @template M
       * @param {function(T,number,YArray<T>):M} f Function that produces an element of the new Array
       * @return {Array<M>} A new array with each element being the result of the
       *                 callback function
       */
      map(f) {
        return typeListMap(
          this,
          /** @type {any} */
          f
        );
      }
      /**
       * Executes a provided function once on every element of this YArray.
       *
       * @param {function(T,number,YArray<T>):void} f A function to execute on every element of this YArray.
       */
      forEach(f) {
        typeListForEach(this, f);
      }
      /**
       * @return {IterableIterator<T>}
       */
      [Symbol.iterator]() {
        return typeListCreateIterator(this);
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder) {
        encoder.writeTypeRef(YArrayRefID);
      }
    };
    readYArray = (_decoder) => new YArray();
    YMapEvent = class extends YEvent {
      /**
       * @param {YMap<T>} ymap The YArray that changed.
       * @param {Transaction} transaction
       * @param {Set<any>} subs The keys that changed.
       */
      constructor(ymap, transaction, subs) {
        super(ymap, transaction);
        this.keysChanged = subs;
      }
    };
    YMap = class _YMap extends AbstractType {
      /**
       *
       * @param {Iterable<readonly [string, any]>=} entries - an optional iterable to initialize the YMap
       */
      constructor(entries) {
        super();
        this._prelimContent = null;
        if (entries === void 0) {
          this._prelimContent = /* @__PURE__ */ new Map();
        } else {
          this._prelimContent = new Map(entries);
        }
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        this._prelimContent.forEach((value, key) => {
          this.set(key, value);
        });
        this._prelimContent = null;
      }
      /**
       * @return {YMap<MapType>}
       */
      _copy() {
        return new _YMap();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YMap<MapType>}
       */
      clone() {
        const map = new _YMap();
        this.forEach((value, key) => {
          map.set(key, value instanceof AbstractType ? (
            /** @type {typeof value} */
            value.clone()
          ) : value);
        });
        return map;
      }
      /**
       * Creates YMapEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        callTypeObservers(this, transaction, new YMapEvent(this, transaction, parentSubs));
      }
      /**
       * Transforms this Shared Type to a JSON object.
       *
       * @return {Object<string,any>}
       */
      toJSON() {
        this.doc ?? warnPrematureAccess();
        const map = {};
        this._map.forEach((item, key) => {
          if (!item.deleted) {
            const v = item.content.getContent()[item.length - 1];
            map[key] = v instanceof AbstractType ? v.toJSON() : v;
          }
        });
        return map;
      }
      /**
       * Returns the size of the YMap (count of key/value pairs)
       *
       * @return {number}
       */
      get size() {
        return [...createMapIterator(this)].length;
      }
      /**
       * Returns the keys for each element in the YMap Type.
       *
       * @return {IterableIterator<string>}
       */
      keys() {
        return iteratorMap(
          createMapIterator(this),
          /** @param {any} v */
          (v) => v[0]
        );
      }
      /**
       * Returns the values for each element in the YMap Type.
       *
       * @return {IterableIterator<MapType>}
       */
      values() {
        return iteratorMap(
          createMapIterator(this),
          /** @param {any} v */
          (v) => v[1].content.getContent()[v[1].length - 1]
        );
      }
      /**
       * Returns an Iterator of [key, value] pairs
       *
       * @return {IterableIterator<[string, MapType]>}
       */
      entries() {
        return iteratorMap(
          createMapIterator(this),
          /** @param {any} v */
          (v) => (
            /** @type {any} */
            [v[0], v[1].content.getContent()[v[1].length - 1]]
          )
        );
      }
      /**
       * Executes a provided function on once on every key-value pair.
       *
       * @param {function(MapType,string,YMap<MapType>):void} f A function to execute on every element of this YArray.
       */
      forEach(f) {
        this.doc ?? warnPrematureAccess();
        this._map.forEach((item, key) => {
          if (!item.deleted) {
            f(item.content.getContent()[item.length - 1], key, this);
          }
        });
      }
      /**
       * Returns an Iterator of [key, value] pairs
       *
       * @return {IterableIterator<[string, MapType]>}
       */
      [Symbol.iterator]() {
        return this.entries();
      }
      /**
       * Remove a specified element from this YMap.
       *
       * @param {string} key The key of the element to remove.
       */
      delete(key) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapDelete(transaction, this, key);
          });
        } else {
          this._prelimContent.delete(key);
        }
      }
      /**
       * Adds or updates an element with a specified key and value.
       * @template {MapType} VAL
       *
       * @param {string} key The key of the element to add to this YMap
       * @param {VAL} value The value of the element to add
       * @return {VAL}
       */
      set(key, value) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapSet(
              transaction,
              this,
              key,
              /** @type {any} */
              value
            );
          });
        } else {
          this._prelimContent.set(key, value);
        }
        return value;
      }
      /**
       * Returns a specified element from this YMap.
       *
       * @param {string} key
       * @return {MapType|undefined}
       */
      get(key) {
        return (
          /** @type {any} */
          typeMapGet(this, key)
        );
      }
      /**
       * Returns a boolean indicating whether the specified key exists or not.
       *
       * @param {string} key The key to test.
       * @return {boolean}
       */
      has(key) {
        return typeMapHas(this, key);
      }
      /**
       * Removes all elements from this YMap.
       */
      clear() {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            this.forEach(function(_value, key, map) {
              typeMapDelete(transaction, map, key);
            });
          });
        } else {
          this._prelimContent.clear();
        }
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder) {
        encoder.writeTypeRef(YMapRefID);
      }
    };
    readYMap = (_decoder) => new YMap();
    equalAttrs = (a, b) => a === b || typeof a === "object" && typeof b === "object" && a && b && equalFlat(a, b);
    ItemTextListPosition = class {
      /**
       * @param {Item|null} left
       * @param {Item|null} right
       * @param {number} index
       * @param {Map<string,any>} currentAttributes
       */
      constructor(left, right, index, currentAttributes) {
        this.left = left;
        this.right = right;
        this.index = index;
        this.currentAttributes = currentAttributes;
      }
      /**
       * Only call this if you know that this.right is defined
       */
      forward() {
        if (this.right === null) {
          unexpectedCase();
        }
        switch (this.right.content.constructor) {
          case ContentFormat:
            if (!this.right.deleted) {
              updateCurrentAttributes(
                this.currentAttributes,
                /** @type {ContentFormat} */
                this.right.content
              );
            }
            break;
          default:
            if (!this.right.deleted) {
              this.index += this.right.length;
            }
            break;
        }
        this.left = this.right;
        this.right = this.right.right;
      }
    };
    findNextPosition = (transaction, pos, count) => {
      while (pos.right !== null && count > 0) {
        switch (pos.right.content.constructor) {
          case ContentFormat:
            if (!pos.right.deleted) {
              updateCurrentAttributes(
                pos.currentAttributes,
                /** @type {ContentFormat} */
                pos.right.content
              );
            }
            break;
          default:
            if (!pos.right.deleted) {
              if (count < pos.right.length) {
                getItemCleanStart(transaction, createID(pos.right.id.client, pos.right.id.clock + count));
              }
              pos.index += pos.right.length;
              count -= pos.right.length;
            }
            break;
        }
        pos.left = pos.right;
        pos.right = pos.right.right;
      }
      return pos;
    };
    findPosition = (transaction, parent, index, useSearchMarker) => {
      const currentAttributes = /* @__PURE__ */ new Map();
      const marker = useSearchMarker ? findMarker(parent, index) : null;
      if (marker) {
        const pos = new ItemTextListPosition(marker.p.left, marker.p, marker.index, currentAttributes);
        return findNextPosition(transaction, pos, index - marker.index);
      } else {
        const pos = new ItemTextListPosition(null, parent._start, 0, currentAttributes);
        return findNextPosition(transaction, pos, index);
      }
    };
    insertNegatedAttributes = (transaction, parent, currPos, negatedAttributes) => {
      while (currPos.right !== null && (currPos.right.deleted === true || currPos.right.content.constructor === ContentFormat && equalAttrs(
        negatedAttributes.get(
          /** @type {ContentFormat} */
          currPos.right.content.key
        ),
        /** @type {ContentFormat} */
        currPos.right.content.value
      ))) {
        if (!currPos.right.deleted) {
          negatedAttributes.delete(
            /** @type {ContentFormat} */
            currPos.right.content.key
          );
        }
        currPos.forward();
      }
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      negatedAttributes.forEach((val, key) => {
        const left = currPos.left;
        const right = currPos.right;
        const nextFormat = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val));
        nextFormat.integrate(transaction, 0);
        currPos.right = nextFormat;
        currPos.forward();
      });
    };
    updateCurrentAttributes = (currentAttributes, format) => {
      const { key, value } = format;
      if (value === null) {
        currentAttributes.delete(key);
      } else {
        currentAttributes.set(key, value);
      }
    };
    minimizeAttributeChanges = (currPos, attributes) => {
      while (true) {
        if (currPos.right === null) {
          break;
        } else if (currPos.right.deleted || currPos.right.content.constructor === ContentFormat && equalAttrs(
          attributes[
            /** @type {ContentFormat} */
            currPos.right.content.key
          ] ?? null,
          /** @type {ContentFormat} */
          currPos.right.content.value
        )) ;
        else {
          break;
        }
        currPos.forward();
      }
    };
    insertAttributes = (transaction, parent, currPos, attributes) => {
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      const negatedAttributes = /* @__PURE__ */ new Map();
      for (const key in attributes) {
        const val = attributes[key];
        const currentVal = currPos.currentAttributes.get(key) ?? null;
        if (!equalAttrs(currentVal, val)) {
          negatedAttributes.set(key, currentVal);
          const { left, right } = currPos;
          currPos.right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val));
          currPos.right.integrate(transaction, 0);
          currPos.forward();
        }
      }
      return negatedAttributes;
    };
    insertText = (transaction, parent, currPos, text, attributes) => {
      currPos.currentAttributes.forEach((_val, key) => {
        if (attributes[key] === void 0) {
          attributes[key] = null;
        }
      });
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      minimizeAttributeChanges(currPos, attributes);
      const negatedAttributes = insertAttributes(transaction, parent, currPos, attributes);
      const content = text.constructor === String ? new ContentString(
        /** @type {string} */
        text
      ) : text instanceof AbstractType ? new ContentType(text) : new ContentEmbed(text);
      let { left, right, index } = currPos;
      if (parent._searchMarker) {
        updateMarkerChanges(parent._searchMarker, currPos.index, content.getLength());
      }
      right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, content);
      right.integrate(transaction, 0);
      currPos.right = right;
      currPos.index = index;
      currPos.forward();
      insertNegatedAttributes(transaction, parent, currPos, negatedAttributes);
    };
    formatText = (transaction, parent, currPos, length2, attributes) => {
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      minimizeAttributeChanges(currPos, attributes);
      const negatedAttributes = insertAttributes(transaction, parent, currPos, attributes);
      iterationLoop: while (currPos.right !== null && (length2 > 0 || negatedAttributes.size > 0 && (currPos.right.deleted || currPos.right.content.constructor === ContentFormat))) {
        if (!currPos.right.deleted) {
          switch (currPos.right.content.constructor) {
            case ContentFormat: {
              const { key, value } = (
                /** @type {ContentFormat} */
                currPos.right.content
              );
              const attr = attributes[key];
              if (attr !== void 0) {
                if (equalAttrs(attr, value)) {
                  negatedAttributes.delete(key);
                } else {
                  if (length2 === 0) {
                    break iterationLoop;
                  }
                  negatedAttributes.set(key, value);
                }
                currPos.right.delete(transaction);
              } else {
                currPos.currentAttributes.set(key, value);
              }
              break;
            }
            default:
              if (length2 < currPos.right.length) {
                getItemCleanStart(transaction, createID(currPos.right.id.client, currPos.right.id.clock + length2));
              }
              length2 -= currPos.right.length;
              break;
          }
        }
        currPos.forward();
      }
      if (length2 > 0) {
        let newlines = "";
        for (; length2 > 0; length2--) {
          newlines += "\n";
        }
        currPos.right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), currPos.left, currPos.left && currPos.left.lastId, currPos.right, currPos.right && currPos.right.id, parent, null, new ContentString(newlines));
        currPos.right.integrate(transaction, 0);
        currPos.forward();
      }
      insertNegatedAttributes(transaction, parent, currPos, negatedAttributes);
    };
    cleanupFormattingGap = (transaction, start, curr, startAttributes, currAttributes) => {
      let end = start;
      const endFormats = create();
      while (end && (!end.countable || end.deleted)) {
        if (!end.deleted && end.content.constructor === ContentFormat) {
          const cf = (
            /** @type {ContentFormat} */
            end.content
          );
          endFormats.set(cf.key, cf);
        }
        end = end.right;
      }
      let cleanups = 0;
      let reachedCurr = false;
      while (start !== end) {
        if (curr === start) {
          reachedCurr = true;
        }
        if (!start.deleted) {
          const content = start.content;
          switch (content.constructor) {
            case ContentFormat: {
              const { key, value } = (
                /** @type {ContentFormat} */
                content
              );
              const startAttrValue = startAttributes.get(key) ?? null;
              if (endFormats.get(key) !== content || startAttrValue === value) {
                start.delete(transaction);
                cleanups++;
                if (!reachedCurr && (currAttributes.get(key) ?? null) === value && startAttrValue !== value) {
                  if (startAttrValue === null) {
                    currAttributes.delete(key);
                  } else {
                    currAttributes.set(key, startAttrValue);
                  }
                }
              }
              if (!reachedCurr && !start.deleted) {
                updateCurrentAttributes(
                  currAttributes,
                  /** @type {ContentFormat} */
                  content
                );
              }
              break;
            }
          }
        }
        start = /** @type {Item} */
        start.right;
      }
      return cleanups;
    };
    cleanupContextlessFormattingGap = (transaction, item) => {
      while (item && item.right && (item.right.deleted || !item.right.countable)) {
        item = item.right;
      }
      const attrs = /* @__PURE__ */ new Set();
      while (item && (item.deleted || !item.countable)) {
        if (!item.deleted && item.content.constructor === ContentFormat) {
          const key = (
            /** @type {ContentFormat} */
            item.content.key
          );
          if (attrs.has(key)) {
            item.delete(transaction);
          } else {
            attrs.add(key);
          }
        }
        item = item.left;
      }
    };
    cleanupYTextFormatting = (type) => {
      let res = 0;
      transact(
        /** @type {Doc} */
        type.doc,
        (transaction) => {
          let start = (
            /** @type {Item} */
            type._start
          );
          let end = type._start;
          let startAttributes = create();
          const currentAttributes = copy(startAttributes);
          while (end) {
            if (end.deleted === false) {
              switch (end.content.constructor) {
                case ContentFormat:
                  updateCurrentAttributes(
                    currentAttributes,
                    /** @type {ContentFormat} */
                    end.content
                  );
                  break;
                default:
                  res += cleanupFormattingGap(transaction, start, end, startAttributes, currentAttributes);
                  startAttributes = copy(currentAttributes);
                  start = end;
                  break;
              }
            }
            end = end.right;
          }
        }
      );
      return res;
    };
    cleanupYTextAfterTransaction = (transaction) => {
      const needFullCleanup = /* @__PURE__ */ new Set();
      const doc = transaction.doc;
      for (const [client, afterClock] of transaction.afterState.entries()) {
        const clock = transaction.beforeState.get(client) || 0;
        if (afterClock === clock) {
          continue;
        }
        iterateStructs(
          transaction,
          /** @type {Array<Item|GC>} */
          doc.store.clients.get(client),
          clock,
          afterClock,
          (item) => {
            if (!item.deleted && /** @type {Item} */
            item.content.constructor === ContentFormat && item.constructor !== GC) {
              needFullCleanup.add(
                /** @type {any} */
                item.parent
              );
            }
          }
        );
      }
      transact(doc, (t) => {
        iterateDeletedStructs(transaction, transaction.deleteSet, (item) => {
          if (item instanceof GC || !/** @type {YText} */
          item.parent._hasFormatting || needFullCleanup.has(
            /** @type {YText} */
            item.parent
          )) {
            return;
          }
          const parent = (
            /** @type {YText} */
            item.parent
          );
          if (item.content.constructor === ContentFormat) {
            needFullCleanup.add(parent);
          } else {
            cleanupContextlessFormattingGap(t, item);
          }
        });
        for (const yText of needFullCleanup) {
          cleanupYTextFormatting(yText);
        }
      });
    };
    deleteText = (transaction, currPos, length2) => {
      const startLength = length2;
      const startAttrs = copy(currPos.currentAttributes);
      const start = currPos.right;
      while (length2 > 0 && currPos.right !== null) {
        if (currPos.right.deleted === false) {
          switch (currPos.right.content.constructor) {
            case ContentType:
            case ContentEmbed:
            case ContentString:
              if (length2 < currPos.right.length) {
                getItemCleanStart(transaction, createID(currPos.right.id.client, currPos.right.id.clock + length2));
              }
              length2 -= currPos.right.length;
              currPos.right.delete(transaction);
              break;
          }
        }
        currPos.forward();
      }
      if (start) {
        cleanupFormattingGap(transaction, start, currPos.right, startAttrs, currPos.currentAttributes);
      }
      const parent = (
        /** @type {AbstractType<any>} */
        /** @type {Item} */
        (currPos.left || currPos.right).parent
      );
      if (parent._searchMarker) {
        updateMarkerChanges(parent._searchMarker, currPos.index, -startLength + length2);
      }
      return currPos;
    };
    YTextEvent = class extends YEvent {
      /**
       * @param {YText} ytext
       * @param {Transaction} transaction
       * @param {Set<any>} subs The keys that changed
       */
      constructor(ytext, transaction, subs) {
        super(ytext, transaction);
        this.childListChanged = false;
        this.keysChanged = /* @__PURE__ */ new Set();
        subs.forEach((sub) => {
          if (sub === null) {
            this.childListChanged = true;
          } else {
            this.keysChanged.add(sub);
          }
        });
      }
      /**
       * @type {{added:Set<Item>,deleted:Set<Item>,keys:Map<string,{action:'add'|'update'|'delete',oldValue:any}>,delta:Array<{insert?:Array<any>|string, delete?:number, retain?:number}>}}
       */
      get changes() {
        if (this._changes === null) {
          const changes = {
            keys: this.keys,
            delta: this.delta,
            added: /* @__PURE__ */ new Set(),
            deleted: /* @__PURE__ */ new Set()
          };
          this._changes = changes;
        }
        return (
          /** @type {any} */
          this._changes
        );
      }
      /**
       * Compute the changes in the delta format.
       * A {@link https://quilljs.com/docs/delta/|Quill Delta}) that represents the changes on the document.
       *
       * @type {Array<{insert?:string|object|AbstractType<any>, delete?:number, retain?:number, attributes?: Object<string,any>}>}
       *
       * @public
       */
      get delta() {
        if (this._delta === null) {
          const y = (
            /** @type {Doc} */
            this.target.doc
          );
          const delta = [];
          transact(y, (transaction) => {
            const currentAttributes = /* @__PURE__ */ new Map();
            const oldAttributes = /* @__PURE__ */ new Map();
            let item = this.target._start;
            let action = null;
            const attributes = {};
            let insert = "";
            let retain = 0;
            let deleteLen = 0;
            const addOp = () => {
              if (action !== null) {
                let op = null;
                switch (action) {
                  case "delete":
                    if (deleteLen > 0) {
                      op = { delete: deleteLen };
                    }
                    deleteLen = 0;
                    break;
                  case "insert":
                    if (typeof insert === "object" || insert.length > 0) {
                      op = { insert };
                      if (currentAttributes.size > 0) {
                        op.attributes = {};
                        currentAttributes.forEach((value, key) => {
                          if (value !== null) {
                            op.attributes[key] = value;
                          }
                        });
                      }
                    }
                    insert = "";
                    break;
                  case "retain":
                    if (retain > 0) {
                      op = { retain };
                      if (!isEmpty(attributes)) {
                        op.attributes = assign({}, attributes);
                      }
                    }
                    retain = 0;
                    break;
                }
                if (op) delta.push(op);
                action = null;
              }
            };
            while (item !== null) {
              switch (item.content.constructor) {
                case ContentType:
                case ContentEmbed:
                  if (this.adds(item)) {
                    if (!this.deletes(item)) {
                      addOp();
                      action = "insert";
                      insert = item.content.getContent()[0];
                      addOp();
                    }
                  } else if (this.deletes(item)) {
                    if (action !== "delete") {
                      addOp();
                      action = "delete";
                    }
                    deleteLen += 1;
                  } else if (!item.deleted) {
                    if (action !== "retain") {
                      addOp();
                      action = "retain";
                    }
                    retain += 1;
                  }
                  break;
                case ContentString:
                  if (this.adds(item)) {
                    if (!this.deletes(item)) {
                      if (action !== "insert") {
                        addOp();
                        action = "insert";
                      }
                      insert += /** @type {ContentString} */
                      item.content.str;
                    }
                  } else if (this.deletes(item)) {
                    if (action !== "delete") {
                      addOp();
                      action = "delete";
                    }
                    deleteLen += item.length;
                  } else if (!item.deleted) {
                    if (action !== "retain") {
                      addOp();
                      action = "retain";
                    }
                    retain += item.length;
                  }
                  break;
                case ContentFormat: {
                  const { key, value } = (
                    /** @type {ContentFormat} */
                    item.content
                  );
                  if (this.adds(item)) {
                    if (!this.deletes(item)) {
                      const curVal = currentAttributes.get(key) ?? null;
                      if (!equalAttrs(curVal, value)) {
                        if (action === "retain") {
                          addOp();
                        }
                        if (equalAttrs(value, oldAttributes.get(key) ?? null)) {
                          delete attributes[key];
                        } else {
                          attributes[key] = value;
                        }
                      } else if (value !== null) {
                        item.delete(transaction);
                      }
                    }
                  } else if (this.deletes(item)) {
                    oldAttributes.set(key, value);
                    const curVal = currentAttributes.get(key) ?? null;
                    if (!equalAttrs(curVal, value)) {
                      if (action === "retain") {
                        addOp();
                      }
                      attributes[key] = curVal;
                    }
                  } else if (!item.deleted) {
                    oldAttributes.set(key, value);
                    const attr = attributes[key];
                    if (attr !== void 0) {
                      if (!equalAttrs(attr, value)) {
                        if (action === "retain") {
                          addOp();
                        }
                        if (value === null) {
                          delete attributes[key];
                        } else {
                          attributes[key] = value;
                        }
                      } else if (attr !== null) {
                        item.delete(transaction);
                      }
                    }
                  }
                  if (!item.deleted) {
                    if (action === "insert") {
                      addOp();
                    }
                    updateCurrentAttributes(
                      currentAttributes,
                      /** @type {ContentFormat} */
                      item.content
                    );
                  }
                  break;
                }
              }
              item = item.right;
            }
            addOp();
            while (delta.length > 0) {
              const lastOp = delta[delta.length - 1];
              if (lastOp.retain !== void 0 && lastOp.attributes === void 0) {
                delta.pop();
              } else {
                break;
              }
            }
          });
          this._delta = delta;
        }
        return (
          /** @type {any} */
          this._delta
        );
      }
    };
    YText = class _YText extends AbstractType {
      /**
       * @param {String} [string] The initial value of the YText.
       */
      constructor(string) {
        super();
        this._pending = string !== void 0 ? [() => this.insert(0, string)] : [];
        this._searchMarker = [];
        this._hasFormatting = false;
      }
      /**
       * Number of characters of this text type.
       *
       * @type {number}
       */
      get length() {
        this.doc ?? warnPrematureAccess();
        return this._length;
      }
      /**
       * @param {Doc} y
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        try {
          this._pending.forEach((f) => f());
        } catch (e) {
          console.error(e);
        }
        this._pending = null;
      }
      _copy() {
        return new _YText();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YText}
       */
      clone() {
        const text = new _YText();
        text.applyDelta(this.toDelta());
        return text;
      }
      /**
       * Creates YTextEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        super._callObserver(transaction, parentSubs);
        const event = new YTextEvent(this, transaction, parentSubs);
        callTypeObservers(this, transaction, event);
        if (!transaction.local && this._hasFormatting) {
          transaction._needFormattingCleanup = true;
        }
      }
      /**
       * Returns the unformatted string representation of this YText type.
       *
       * @public
       */
      toString() {
        this.doc ?? warnPrematureAccess();
        let str = "";
        let n = this._start;
        while (n !== null) {
          if (!n.deleted && n.countable && n.content.constructor === ContentString) {
            str += /** @type {ContentString} */
            n.content.str;
          }
          n = n.right;
        }
        return str;
      }
      /**
       * Returns the unformatted string representation of this YText type.
       *
       * @return {string}
       * @public
       */
      toJSON() {
        return this.toString();
      }
      /**
       * Apply a {@link Delta} on this shared YText type.
       *
       * @param {Array<any>} delta The changes to apply on this element.
       * @param {object}  opts
       * @param {boolean} [opts.sanitize] Sanitize input delta. Removes ending newlines if set to true.
       *
       *
       * @public
       */
      applyDelta(delta, { sanitize = true } = {}) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            const currPos = new ItemTextListPosition(null, this._start, 0, /* @__PURE__ */ new Map());
            for (let i = 0; i < delta.length; i++) {
              const op = delta[i];
              if (op.insert !== void 0) {
                const ins = !sanitize && typeof op.insert === "string" && i === delta.length - 1 && currPos.right === null && op.insert.slice(-1) === "\n" ? op.insert.slice(0, -1) : op.insert;
                if (typeof ins !== "string" || ins.length > 0) {
                  insertText(transaction, this, currPos, ins, op.attributes || {});
                }
              } else if (op.retain !== void 0) {
                formatText(transaction, this, currPos, op.retain, op.attributes || {});
              } else if (op.delete !== void 0) {
                deleteText(transaction, currPos, op.delete);
              }
            }
          });
        } else {
          this._pending.push(() => this.applyDelta(delta));
        }
      }
      /**
       * Returns the Delta representation of this YText type.
       *
       * @param {Snapshot} [snapshot]
       * @param {Snapshot} [prevSnapshot]
       * @param {function('removed' | 'added', ID):any} [computeYChange]
       * @return {any} The Delta representation of this type.
       *
       * @public
       */
      toDelta(snapshot2, prevSnapshot, computeYChange) {
        this.doc ?? warnPrematureAccess();
        const ops = [];
        const currentAttributes = /* @__PURE__ */ new Map();
        const doc = (
          /** @type {Doc} */
          this.doc
        );
        let str = "";
        let n = this._start;
        function packStr() {
          if (str.length > 0) {
            const attributes = {};
            let addAttributes = false;
            currentAttributes.forEach((value, key) => {
              addAttributes = true;
              attributes[key] = value;
            });
            const op = { insert: str };
            if (addAttributes) {
              op.attributes = attributes;
            }
            ops.push(op);
            str = "";
          }
        }
        const computeDelta = () => {
          while (n !== null) {
            if (isVisible(n, snapshot2) || prevSnapshot !== void 0 && isVisible(n, prevSnapshot)) {
              switch (n.content.constructor) {
                case ContentString: {
                  const cur = currentAttributes.get("ychange");
                  if (snapshot2 !== void 0 && !isVisible(n, snapshot2)) {
                    if (cur === void 0 || cur.user !== n.id.client || cur.type !== "removed") {
                      packStr();
                      currentAttributes.set("ychange", computeYChange ? computeYChange("removed", n.id) : { type: "removed" });
                    }
                  } else if (prevSnapshot !== void 0 && !isVisible(n, prevSnapshot)) {
                    if (cur === void 0 || cur.user !== n.id.client || cur.type !== "added") {
                      packStr();
                      currentAttributes.set("ychange", computeYChange ? computeYChange("added", n.id) : { type: "added" });
                    }
                  } else if (cur !== void 0) {
                    packStr();
                    currentAttributes.delete("ychange");
                  }
                  str += /** @type {ContentString} */
                  n.content.str;
                  break;
                }
                case ContentType:
                case ContentEmbed: {
                  packStr();
                  const op = {
                    insert: n.content.getContent()[0]
                  };
                  if (currentAttributes.size > 0) {
                    const attrs = (
                      /** @type {Object<string,any>} */
                      {}
                    );
                    op.attributes = attrs;
                    currentAttributes.forEach((value, key) => {
                      attrs[key] = value;
                    });
                  }
                  ops.push(op);
                  break;
                }
                case ContentFormat:
                  if (isVisible(n, snapshot2)) {
                    packStr();
                    updateCurrentAttributes(
                      currentAttributes,
                      /** @type {ContentFormat} */
                      n.content
                    );
                  }
                  break;
              }
            }
            n = n.right;
          }
          packStr();
        };
        if (snapshot2 || prevSnapshot) {
          transact(doc, (transaction) => {
            if (snapshot2) {
              splitSnapshotAffectedStructs(transaction, snapshot2);
            }
            if (prevSnapshot) {
              splitSnapshotAffectedStructs(transaction, prevSnapshot);
            }
            computeDelta();
          }, "cleanup");
        } else {
          computeDelta();
        }
        return ops;
      }
      /**
       * Insert text at a given index.
       *
       * @param {number} index The index at which to start inserting.
       * @param {String} text The text to insert at the specified position.
       * @param {TextAttributes} [attributes] Optionally define some formatting
       *                                    information to apply on the inserted
       *                                    Text.
       * @public
       */
      insert(index, text, attributes) {
        if (text.length <= 0) {
          return;
        }
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            const pos = findPosition(transaction, this, index, !attributes);
            if (!attributes) {
              attributes = {};
              pos.currentAttributes.forEach((v, k) => {
                attributes[k] = v;
              });
            }
            insertText(transaction, this, pos, text, attributes);
          });
        } else {
          this._pending.push(() => this.insert(index, text, attributes));
        }
      }
      /**
       * Inserts an embed at a index.
       *
       * @param {number} index The index to insert the embed at.
       * @param {Object | AbstractType<any>} embed The Object that represents the embed.
       * @param {TextAttributes} [attributes] Attribute information to apply on the
       *                                    embed
       *
       * @public
       */
      insertEmbed(index, embed, attributes) {
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            const pos = findPosition(transaction, this, index, !attributes);
            insertText(transaction, this, pos, embed, attributes || {});
          });
        } else {
          this._pending.push(() => this.insertEmbed(index, embed, attributes || {}));
        }
      }
      /**
       * Deletes text starting from an index.
       *
       * @param {number} index Index at which to start deleting.
       * @param {number} length The number of characters to remove. Defaults to 1.
       *
       * @public
       */
      delete(index, length2) {
        if (length2 === 0) {
          return;
        }
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            deleteText(transaction, findPosition(transaction, this, index, true), length2);
          });
        } else {
          this._pending.push(() => this.delete(index, length2));
        }
      }
      /**
       * Assigns properties to a range of text.
       *
       * @param {number} index The position where to start formatting.
       * @param {number} length The amount of characters to assign properties to.
       * @param {TextAttributes} attributes Attribute information to apply on the
       *                                    text.
       *
       * @public
       */
      format(index, length2, attributes) {
        if (length2 === 0) {
          return;
        }
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            const pos = findPosition(transaction, this, index, false);
            if (pos.right === null) {
              return;
            }
            formatText(transaction, this, pos, length2, attributes);
          });
        } else {
          this._pending.push(() => this.format(index, length2, attributes));
        }
      }
      /**
       * Removes an attribute.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @param {String} attributeName The attribute name that is to be removed.
       *
       * @public
       */
      removeAttribute(attributeName) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapDelete(transaction, this, attributeName);
          });
        } else {
          this._pending.push(() => this.removeAttribute(attributeName));
        }
      }
      /**
       * Sets or updates an attribute.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @param {String} attributeName The attribute name that is to be set.
       * @param {any} attributeValue The attribute value that is to be set.
       *
       * @public
       */
      setAttribute(attributeName, attributeValue) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapSet(transaction, this, attributeName, attributeValue);
          });
        } else {
          this._pending.push(() => this.setAttribute(attributeName, attributeValue));
        }
      }
      /**
       * Returns an attribute value that belongs to the attribute name.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @param {String} attributeName The attribute name that identifies the
       *                               queried value.
       * @return {any} The queried attribute value.
       *
       * @public
       */
      getAttribute(attributeName) {
        return (
          /** @type {any} */
          typeMapGet(this, attributeName)
        );
      }
      /**
       * Returns all attribute name/value pairs in a JSON Object.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @return {Object<string, any>} A JSON Object that describes the attributes.
       *
       * @public
       */
      getAttributes() {
        return typeMapGetAll(this);
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder) {
        encoder.writeTypeRef(YTextRefID);
      }
    };
    readYText = (_decoder) => new YText();
    YXmlTreeWalker = class {
      /**
       * @param {YXmlFragment | YXmlElement} root
       * @param {function(AbstractType<any>):boolean} [f]
       */
      constructor(root, f = () => true) {
        this._filter = f;
        this._root = root;
        this._currentNode = /** @type {Item} */
        root._start;
        this._firstCall = true;
        root.doc ?? warnPrematureAccess();
      }
      [Symbol.iterator]() {
        return this;
      }
      /**
       * Get the next node.
       *
       * @return {IteratorResult<YXmlElement|YXmlText|YXmlHook>} The next node.
       *
       * @public
       */
      next() {
        let n = this._currentNode;
        let type = n && n.content && /** @type {any} */
        n.content.type;
        if (n !== null && (!this._firstCall || n.deleted || !this._filter(type))) {
          do {
            type = /** @type {any} */
            n.content.type;
            if (!n.deleted && (type.constructor === YXmlElement || type.constructor === YXmlFragment) && type._start !== null) {
              n = type._start;
            } else {
              while (n !== null) {
                const nxt = n.next;
                if (nxt !== null) {
                  n = nxt;
                  break;
                } else if (n.parent === this._root) {
                  n = null;
                } else {
                  n = /** @type {AbstractType<any>} */
                  n.parent._item;
                }
              }
            }
          } while (n !== null && (n.deleted || !this._filter(
            /** @type {ContentType} */
            n.content.type
          )));
        }
        this._firstCall = false;
        if (n === null) {
          return { value: void 0, done: true };
        }
        this._currentNode = n;
        return { value: (
          /** @type {any} */
          n.content.type
        ), done: false };
      }
    };
    YXmlFragment = class _YXmlFragment extends AbstractType {
      constructor() {
        super();
        this._prelimContent = [];
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get firstChild() {
        const first = this._first;
        return first ? first.content.getContent()[0] : null;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        this.insert(
          0,
          /** @type {Array<any>} */
          this._prelimContent
        );
        this._prelimContent = null;
      }
      _copy() {
        return new _YXmlFragment();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlFragment}
       */
      clone() {
        const el = new _YXmlFragment();
        el.insert(0, this.toArray().map((item) => item instanceof AbstractType ? item.clone() : item));
        return el;
      }
      get length() {
        this.doc ?? warnPrematureAccess();
        return this._prelimContent === null ? this._length : this._prelimContent.length;
      }
      /**
       * Create a subtree of childNodes.
       *
       * @example
       * const walker = elem.createTreeWalker(dom => dom.nodeName === 'div')
       * for (let node in walker) {
       *   // `node` is a div node
       *   nop(node)
       * }
       *
       * @param {function(AbstractType<any>):boolean} filter Function that is called on each child element and
       *                          returns a Boolean indicating whether the child
       *                          is to be included in the subtree.
       * @return {YXmlTreeWalker} A subtree and a position within it.
       *
       * @public
       */
      createTreeWalker(filter) {
        return new YXmlTreeWalker(this, filter);
      }
      /**
       * Returns the first YXmlElement that matches the query.
       * Similar to DOM's {@link querySelector}.
       *
       * Query support:
       *   - tagname
       * TODO:
       *   - id
       *   - attribute
       *
       * @param {CSS_Selector} query The query on the children.
       * @return {YXmlElement|YXmlText|YXmlHook|null} The first element that matches the query or null.
       *
       * @public
       */
      querySelector(query) {
        query = query.toUpperCase();
        const iterator = new YXmlTreeWalker(this, (element) => element.nodeName && element.nodeName.toUpperCase() === query);
        const next = iterator.next();
        if (next.done) {
          return null;
        } else {
          return next.value;
        }
      }
      /**
       * Returns all YXmlElements that match the query.
       * Similar to Dom's {@link querySelectorAll}.
       *
       * @todo Does not yet support all queries. Currently only query by tagName.
       *
       * @param {CSS_Selector} query The query on the children
       * @return {Array<YXmlElement|YXmlText|YXmlHook|null>} The elements that match this query.
       *
       * @public
       */
      querySelectorAll(query) {
        query = query.toUpperCase();
        return from(new YXmlTreeWalker(this, (element) => element.nodeName && element.nodeName.toUpperCase() === query));
      }
      /**
       * Creates YXmlEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        callTypeObservers(this, transaction, new YXmlEvent(this, parentSubs, transaction));
      }
      /**
       * Get the string representation of all the children of this YXmlFragment.
       *
       * @return {string} The string representation of all children.
       */
      toString() {
        return typeListMap(this, (xml) => xml.toString()).join("");
      }
      /**
       * @return {string}
       */
      toJSON() {
        return this.toString();
      }
      /**
       * Creates a Dom Element that mirrors this YXmlElement.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object<string, any>} [hooks={}] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type.
       * @return {Node} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks = {}, binding) {
        const fragment = _document.createDocumentFragment();
        if (binding !== void 0) {
          binding._createAssociation(fragment, this);
        }
        typeListForEach(this, (xmlType) => {
          fragment.insertBefore(xmlType.toDOM(_document, hooks, binding), null);
        });
        return fragment;
      }
      /**
       * Inserts new content at an index.
       *
       * @example
       *  // Insert character 'a' at position 0
       *  xml.insert(0, [new Y.XmlText('text')])
       *
       * @param {number} index The index to insert content at
       * @param {Array<YXmlElement|YXmlText>} content The array of content
       */
      insert(index, content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListInsertGenerics(transaction, this, index, content);
          });
        } else {
          this._prelimContent.splice(index, 0, ...content);
        }
      }
      /**
       * Inserts new content at an index.
       *
       * @example
       *  // Insert character 'a' at position 0
       *  xml.insert(0, [new Y.XmlText('text')])
       *
       * @param {null|Item|YXmlElement|YXmlText} ref The index to insert content at
       * @param {Array<YXmlElement|YXmlText>} content The array of content
       */
      insertAfter(ref, content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            const refItem = ref && ref instanceof AbstractType ? ref._item : ref;
            typeListInsertGenericsAfter(transaction, this, refItem, content);
          });
        } else {
          const pc = (
            /** @type {Array<any>} */
            this._prelimContent
          );
          const index = ref === null ? 0 : pc.findIndex((el) => el === ref) + 1;
          if (index === 0 && ref !== null) {
            throw create3("Reference item not found");
          }
          pc.splice(index, 0, ...content);
        }
      }
      /**
       * Deletes elements starting from an index.
       *
       * @param {number} index Index at which to start deleting elements
       * @param {number} [length=1] The number of elements to remove. Defaults to 1.
       */
      delete(index, length2 = 1) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListDelete(transaction, this, index, length2);
          });
        } else {
          this._prelimContent.splice(index, length2);
        }
      }
      /**
       * Transforms this YArray to a JavaScript Array.
       *
       * @return {Array<YXmlElement|YXmlText|YXmlHook>}
       */
      toArray() {
        return typeListToArray(this);
      }
      /**
       * Appends content to this YArray.
       *
       * @param {Array<YXmlElement|YXmlText>} content Array of content to append.
       */
      push(content) {
        this.insert(this.length, content);
      }
      /**
       * Prepends content to this YArray.
       *
       * @param {Array<YXmlElement|YXmlText>} content Array of content to prepend.
       */
      unshift(content) {
        this.insert(0, content);
      }
      /**
       * Returns the i-th element from a YArray.
       *
       * @param {number} index The index of the element to return from the YArray
       * @return {YXmlElement|YXmlText}
       */
      get(index) {
        return typeListGet(this, index);
      }
      /**
       * Returns a portion of this YXmlFragment into a JavaScript Array selected
       * from start to end (end not included).
       *
       * @param {number} [start]
       * @param {number} [end]
       * @return {Array<YXmlElement|YXmlText>}
       */
      slice(start = 0, end = this.length) {
        return typeListSlice(this, start, end);
      }
      /**
       * Executes a provided function on once on every child element.
       *
       * @param {function(YXmlElement|YXmlText,number, typeof self):void} f A function to execute on every element of this YArray.
       */
      forEach(f) {
        typeListForEach(this, f);
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       */
      _write(encoder) {
        encoder.writeTypeRef(YXmlFragmentRefID);
      }
    };
    readYXmlFragment = (_decoder) => new YXmlFragment();
    YXmlElement = class _YXmlElement extends YXmlFragment {
      constructor(nodeName = "UNDEFINED") {
        super();
        this.nodeName = nodeName;
        this._prelimAttrs = /* @__PURE__ */ new Map();
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get nextSibling() {
        const n = this._item ? this._item.next : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get prevSibling() {
        const n = this._item ? this._item.prev : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        /** @type {Map<string, any>} */
        this._prelimAttrs.forEach((value, key) => {
          this.setAttribute(key, value);
        });
        this._prelimAttrs = null;
      }
      /**
       * Creates an Item with the same effect as this Item (without position effect)
       *
       * @return {YXmlElement}
       */
      _copy() {
        return new _YXmlElement(this.nodeName);
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlElement<KV>}
       */
      clone() {
        const el = new _YXmlElement(this.nodeName);
        const attrs = this.getAttributes();
        forEach(attrs, (value, key) => {
          el.setAttribute(
            key,
            /** @type {any} */
            value
          );
        });
        el.insert(0, this.toArray().map((v) => v instanceof AbstractType ? v.clone() : v));
        return el;
      }
      /**
       * Returns the XML serialization of this YXmlElement.
       * The attributes are ordered by attribute-name, so you can easily use this
       * method to compare YXmlElements
       *
       * @return {string} The string representation of this type.
       *
       * @public
       */
      toString() {
        const attrs = this.getAttributes();
        const stringBuilder = [];
        const keys2 = [];
        for (const key in attrs) {
          keys2.push(key);
        }
        keys2.sort();
        const keysLen = keys2.length;
        for (let i = 0; i < keysLen; i++) {
          const key = keys2[i];
          stringBuilder.push(key + '="' + attrs[key] + '"');
        }
        const nodeName = this.nodeName.toLocaleLowerCase();
        const attrsString = stringBuilder.length > 0 ? " " + stringBuilder.join(" ") : "";
        return `<${nodeName}${attrsString}>${super.toString()}</${nodeName}>`;
      }
      /**
       * Removes an attribute from this YXmlElement.
       *
       * @param {string} attributeName The attribute name that is to be removed.
       *
       * @public
       */
      removeAttribute(attributeName) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapDelete(transaction, this, attributeName);
          });
        } else {
          this._prelimAttrs.delete(attributeName);
        }
      }
      /**
       * Sets or updates an attribute.
       *
       * @template {keyof KV & string} KEY
       *
       * @param {KEY} attributeName The attribute name that is to be set.
       * @param {KV[KEY]} attributeValue The attribute value that is to be set.
       *
       * @public
       */
      setAttribute(attributeName, attributeValue) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapSet(transaction, this, attributeName, attributeValue);
          });
        } else {
          this._prelimAttrs.set(attributeName, attributeValue);
        }
      }
      /**
       * Returns an attribute value that belongs to the attribute name.
       *
       * @template {keyof KV & string} KEY
       *
       * @param {KEY} attributeName The attribute name that identifies the
       *                               queried value.
       * @return {KV[KEY]|undefined} The queried attribute value.
       *
       * @public
       */
      getAttribute(attributeName) {
        return (
          /** @type {any} */
          typeMapGet(this, attributeName)
        );
      }
      /**
       * Returns whether an attribute exists
       *
       * @param {string} attributeName The attribute name to check for existence.
       * @return {boolean} whether the attribute exists.
       *
       * @public
       */
      hasAttribute(attributeName) {
        return (
          /** @type {any} */
          typeMapHas(this, attributeName)
        );
      }
      /**
       * Returns all attribute name/value pairs in a JSON Object.
       *
       * @param {Snapshot} [snapshot]
       * @return {{ [Key in Extract<keyof KV,string>]?: KV[Key]}} A JSON Object that describes the attributes.
       *
       * @public
       */
      getAttributes(snapshot2) {
        return (
          /** @type {any} */
          snapshot2 ? typeMapGetAllSnapshot(this, snapshot2) : typeMapGetAll(this)
        );
      }
      /**
       * Creates a Dom Element that mirrors this YXmlElement.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object<string, any>} [hooks={}] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type.
       * @return {Node} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks = {}, binding) {
        const dom = _document.createElement(this.nodeName);
        const attrs = this.getAttributes();
        for (const key in attrs) {
          const value = attrs[key];
          if (typeof value === "string") {
            dom.setAttribute(key, value);
          }
        }
        typeListForEach(this, (yxml) => {
          dom.appendChild(yxml.toDOM(_document, hooks, binding));
        });
        if (binding !== void 0) {
          binding._createAssociation(dom, this);
        }
        return dom;
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       */
      _write(encoder) {
        encoder.writeTypeRef(YXmlElementRefID);
        encoder.writeKey(this.nodeName);
      }
    };
    readYXmlElement = (decoder) => new YXmlElement(decoder.readKey());
    YXmlEvent = class extends YEvent {
      /**
       * @param {YXmlElement|YXmlText|YXmlFragment} target The target on which the event is created.
       * @param {Set<string|null>} subs The set of changed attributes. `null` is included if the
       *                   child list changed.
       * @param {Transaction} transaction The transaction instance with which the
       *                                  change was created.
       */
      constructor(target, subs, transaction) {
        super(target, transaction);
        this.childListChanged = false;
        this.attributesChanged = /* @__PURE__ */ new Set();
        subs.forEach((sub) => {
          if (sub === null) {
            this.childListChanged = true;
          } else {
            this.attributesChanged.add(sub);
          }
        });
      }
    };
    YXmlHook = class _YXmlHook extends YMap {
      /**
       * @param {string} hookName nodeName of the Dom Node.
       */
      constructor(hookName) {
        super();
        this.hookName = hookName;
      }
      /**
       * Creates an Item with the same effect as this Item (without position effect)
       */
      _copy() {
        return new _YXmlHook(this.hookName);
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlHook}
       */
      clone() {
        const el = new _YXmlHook(this.hookName);
        this.forEach((value, key) => {
          el.set(key, value);
        });
        return el;
      }
      /**
       * Creates a Dom Element that mirrors this YXmlElement.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object.<string, any>} [hooks] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type
       * @return {Element} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks = {}, binding) {
        const hook = hooks[this.hookName];
        let dom;
        if (hook !== void 0) {
          dom = hook.createDom(this);
        } else {
          dom = document.createElement(this.hookName);
        }
        dom.setAttribute("data-yjs-hook", this.hookName);
        if (binding !== void 0) {
          binding._createAssociation(dom, this);
        }
        return dom;
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       */
      _write(encoder) {
        encoder.writeTypeRef(YXmlHookRefID);
        encoder.writeKey(this.hookName);
      }
    };
    readYXmlHook = (decoder) => new YXmlHook(decoder.readKey());
    YXmlText = class _YXmlText extends YText {
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get nextSibling() {
        const n = this._item ? this._item.next : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get prevSibling() {
        const n = this._item ? this._item.prev : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      _copy() {
        return new _YXmlText();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlText}
       */
      clone() {
        const text = new _YXmlText();
        text.applyDelta(this.toDelta());
        return text;
      }
      /**
       * Creates a Dom Element that mirrors this YXmlText.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object<string, any>} [hooks] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type.
       * @return {Text} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks, binding) {
        const dom = _document.createTextNode(this.toString());
        if (binding !== void 0) {
          binding._createAssociation(dom, this);
        }
        return dom;
      }
      toString() {
        return this.toDelta().map((delta) => {
          const nestedNodes = [];
          for (const nodeName in delta.attributes) {
            const attrs = [];
            for (const key in delta.attributes[nodeName]) {
              attrs.push({ key, value: delta.attributes[nodeName][key] });
            }
            attrs.sort((a, b) => a.key < b.key ? -1 : 1);
            nestedNodes.push({ nodeName, attrs });
          }
          nestedNodes.sort((a, b) => a.nodeName < b.nodeName ? -1 : 1);
          let str = "";
          for (let i = 0; i < nestedNodes.length; i++) {
            const node = nestedNodes[i];
            str += `<${node.nodeName}`;
            for (let j = 0; j < node.attrs.length; j++) {
              const attr = node.attrs[j];
              str += ` ${attr.key}="${attr.value}"`;
            }
            str += ">";
          }
          str += delta.insert;
          for (let i = nestedNodes.length - 1; i >= 0; i--) {
            str += `</${nestedNodes[i].nodeName}>`;
          }
          return str;
        }).join("");
      }
      /**
       * @return {string}
       */
      toJSON() {
        return this.toString();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder) {
        encoder.writeTypeRef(YXmlTextRefID);
      }
    };
    readYXmlText = (decoder) => new YXmlText();
    AbstractStruct = class {
      /**
       * @param {ID} id
       * @param {number} length
       */
      constructor(id2, length2) {
        this.id = id2;
        this.length = length2;
      }
      /**
       * @type {boolean}
       */
      get deleted() {
        throw methodUnimplemented();
      }
      /**
       * Merge this struct with the item to the right.
       * This method is already assuming that `this.id.clock + this.length === this.id.clock`.
       * Also this method does *not* remove right from StructStore!
       * @param {AbstractStruct} right
       * @return {boolean} whether this merged with right
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       * @param {number} offset
       * @param {number} encodingRef
       */
      write(encoder, offset, encodingRef) {
        throw methodUnimplemented();
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        throw methodUnimplemented();
      }
    };
    structGCRefNumber = 0;
    GC = class extends AbstractStruct {
      get deleted() {
        return true;
      }
      delete() {
      }
      /**
       * @param {GC} right
       * @return {boolean}
       */
      mergeWith(right) {
        if (this.constructor !== right.constructor) {
          return false;
        }
        this.length += right.length;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        if (offset > 0) {
          this.id.clock += offset;
          this.length -= offset;
        }
        addStruct(transaction.doc.store, this);
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        encoder.writeInfo(structGCRefNumber);
        encoder.writeLen(this.length - offset);
      }
      /**
       * @param {Transaction} transaction
       * @param {StructStore} store
       * @return {null | number}
       */
      getMissing(transaction, store) {
        return null;
      }
    };
    ContentBinary = class _ContentBinary {
      /**
       * @param {Uint8Array} content
       */
      constructor(content) {
        this.content = content;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.content];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentBinary}
       */
      copy() {
        return new _ContentBinary(this.content);
      }
      /**
       * @param {number} offset
       * @return {ContentBinary}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentBinary} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        encoder.writeBuf(this.content);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 3;
      }
    };
    readContentBinary = (decoder) => new ContentBinary(decoder.readBuf());
    ContentDeleted = class _ContentDeleted {
      /**
       * @param {number} len
       */
      constructor(len) {
        this.len = len;
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.len;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return false;
      }
      /**
       * @return {ContentDeleted}
       */
      copy() {
        return new _ContentDeleted(this.len);
      }
      /**
       * @param {number} offset
       * @return {ContentDeleted}
       */
      splice(offset) {
        const right = new _ContentDeleted(this.len - offset);
        this.len = offset;
        return right;
      }
      /**
       * @param {ContentDeleted} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.len += right.len;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
        addToDeleteSet(transaction.deleteSet, item.id.client, item.id.clock, this.len);
        item.markDeleted();
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        encoder.writeLen(this.len - offset);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 1;
      }
    };
    readContentDeleted = (decoder) => new ContentDeleted(decoder.readLen());
    createDocFromOpts = (guid, opts) => new Doc({ guid, ...opts, shouldLoad: opts.shouldLoad || opts.autoLoad || false });
    ContentDoc = class _ContentDoc {
      /**
       * @param {Doc} doc
       */
      constructor(doc) {
        if (doc._item) {
          console.error("This document was already integrated as a sub-document. You should create a second instance instead with the same guid.");
        }
        this.doc = doc;
        const opts = {};
        this.opts = opts;
        if (!doc.gc) {
          opts.gc = false;
        }
        if (doc.autoLoad) {
          opts.autoLoad = true;
        }
        if (doc.meta !== null) {
          opts.meta = doc.meta;
        }
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.doc];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentDoc}
       */
      copy() {
        return new _ContentDoc(createDocFromOpts(this.doc.guid, this.opts));
      }
      /**
       * @param {number} offset
       * @return {ContentDoc}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentDoc} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
        this.doc._item = item;
        transaction.subdocsAdded.add(this.doc);
        if (this.doc.shouldLoad) {
          transaction.subdocsLoaded.add(this.doc);
        }
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
        if (transaction.subdocsAdded.has(this.doc)) {
          transaction.subdocsAdded.delete(this.doc);
        } else {
          transaction.subdocsRemoved.add(this.doc);
        }
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        encoder.writeString(this.doc.guid);
        encoder.writeAny(this.opts);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 9;
      }
    };
    readContentDoc = (decoder) => new ContentDoc(createDocFromOpts(decoder.readString(), decoder.readAny()));
    ContentEmbed = class _ContentEmbed {
      /**
       * @param {Object} embed
       */
      constructor(embed) {
        this.embed = embed;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.embed];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentEmbed}
       */
      copy() {
        return new _ContentEmbed(this.embed);
      }
      /**
       * @param {number} offset
       * @return {ContentEmbed}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentEmbed} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        encoder.writeJSON(this.embed);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 5;
      }
    };
    readContentEmbed = (decoder) => new ContentEmbed(decoder.readJSON());
    ContentFormat = class _ContentFormat {
      /**
       * @param {string} key
       * @param {Object} value
       */
      constructor(key, value) {
        this.key = key;
        this.value = value;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return false;
      }
      /**
       * @return {ContentFormat}
       */
      copy() {
        return new _ContentFormat(this.key, this.value);
      }
      /**
       * @param {number} _offset
       * @return {ContentFormat}
       */
      splice(_offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentFormat} _right
       * @return {boolean}
       */
      mergeWith(_right) {
        return false;
      }
      /**
       * @param {Transaction} _transaction
       * @param {Item} item
       */
      integrate(_transaction, item) {
        const p = (
          /** @type {YText} */
          item.parent
        );
        p._searchMarker = null;
        p._hasFormatting = true;
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        encoder.writeKey(this.key);
        encoder.writeJSON(this.value);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 6;
      }
    };
    readContentFormat = (decoder) => new ContentFormat(decoder.readKey(), decoder.readJSON());
    ContentJSON = class _ContentJSON {
      /**
       * @param {Array<any>} arr
       */
      constructor(arr) {
        this.arr = arr;
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.arr.length;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return this.arr;
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentJSON}
       */
      copy() {
        return new _ContentJSON(this.arr);
      }
      /**
       * @param {number} offset
       * @return {ContentJSON}
       */
      splice(offset) {
        const right = new _ContentJSON(this.arr.slice(offset));
        this.arr = this.arr.slice(0, offset);
        return right;
      }
      /**
       * @param {ContentJSON} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.arr = this.arr.concat(right.arr);
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        const len = this.arr.length;
        encoder.writeLen(len - offset);
        for (let i = offset; i < len; i++) {
          const c = this.arr[i];
          encoder.writeString(c === void 0 ? "undefined" : JSON.stringify(c));
        }
      }
      /**
       * @return {number}
       */
      getRef() {
        return 2;
      }
    };
    readContentJSON = (decoder) => {
      const len = decoder.readLen();
      const cs = [];
      for (let i = 0; i < len; i++) {
        const c = decoder.readString();
        if (c === "undefined") {
          cs.push(void 0);
        } else {
          cs.push(JSON.parse(c));
        }
      }
      return new ContentJSON(cs);
    };
    isDevMode = getVariable("node_env") === "development";
    ContentAny = class _ContentAny {
      /**
       * @param {Array<any>} arr
       */
      constructor(arr) {
        this.arr = arr;
        isDevMode && deepFreeze(arr);
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.arr.length;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return this.arr;
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentAny}
       */
      copy() {
        return new _ContentAny(this.arr);
      }
      /**
       * @param {number} offset
       * @return {ContentAny}
       */
      splice(offset) {
        const right = new _ContentAny(this.arr.slice(offset));
        this.arr = this.arr.slice(0, offset);
        return right;
      }
      /**
       * @param {ContentAny} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.arr = this.arr.concat(right.arr);
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        const len = this.arr.length;
        encoder.writeLen(len - offset);
        for (let i = offset; i < len; i++) {
          const c = this.arr[i];
          encoder.writeAny(c);
        }
      }
      /**
       * @return {number}
       */
      getRef() {
        return 8;
      }
    };
    readContentAny = (decoder) => {
      const len = decoder.readLen();
      const cs = [];
      for (let i = 0; i < len; i++) {
        cs.push(decoder.readAny());
      }
      return new ContentAny(cs);
    };
    ContentString = class _ContentString {
      /**
       * @param {string} str
       */
      constructor(str) {
        this.str = str;
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.str.length;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return this.str.split("");
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentString}
       */
      copy() {
        return new _ContentString(this.str);
      }
      /**
       * @param {number} offset
       * @return {ContentString}
       */
      splice(offset) {
        const right = new _ContentString(this.str.slice(offset));
        this.str = this.str.slice(0, offset);
        const firstCharCode = this.str.charCodeAt(offset - 1);
        if (firstCharCode >= 55296 && firstCharCode <= 56319) {
          this.str = this.str.slice(0, offset - 1) + "\uFFFD";
          right.str = "\uFFFD" + right.str.slice(1);
        }
        return right;
      }
      /**
       * @param {ContentString} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.str += right.str;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        encoder.writeString(offset === 0 ? this.str : this.str.slice(offset));
      }
      /**
       * @return {number}
       */
      getRef() {
        return 4;
      }
    };
    readContentString = (decoder) => new ContentString(decoder.readString());
    typeRefs = [
      readYArray,
      readYMap,
      readYText,
      readYXmlElement,
      readYXmlFragment,
      readYXmlHook,
      readYXmlText
    ];
    YArrayRefID = 0;
    YMapRefID = 1;
    YTextRefID = 2;
    YXmlElementRefID = 3;
    YXmlFragmentRefID = 4;
    YXmlHookRefID = 5;
    YXmlTextRefID = 6;
    ContentType = class _ContentType {
      /**
       * @param {AbstractType<any>} type
       */
      constructor(type) {
        this.type = type;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.type];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentType}
       */
      copy() {
        return new _ContentType(this.type._copy());
      }
      /**
       * @param {number} offset
       * @return {ContentType}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentType} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
        this.type._integrate(transaction.doc, item);
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
        let item = this.type._start;
        while (item !== null) {
          if (!item.deleted) {
            item.delete(transaction);
          } else if (item.id.clock < (transaction.beforeState.get(item.id.client) || 0)) {
            transaction._mergeStructs.push(item);
          }
          item = item.right;
        }
        this.type._map.forEach((item2) => {
          if (!item2.deleted) {
            item2.delete(transaction);
          } else if (item2.id.clock < (transaction.beforeState.get(item2.id.client) || 0)) {
            transaction._mergeStructs.push(item2);
          }
        });
        transaction.changed.delete(this.type);
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
        let item = this.type._start;
        while (item !== null) {
          item.gc(store, true);
          item = item.right;
        }
        this.type._start = null;
        this.type._map.forEach(
          /** @param {Item | null} item */
          (item2) => {
            while (item2 !== null) {
              item2.gc(store, true);
              item2 = item2.left;
            }
          }
        );
        this.type._map = /* @__PURE__ */ new Map();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        this.type._write(encoder);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 7;
      }
    };
    readContentType = (decoder) => new ContentType(typeRefs[decoder.readTypeRef()](decoder));
    followRedone = (store, id2) => {
      let nextID = id2;
      let diff = 0;
      let item;
      do {
        if (diff > 0) {
          nextID = createID(nextID.client, nextID.clock + diff);
        }
        item = getItem(store, nextID);
        diff = nextID.clock - item.id.clock;
        nextID = item.redone;
      } while (nextID !== null && item instanceof Item);
      return {
        item,
        diff
      };
    };
    keepItem = (item, keep) => {
      while (item !== null && item.keep !== keep) {
        item.keep = keep;
        item = /** @type {AbstractType<any>} */
        item.parent._item;
      }
    };
    splitItem = (transaction, leftItem, diff) => {
      const { client, clock } = leftItem.id;
      const rightItem = new Item(
        createID(client, clock + diff),
        leftItem,
        createID(client, clock + diff - 1),
        leftItem.right,
        leftItem.rightOrigin,
        leftItem.parent,
        leftItem.parentSub,
        leftItem.content.splice(diff)
      );
      if (leftItem.deleted) {
        rightItem.markDeleted();
      }
      if (leftItem.keep) {
        rightItem.keep = true;
      }
      if (leftItem.redone !== null) {
        rightItem.redone = createID(leftItem.redone.client, leftItem.redone.clock + diff);
      }
      leftItem.right = rightItem;
      if (rightItem.right !== null) {
        rightItem.right.left = rightItem;
      }
      transaction._mergeStructs.push(rightItem);
      if (rightItem.parentSub !== null && rightItem.right === null) {
        rightItem.parent._map.set(rightItem.parentSub, rightItem);
      }
      leftItem.length = diff;
      return rightItem;
    };
    isDeletedByUndoStack = (stack, id2) => some(
      stack,
      /** @param {StackItem} s */
      (s) => isDeleted(s.deletions, id2)
    );
    redoItem = (transaction, item, redoitems, itemsToDelete, ignoreRemoteMapChanges, um) => {
      const doc = transaction.doc;
      const store = doc.store;
      const ownClientID = doc.clientID;
      const redone = item.redone;
      if (redone !== null) {
        return getItemCleanStart(transaction, redone);
      }
      let parentItem = (
        /** @type {AbstractType<any>} */
        item.parent._item
      );
      let left = null;
      let right;
      if (parentItem !== null && parentItem.deleted === true) {
        if (parentItem.redone === null && (!redoitems.has(parentItem) || redoItem(transaction, parentItem, redoitems, itemsToDelete, ignoreRemoteMapChanges, um) === null)) {
          return null;
        }
        while (parentItem.redone !== null) {
          parentItem = getItemCleanStart(transaction, parentItem.redone);
        }
      }
      const parentType = parentItem === null ? (
        /** @type {AbstractType<any>} */
        item.parent
      ) : (
        /** @type {ContentType} */
        parentItem.content.type
      );
      if (item.parentSub === null) {
        left = item.left;
        right = item;
        while (left !== null) {
          let leftTrace = left;
          while (leftTrace !== null && /** @type {AbstractType<any>} */
          leftTrace.parent._item !== parentItem) {
            leftTrace = leftTrace.redone === null ? null : getItemCleanStart(transaction, leftTrace.redone);
          }
          if (leftTrace !== null && /** @type {AbstractType<any>} */
          leftTrace.parent._item === parentItem) {
            left = leftTrace;
            break;
          }
          left = left.left;
        }
        while (right !== null) {
          let rightTrace = right;
          while (rightTrace !== null && /** @type {AbstractType<any>} */
          rightTrace.parent._item !== parentItem) {
            rightTrace = rightTrace.redone === null ? null : getItemCleanStart(transaction, rightTrace.redone);
          }
          if (rightTrace !== null && /** @type {AbstractType<any>} */
          rightTrace.parent._item === parentItem) {
            right = rightTrace;
            break;
          }
          right = right.right;
        }
      } else {
        right = null;
        if (item.right && !ignoreRemoteMapChanges) {
          left = item;
          while (left !== null && left.right !== null && (left.right.redone || isDeleted(itemsToDelete, left.right.id) || isDeletedByUndoStack(um.undoStack, left.right.id) || isDeletedByUndoStack(um.redoStack, left.right.id))) {
            left = left.right;
            while (left.redone) left = getItemCleanStart(transaction, left.redone);
          }
          if (left && left.right !== null) {
            return null;
          }
        } else {
          left = parentType._map.get(item.parentSub) || null;
        }
        if (left !== null && /** @type {AbstractType<any>} */
        left.parent._item !== parentItem) {
          left = parentType._map.get(item.parentSub) || null;
        }
      }
      const nextClock = getState(store, ownClientID);
      const nextId = createID(ownClientID, nextClock);
      const redoneItem = new Item(
        nextId,
        left,
        left && left.lastId,
        right,
        right && right.id,
        parentType,
        item.parentSub,
        item.content.copy()
      );
      item.redone = nextId;
      keepItem(redoneItem, true);
      redoneItem.integrate(transaction, 0);
      return redoneItem;
    };
    Item = class _Item extends AbstractStruct {
      /**
       * @param {ID} id
       * @param {Item | null} left
       * @param {ID | null} origin
       * @param {Item | null} right
       * @param {ID | null} rightOrigin
       * @param {AbstractType<any>|ID|null} parent Is a type if integrated, is null if it is possible to copy parent from left or right, is ID before integration to search for it.
       * @param {string | null} parentSub
       * @param {AbstractContent} content
       */
      constructor(id2, left, origin, right, rightOrigin, parent, parentSub, content) {
        super(id2, content.getLength());
        this.origin = origin;
        this.left = left;
        this.right = right;
        this.rightOrigin = rightOrigin;
        this.parent = parent;
        this.parentSub = parentSub;
        this.redone = null;
        this.content = content;
        this.info = this.content.isCountable() ? BIT2 : 0;
      }
      /**
       * This is used to mark the item as an indexed fast-search marker
       *
       * @type {boolean}
       */
      set marker(isMarked) {
        if ((this.info & BIT4) > 0 !== isMarked) {
          this.info ^= BIT4;
        }
      }
      get marker() {
        return (this.info & BIT4) > 0;
      }
      /**
       * If true, do not garbage collect this Item.
       */
      get keep() {
        return (this.info & BIT1) > 0;
      }
      set keep(doKeep) {
        if (this.keep !== doKeep) {
          this.info ^= BIT1;
        }
      }
      get countable() {
        return (this.info & BIT2) > 0;
      }
      /**
       * Whether this item was deleted or not.
       * @type {Boolean}
       */
      get deleted() {
        return (this.info & BIT3) > 0;
      }
      set deleted(doDelete) {
        if (this.deleted !== doDelete) {
          this.info ^= BIT3;
        }
      }
      markDeleted() {
        this.info |= BIT3;
      }
      /**
       * Return the creator clientID of the missing op or define missing items and return null.
       *
       * @param {Transaction} transaction
       * @param {StructStore} store
       * @return {null | number}
       */
      getMissing(transaction, store) {
        if (this.origin && this.origin.client !== this.id.client && this.origin.clock >= getState(store, this.origin.client)) {
          return this.origin.client;
        }
        if (this.rightOrigin && this.rightOrigin.client !== this.id.client && this.rightOrigin.clock >= getState(store, this.rightOrigin.client)) {
          return this.rightOrigin.client;
        }
        if (this.parent && this.parent.constructor === ID && this.id.client !== this.parent.client && this.parent.clock >= getState(store, this.parent.client)) {
          return this.parent.client;
        }
        if (this.origin) {
          this.left = getItemCleanEnd(transaction, store, this.origin);
          this.origin = this.left.lastId;
        }
        if (this.rightOrigin) {
          this.right = getItemCleanStart(transaction, this.rightOrigin);
          this.rightOrigin = this.right.id;
        }
        if (this.left && this.left.constructor === GC || this.right && this.right.constructor === GC) {
          this.parent = null;
        } else if (!this.parent) {
          if (this.left && this.left.constructor === _Item) {
            this.parent = this.left.parent;
            this.parentSub = this.left.parentSub;
          } else if (this.right && this.right.constructor === _Item) {
            this.parent = this.right.parent;
            this.parentSub = this.right.parentSub;
          }
        } else if (this.parent.constructor === ID) {
          const parentItem = getItem(store, this.parent);
          if (parentItem.constructor === GC) {
            this.parent = null;
          } else {
            this.parent = /** @type {ContentType} */
            parentItem.content.type;
          }
        }
        return null;
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        if (offset > 0) {
          this.id.clock += offset;
          this.left = getItemCleanEnd(transaction, transaction.doc.store, createID(this.id.client, this.id.clock - 1));
          this.origin = this.left.lastId;
          this.content = this.content.splice(offset);
          this.length -= offset;
        }
        if (this.parent) {
          if (!this.left && (!this.right || this.right.left !== null) || this.left && this.left.right !== this.right) {
            let left = this.left;
            let o;
            if (left !== null) {
              o = left.right;
            } else if (this.parentSub !== null) {
              o = /** @type {AbstractType<any>} */
              this.parent._map.get(this.parentSub) || null;
              while (o !== null && o.left !== null) {
                o = o.left;
              }
            } else {
              o = /** @type {AbstractType<any>} */
              this.parent._start;
            }
            const conflictingItems = /* @__PURE__ */ new Set();
            const itemsBeforeOrigin = /* @__PURE__ */ new Set();
            while (o !== null && o !== this.right) {
              itemsBeforeOrigin.add(o);
              conflictingItems.add(o);
              if (compareIDs(this.origin, o.origin)) {
                if (o.id.client < this.id.client) {
                  left = o;
                  conflictingItems.clear();
                } else if (compareIDs(this.rightOrigin, o.rightOrigin)) {
                  break;
                }
              } else if (o.origin !== null && itemsBeforeOrigin.has(getItem(transaction.doc.store, o.origin))) {
                if (!conflictingItems.has(getItem(transaction.doc.store, o.origin))) {
                  left = o;
                  conflictingItems.clear();
                }
              } else {
                break;
              }
              o = o.right;
            }
            this.left = left;
          }
          if (this.left !== null) {
            const right = this.left.right;
            this.right = right;
            this.left.right = this;
          } else {
            let r;
            if (this.parentSub !== null) {
              r = /** @type {AbstractType<any>} */
              this.parent._map.get(this.parentSub) || null;
              while (r !== null && r.left !== null) {
                r = r.left;
              }
            } else {
              r = /** @type {AbstractType<any>} */
              this.parent._start;
              this.parent._start = this;
            }
            this.right = r;
          }
          if (this.right !== null) {
            this.right.left = this;
          } else if (this.parentSub !== null) {
            this.parent._map.set(this.parentSub, this);
            if (this.left !== null) {
              this.left.delete(transaction);
            }
          }
          if (this.parentSub === null && this.countable && !this.deleted) {
            this.parent._length += this.length;
          }
          addStruct(transaction.doc.store, this);
          this.content.integrate(transaction, this);
          addChangedTypeToTransaction(
            transaction,
            /** @type {AbstractType<any>} */
            this.parent,
            this.parentSub
          );
          if (
            /** @type {AbstractType<any>} */
            this.parent._item !== null && /** @type {AbstractType<any>} */
            this.parent._item.deleted || this.parentSub !== null && this.right !== null
          ) {
            this.delete(transaction);
          }
        } else {
          new GC(this.id, this.length).integrate(transaction, 0);
        }
      }
      /**
       * Returns the next non-deleted item
       */
      get next() {
        let n = this.right;
        while (n !== null && n.deleted) {
          n = n.right;
        }
        return n;
      }
      /**
       * Returns the previous non-deleted item
       */
      get prev() {
        let n = this.left;
        while (n !== null && n.deleted) {
          n = n.left;
        }
        return n;
      }
      /**
       * Computes the last content address of this Item.
       */
      get lastId() {
        return this.length === 1 ? this.id : createID(this.id.client, this.id.clock + this.length - 1);
      }
      /**
       * Try to merge two items
       *
       * @param {Item} right
       * @return {boolean}
       */
      mergeWith(right) {
        if (this.constructor === right.constructor && compareIDs(right.origin, this.lastId) && this.right === right && compareIDs(this.rightOrigin, right.rightOrigin) && this.id.client === right.id.client && this.id.clock + this.length === right.id.clock && this.deleted === right.deleted && this.redone === null && right.redone === null && this.content.constructor === right.content.constructor && this.content.mergeWith(right.content)) {
          const searchMarker = (
            /** @type {AbstractType<any>} */
            this.parent._searchMarker
          );
          if (searchMarker) {
            searchMarker.forEach((marker) => {
              if (marker.p === right) {
                marker.p = this;
                if (!this.deleted && this.countable) {
                  marker.index -= this.length;
                }
              }
            });
          }
          if (right.keep) {
            this.keep = true;
          }
          this.right = right.right;
          if (this.right !== null) {
            this.right.left = this;
          }
          this.length += right.length;
          return true;
        }
        return false;
      }
      /**
       * Mark this Item as deleted.
       *
       * @param {Transaction} transaction
       */
      delete(transaction) {
        if (!this.deleted) {
          const parent = (
            /** @type {AbstractType<any>} */
            this.parent
          );
          if (this.countable && this.parentSub === null) {
            parent._length -= this.length;
          }
          this.markDeleted();
          addToDeleteSet(transaction.deleteSet, this.id.client, this.id.clock, this.length);
          addChangedTypeToTransaction(transaction, parent, this.parentSub);
          this.content.delete(transaction);
        }
      }
      /**
       * @param {StructStore} store
       * @param {boolean} parentGCd
       */
      gc(store, parentGCd) {
        if (!this.deleted) {
          throw unexpectedCase();
        }
        this.content.gc(store);
        if (parentGCd) {
          replaceStruct(store, this, new GC(this.id, this.length));
        } else {
          this.content = new ContentDeleted(this.length);
        }
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       * @param {number} offset
       */
      write(encoder, offset) {
        const origin = offset > 0 ? createID(this.id.client, this.id.clock + offset - 1) : this.origin;
        const rightOrigin = this.rightOrigin;
        const parentSub = this.parentSub;
        const info = this.content.getRef() & BITS5 | (origin === null ? 0 : BIT8) | // origin is defined
        (rightOrigin === null ? 0 : BIT7) | // right origin is defined
        (parentSub === null ? 0 : BIT6);
        encoder.writeInfo(info);
        if (origin !== null) {
          encoder.writeLeftID(origin);
        }
        if (rightOrigin !== null) {
          encoder.writeRightID(rightOrigin);
        }
        if (origin === null && rightOrigin === null) {
          const parent = (
            /** @type {AbstractType<any>} */
            this.parent
          );
          if (parent._item !== void 0) {
            const parentItem = parent._item;
            if (parentItem === null) {
              const ykey = findRootTypeKey(parent);
              encoder.writeParentInfo(true);
              encoder.writeString(ykey);
            } else {
              encoder.writeParentInfo(false);
              encoder.writeLeftID(parentItem.id);
            }
          } else if (parent.constructor === String) {
            encoder.writeParentInfo(true);
            encoder.writeString(parent);
          } else if (parent.constructor === ID) {
            encoder.writeParentInfo(false);
            encoder.writeLeftID(parent);
          } else {
            unexpectedCase();
          }
          if (parentSub !== null) {
            encoder.writeString(parentSub);
          }
        }
        this.content.write(encoder, offset);
      }
    };
    readItemContent = (decoder, info) => contentRefs[info & BITS5](decoder);
    contentRefs = [
      () => {
        unexpectedCase();
      },
      // GC is not ItemContent
      readContentDeleted,
      // 1
      readContentJSON,
      // 2
      readContentBinary,
      // 3
      readContentString,
      // 4
      readContentEmbed,
      // 5
      readContentFormat,
      // 6
      readContentType,
      // 7
      readContentAny,
      // 8
      readContentDoc,
      // 9
      () => {
        unexpectedCase();
      }
      // 10 - Skip is not ItemContent
    ];
    structSkipRefNumber = 10;
    Skip = class extends AbstractStruct {
      get deleted() {
        return true;
      }
      delete() {
      }
      /**
       * @param {Skip} right
       * @return {boolean}
       */
      mergeWith(right) {
        if (this.constructor !== right.constructor) {
          return false;
        }
        this.length += right.length;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        unexpectedCase();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder, offset) {
        encoder.writeInfo(structSkipRefNumber);
        writeVarUint(encoder.restEncoder, this.length - offset);
      }
      /**
       * @param {Transaction} transaction
       * @param {StructStore} store
       * @return {null | number}
       */
      getMissing(transaction, store) {
        return null;
      }
    };
    glo = /** @type {any} */
    typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {};
    importIdentifier = "__ $YJS$ __";
    if (glo[importIdentifier] === true) {
      console.error("Yjs was already imported. This breaks constructor checks and will lead to issues! - https://github.com/yjs/yjs/issues/438");
    }
    glo[importIdentifier] = true;
  }
});

// server/collab.cjs
var require_collab = __commonJS({
  "server/collab.cjs"(exports2, module2) {
    "use strict";
    var Y = (init_yjs(), __toCommonJS(yjs_exports));
    var { maxPropertiesBytes } = require_limits();
    var PRESENCE_TTL_MS = 1e4;
    var ACCESS_TTL_MS = 1e4;
    var COMPACT_AFTER = 100;
    var ROOTS = /* @__PURE__ */ new Set(["title", "content", "properties", "meta"]);
    var COLORS = ["#8b5cf6", "#ec4899", "#10b981", "#f59e0b", "#f97316", "#3b82f6", "#14b8a6", "#ef4444"];
    var b64 = (bytes2) => Buffer.from(bytes2).toString("base64");
    var bytes = (text) => new Uint8Array(Buffer.from(text, "base64"));
    var whenValid = (check) => {
      try {
        return check();
      } catch (error) {
        if (error.status === 400) return void 0;
        throw error;
      }
    };
    function createCollab({ fail, id: id2, editable, noteFields, propertyFields, noteIcon, referenceOps, sweep }) {
      const accessCache = /* @__PURE__ */ new Map();
      const nameCache = /* @__PURE__ */ new Map();
      const locks = /* @__PURE__ */ new Map();
      const clientId = (value) => {
        if (!Number.isSafeInteger(value) || value < 0 || value > 4294967295) fail(400, "Invalid collaboration client.");
        return value;
      };
      function locked(noteId, fn) {
        const run = (locks.get(noteId) || Promise.resolve()).then(fn, fn);
        locks.set(noteId, run.catch(() => {
        }));
        return run;
      }
      async function requireEditor(ctx, userId, noteId, fresh = false) {
        const key = `${userId}:${noteId}`;
        const cached = accessCache.get(key);
        if (!fresh && cached && cached.until > Date.now()) return cached.note;
        const note = await editable(ctx, userId, noteId);
        accessCache.set(key, { note, until: Date.now() + ACCESS_TTL_MS });
        return note;
      }
      async function person(ctx, userId) {
        if (!nameCache.has(userId)) {
          const user = await ctx.users.getById(userId).catch(() => null);
          nameCache.set(userId, user?.display_name || user?.username || `#${userId}`);
        }
        return { name: nameCache.get(userId), color: COLORS[userId % COLORS.length] };
      }
      function seed(note) {
        const doc = new Y.Doc();
        doc.transact(() => {
          doc.getText("title").insert(0, note.title);
          doc.getText("content").insert(0, note.content);
          note.properties.forEach((property, position) => doc.getMap("properties").set(property.id, { ...property, position }));
          if (note.icon) doc.getMap("meta").set("icon", note.icon);
        });
        return Y.encodeStateAsUpdate(doc);
      }
      async function load(ctx, noteId) {
        const rows = await ctx.db.query(`SELECT 0 AS pending, state AS data, seq FROM note_crdt WHERE note_id = ?
      UNION ALL SELECT 1, data, seq FROM note_updates WHERE note_id = ? ORDER BY pending, seq`, noteId, noteId);
        if (!rows.length || rows[0].pending) return null;
        const doc = new Y.Doc();
        for (const row of rows) Y.applyUpdate(doc, bytes(row.data));
        return { doc, base: rows[0].seq, seq: rows[rows.length - 1].seq, pending: rows.length - 1 };
      }
      async function ensure(ctx, note) {
        await ctx.db.exec("INSERT OR IGNORE INTO note_crdt (note_id, state, seq) VALUES (?, ?, 0)", note.id, b64(seed(note)));
        return load(ctx, note.id);
      }
      function materialize(doc, previous) {
        if ([...doc.share.keys()].some((name) => !ROOTS.has(name)) || [...doc.getMap("meta").keys()].some((key) => key !== "icon"))
          fail(400, "Invalid collaboration update.");
        const properties = [...doc.getMap("properties").values()].sort((a, b) => a.position - b.position).map(({ position, ...property }) => property);
        if (Buffer.byteLength(JSON.stringify(properties), "utf8") > maxPropertiesBytes)
          fail(400, "Properties must fit within {size} KB.", { size: maxPropertiesBytes / 1e3 });
        const title = doc.getText("title").toString().trim();
        const { content } = noteFields({ title: previous.title, content: doc.getText("content").toString() });
        return {
          title: title && title.length <= 160 ? title : void 0,
          content,
          properties: whenValid(() => propertyFields(properties)),
          icon: whenValid(() => noteIcon(doc.getMap("meta").get("icon") ?? null))
        };
      }
      function writes(noteId, updates, doc, previous, before, seq, pending) {
        const fields = materialize(doc, previous);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const ops = updates.map((update, index) => ({
          sql: "INSERT INTO note_updates (note_id, seq, client_id, data) VALUES (?, ?, ?, ?)",
          args: [noteId, seq + index + 1, update.client, b64(update.data)]
        }));
        ops.push(
          {
            sql: `UPDATE notes SET title = COALESCE(?, title), content = ?, properties = COALESCE(?, properties),
      icon = CASE WHEN ? THEN icon ELSE ? END, updated_at = ?, version = version + 1 WHERE id = ? AND archived = 0`,
            args: [fields.title ?? null, fields.content, fields.properties ?? null, fields.icon === void 0 ? 1 : 0, fields.icon ?? null, now, noteId]
          },
          ...referenceOps(before, fields.content)
        );
        const last2 = seq + updates.length;
        if (pending + updates.length >= COMPACT_AFTER) {
          ops.push(
            { sql: "UPDATE note_crdt SET state = ?, seq = ? WHERE note_id = ?", args: [b64(Y.encodeStateAsUpdate(doc)), last2, noteId] },
            { sql: "DELETE FROM note_updates WHERE note_id = ? AND seq <= ?", args: [noteId, last2] }
          );
        }
        return { ops, seq: last2 };
      }
      async function push(ctx, note, client, encoded) {
        if (!Array.isArray(encoded) || encoded.length > 50) fail(400, "Invalid collaboration updates.");
        if (!encoded.length) return null;
        return locked(note.id, async () => {
          const loaded = await load(ctx, note.id) || await ensure(ctx, note);
          const before = loaded.doc.getText("content").toString();
          const updates = encoded.map((text) => {
            if (typeof text !== "string" || text.length > 2e5) fail(400, "Invalid collaboration update.");
            const data = bytes(text);
            try {
              Y.applyUpdate(loaded.doc, data);
            } catch {
              fail(400, "Invalid collaboration update.");
            }
            return { client, data };
          });
          if (loaded.doc.store.pendingStructs || loaded.doc.store.pendingDs)
            fail(409, "This editing session is out of sync. Rejoin to continue.");
          const { ops, seq } = writes(note.id, updates, loaded.doc, note, before, loaded.seq, loaded.pending);
          await ctx.db.tx(ops);
          return seq;
        });
      }
      async function presence(ctx, noteId, userId, client, cursor) {
        const text = cursor === null || cursor === void 0 ? null : JSON.stringify(cursor);
        if (text && text.length > 2e3) fail(400, "Invalid cursor.");
        await ctx.db.exec(
          `INSERT INTO note_presence (note_id, client_id, user_id, cursor, seen_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(note_id, client_id) DO UPDATE SET user_id = excluded.user_id, cursor = excluded.cursor, seen_at = excluded.seen_at`,
          noteId,
          client,
          userId,
          text,
          Date.now()
        );
      }
      async function changes(ctx, noteId, client, since) {
        const rows = await ctx.db.query(`SELECT 'state' AS kind, seq, state AS data, NULL AS client_id, NULL AS user_id, NULL AS cursor
      FROM note_crdt WHERE note_id = ?
      UNION ALL SELECT 'update', seq, data, client_id, NULL, NULL FROM note_updates WHERE note_id = ? AND seq > ?
      UNION ALL SELECT 'presence', NULL, NULL, client_id, user_id, cursor
        FROM note_presence WHERE note_id = ? AND seen_at > ? AND client_id != ?
      ORDER BY seq`, noteId, noteId, since, noteId, Date.now() - PRESENCE_TTL_MS, client);
        const state = rows.find((row) => row.kind === "state");
        const updates = rows.filter((row) => row.kind === "update");
        const seq = Math.max(since, state?.seq ?? 0, ...updates.map((row) => row.seq));
        const stale = Boolean(state) && since < state.seq;
        const others = rows.filter((row) => row.kind === "presence");
        const people = await Promise.all(others.map((row) => person(ctx, row.user_id)));
        return {
          seq,
          state: stale ? state.data : void 0,
          updates: (stale ? updates : updates.filter((row) => row.client_id !== client)).map((row) => row.data),
          presence: others.map((row, index) => ({
            client_id: row.client_id,
            user_id: row.user_id,
            ...people[index],
            cursor: row.cursor ? JSON.parse(row.cursor) : null
          }))
        };
      }
      async function action(input, ctx, userId) {
        const noteId = id2(input.note_id);
        if (input.action === "leave") {
          await ctx.db.exec(
            "DELETE FROM note_presence WHERE note_id = ? AND client_id = ? AND user_id = ?",
            noteId,
            clientId(input.client_id),
            userId
          );
          return { left: true };
        }
        const client = clientId(input.client_id);
        if (input.action === "join") {
          const note = await requireEditor(ctx, userId, noteId, true);
          await ctx.db.exec("DELETE FROM note_presence WHERE seen_at < ?", Date.now() - PRESENCE_TTL_MS);
          await sweep(ctx);
          await locked(noteId, () => load(ctx, noteId).then((loaded) => loaded || ensure(ctx, note)));
          await presence(ctx, noteId, userId, client, null);
          const [{ version }] = await ctx.db.query("SELECT version FROM notes WHERE id = ?", noteId);
          return { ...await changes(ctx, noteId, client, -1), me: await person(ctx, userId), version };
        }
        if (input.action === "sync") {
          const note = await requireEditor(ctx, userId, noteId);
          const since = Number.isSafeInteger(input.since) && input.since >= 0 ? input.since : fail(400, "Invalid collaboration sequence.");
          await push(ctx, note, client, input.updates || []);
          await presence(ctx, noteId, userId, client, input.cursor);
          return changes(ctx, noteId, client, since);
        }
        fail(400, "Unknown collaboration action.");
      }
      async function external(ctx, note) {
        return locked(note.id, async () => {
          const loaded = await load(ctx, note.id);
          if (!loaded) return;
          const captured = [];
          loaded.doc.on("update", (update) => captured.push(update));
          loaded.doc.transact(() => {
            replace(loaded.doc.getText("title"), note.title);
            replace(loaded.doc.getText("content"), note.content);
            const meta = loaded.doc.getMap("meta");
            if ((meta.get("icon") ?? null) !== (note.icon ?? null)) {
              if (note.icon) meta.set("icon", note.icon);
              else meta.delete("icon");
            }
            const map = loaded.doc.getMap("properties");
            const ids = new Set(note.properties.map((property) => property.id));
            for (const key of [...map.keys()]) if (!ids.has(key)) map.delete(key);
            note.properties.forEach((property, position) => {
              const next = { ...property, position };
              if (JSON.stringify(map.get(property.id)) !== JSON.stringify(next)) map.set(property.id, next);
            });
          });
          if (!captured.length) return;
          await ctx.db.tx([{
            sql: "INSERT INTO note_updates (note_id, seq, client_id, data) VALUES (?, ?, 0, ?)",
            args: [note.id, loaded.seq + 1, b64(Y.mergeUpdates(captured))]
          }]);
        });
      }
      return {
        action,
        external,
        forget: (noteId) => {
          for (const key of accessCache.keys()) if (key.endsWith(`:${noteId}`)) accessCache.delete(key);
        }
      };
    }
    function replace(text, value) {
      const current = text.toString();
      if (current === value) return;
      let start = 0;
      while (start < current.length && start < value.length && current[start] === value[start]) start += 1;
      let end = 0;
      while (end < current.length - start && end < value.length - start && current[current.length - 1 - end] === value[value.length - 1 - end]) end += 1;
      text.delete(start, current.length - start - end);
      text.insert(start, value.slice(start, value.length - end));
    }
    module2.exports = { createCollab };
  }
});

// server/service.cjs
var require_service = __commonJS({
  "server/service.cjs"(exports2, module2) {
    "use strict";
    var { randomUUID } = require("node:crypto");
    var dns = require("node:dns/promises");
    var https = require("node:https");
    var { isIP } = require("node:net");
    var { maxImageBytes, maxContentChars, maxContentBytes, maxPropertiesBytes } = require_limits();
    var { createAssets } = require_assets();
    var { createCollab } = require_collab();
    var Problem = class extends Error {
      constructor(status, message, params2 = {}) {
        super(message.replace(/\{(\w+)\}/g, (match, name) => String(params2[name] ?? match)));
        this.status = status;
        this.template = message;
        this.params = params2;
      }
    };
    var fail = (status, message, params2) => {
      throw new Problem(status, message, params2);
    };
    var number = (value) => {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1) fail(400, "Invalid trip or day identifier.");
      return n;
    };
    var id2 = (value) => {
      if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) fail(400, "Invalid note identifier.");
      return value;
    };
    var text = (value, max2, name) => {
      if (typeof value !== "string" || value.length > max2) fail(400, "Invalid value: {field}.", { field: name });
      return value;
    };
    var actor = (req) => {
      if (!req.user || !Number.isSafeInteger(req.user.id)) fail(401, "Sign in first.");
      return req.user.id;
    };
    var noteFields = (input) => {
      const title = text(input.title, 160, "title").trim();
      if (!title) fail(400, "Title is required.");
      const content = text(input.content, maxContentChars, "content");
      if (Buffer.byteLength(content, "utf8") > maxContentBytes) fail(400, "Content must fit within {size} KB.", { size: maxContentBytes / 1e3 });
      if (input.tags === void 0) return { title, content, tags: void 0 };
      if (!Array.isArray(input.tags) || input.tags.length > 12) fail(400, "Use at most 12 tags.");
      const tags = JSON.stringify([...new Set(input.tags.map((tag) => text(tag, 40, "tag").trim()).filter(Boolean))]);
      return { title, content, tags };
    };
    var noteIcon = (value) => {
      if (value === null || value === void 0 || value === "") return null;
      if (typeof value !== "string") fail(400, "Invalid note icon.");
      if (value.startsWith("data:")) {
        if (value.length > 15e4 || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value))
          fail(400, "Note icon images must be PNG, JPEG, WebP or GIF under 100 KB.");
        return value;
      }
      const icon = value.trim();
      if (!icon || Array.from(icon).length > 16 || /[<>]/.test(icon)) fail(400, "Invalid note icon.");
      return icon;
    };
    var PROPERTY_COLORS = 8;
    var propertyValues = {
      text: (value) => text(value ?? "", 2e3, "text property"),
      number: (value) => {
        if (value === null || value === void 0 || value === "") return null;
        if (typeof value !== "number" || !Number.isFinite(value)) fail(400, "Invalid number property.");
        return value;
      },
      date: (value) => {
        if (!value) return null;
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
          fail(400, "Invalid date property.");
        return value;
      },
      checkbox: (value) => value === true,
      url: (value) => {
        const url = text(value ?? "", 2e3, "URL property").trim();
        if (url && !/^https?:\/\/\S+$/i.test(url)) fail(400, "URL properties must start with http:// or https://.");
        return url;
      },
      select: (value, options) => {
        if (!value) return null;
        if (!options.some((option) => option.id === value)) fail(400, "Invalid select property.");
        return value;
      },
      multi_select: (value, options) => {
        if (!Array.isArray(value) || value.some((item) => !options.some((option) => option.id === item)))
          fail(400, "Invalid multi-select property.");
        return [...new Set(value)];
      },
      checklist: (value) => {
        if (!Array.isArray(value) || value.length > 50) fail(400, "Use at most 50 checklist items.");
        return value.map((item) => ({ text: text(item?.text ?? "", 200, "checklist item"), done: item?.done === true }));
      },
      last_edited: () => null
    };
    var propertyId = (value) => {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(value)) fail(400, "Invalid property identifier.");
      return value;
    };
    function propertyFields(raw) {
      if (!Array.isArray(raw) || raw.length > 30) fail(400, "Use at most 30 properties.");
      const ids = /* @__PURE__ */ new Set();
      const properties = raw.map((property) => {
        const pid = propertyId(property?.id);
        if (ids.has(pid)) fail(400, "Duplicate property identifier.");
        ids.add(pid);
        const name = text(property.name, 40, "property name").trim();
        if (!name) fail(400, "Property name is required.");
        if (!Object.hasOwn(propertyValues, property.type)) fail(400, "Invalid property type.");
        const choice = property.type === "select" || property.type === "multi_select";
        const options = choice ? propertyOptions(property.options) : [];
        return {
          id: pid,
          name,
          type: property.type,
          value: propertyValues[property.type](property.value, options),
          ...choice ? { options } : {}
        };
      });
      const json2 = JSON.stringify(properties);
      if (Buffer.byteLength(json2, "utf8") > maxPropertiesBytes) fail(400, "Properties must fit within {size} KB.", { size: maxPropertiesBytes / 1e3 });
      return json2;
    }
    function propertyOptions(raw) {
      if (!Array.isArray(raw) || raw.length > 30) fail(400, "Use at most 30 options per property.");
      return raw.map((option) => {
        const name = text(option?.name, 40, "option name").trim();
        if (!name) fail(400, "Option name is required.");
        if (!Number.isInteger(option.color) || option.color < 0 || option.color >= PROPERTY_COLORS) fail(400, "Invalid option color.");
        return { id: propertyId(option.id), name, color: option.color };
      });
    }
    var parseList = (json2) => {
      try {
        const parsed = JSON.parse(json2);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    function propertyText(properties) {
      return properties.flatMap((property) => {
        if (property.type === "select" || property.type === "multi_select") {
          const chosen = new Set(property.type === "select" ? [property.value] : property.value || []);
          return (property.options || []).filter((option) => chosen.has(option.id)).map((option) => option.name);
        }
        if (property.type === "checklist") return (property.value || []).map((item) => item.text);
        return ["text", "url", "number", "date"].includes(property.type) && property.value !== null ? [String(property.value)] : [];
      }).join("\n");
    }
    var decode = (row) => {
      if (!row) return row;
      return { ...row, tags: parseList(row.tags), properties: parseList(row.properties ?? "[]"), visibility: row.visibility || "private" };
    };
    var imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
    var tripFilePattern = /^fieldnotes:\/\/trip-file\/(\d+)\/(\d+)$/;
    var pageSize = 7;
    var noteSorts = {
      name: (a, b, collator) => collator.compare(a.title, b.title),
      created: (a, b) => a.created_at.localeCompare(b.created_at),
      updated: (a, b) => a.updated_at.localeCompare(b.updated_at)
    };
    var hostNotAllowed = "Image host is not allowed. Paste the image itself, or ask an admin to allow this host.";
    var maxSnapshotAssetsBytes = 32 * 1024 * 1024;
    var maxSnapshotAssets = 100 - 2;
    var allowedImageTypes = /* @__PURE__ */ new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
    function imageSources(content) {
      const sources = /* @__PURE__ */ new Set();
      for (const match of String(content).matchAll(imagePattern)) sources.add(match[2]);
      return [...sources];
    }
    function tripFileSource(source) {
      const match = tripFilePattern.exec(source);
      return match ? { tripId: number(match[1]), fileId: number(match[2]) } : null;
    }
    function imageData(content, name = "image") {
      const mimetype = String(content.mimetype || "").toLowerCase().split(";")[0];
      const size2 = Number(content.size || 0);
      if (!allowedImageTypes.has(mimetype) || !Number.isSafeInteger(size2) || size2 > maxImageBytes || typeof content.content_base64 !== "string" || content.content_base64.length > Math.ceil(maxImageBytes * 4 / 3)) {
        fail(415, "Unsupported format: {kind}.", { kind: name });
      }
      return { mimetype, size: size2, content_base64: content.content_base64, data_url: `data:${mimetype};base64,${content.content_base64}` };
    }
    function ipv4Number(address) {
      return address.split(".").reduce((value, part) => value << 8 | Number(part), 0) >>> 0;
    }
    function inIpv4Range(address, network, prefix) {
      const mask = prefix === 0 ? 0 : 4294967295 << 32 - prefix >>> 0;
      return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
    }
    function ipv6Number(address) {
      const normalized = address.toLowerCase().replace(/\.(\d+)(?=:|$)/g, ".$1");
      const expanded = normalized.includes(".") ? normalized.replace(/([^:]+)$/, (_match, ipv4) => {
        const parts = ipv4.split(".").map(Number);
        if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) return "";
        return `${(parts[0] << 8 | parts[1]).toString(16)}:${(parts[2] << 8 | parts[3]).toString(16)}`;
      }) : normalized;
      const halves = expanded.split("::");
      const left = halves[0] ? halves[0].split(":") : [];
      const right = halves[1] ? halves[1].split(":") : [];
      const missing = 8 - left.length - right.length;
      if (missing < 0 || halves.length === 1 && missing !== 0) return null;
      const groups = [...left, ...Array(missing).fill("0"), ...right];
      if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
      return groups.reduce((value, group) => value << 16n | BigInt(`0x${group}`), 0n);
    }
    function isPublicAddress(address) {
      if (isIP(address) === 4) {
        const blocked = [
          ["0.0.0.0", 8],
          ["10.0.0.0", 8],
          ["100.64.0.0", 10],
          ["127.0.0.0", 8],
          ["169.254.0.0", 16],
          ["172.16.0.0", 12],
          ["192.0.0.0", 24],
          ["192.0.2.0", 24],
          ["192.88.99.0", 24],
          ["192.168.0.0", 16],
          ["198.18.0.0", 15],
          ["198.51.100.0", 24],
          ["203.0.113.0", 24],
          ["224.0.0.0", 4],
          ["240.0.0.0", 4]
        ];
        return !blocked.some(([network, prefix]) => inIpv4Range(address, network, prefix));
      }
      if (isIP(address) !== 6) return false;
      const value = ipv6Number(address);
      if (value === null || value >> 125n !== 1n) return false;
      const inRange = (network, prefix) => {
        const shift = BigInt(128 - prefix);
        return value >> shift === ipv6Number(network) >> shift;
      };
      return !inRange("2001:db8::", 32) && !inRange("2001::", 23) && !inRange("2002::", 16) && !inRange("3fff::", 20);
    }
    function externalUrl(raw) {
      let url;
      try {
        url = new URL(raw);
      } catch {
        fail(400, "Invalid image URL.");
      }
      if (url.protocol !== "https:" || url.username || url.password) fail(400, "Only credential-free HTTPS images are allowed.");
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
      if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host) && !isPublicAddress(host)) {
        fail(400, "Private image hosts are not allowed.");
      }
      return url;
    }
    async function resolvePublicImageHost(url) {
      const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
      if (isIP(host)) return [{ address: host, family: isIP(host) }];
      let addresses;
      try {
        addresses = await dns.lookup(host, { all: true, verbatim: true });
      } catch (error) {
        if (/^egress:/.test(error?.message)) fail(403, hostNotAllowed);
        fail(502, "Image host could not be resolved.");
      }
      if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
        fail(400, "Private image hosts are not allowed.");
      }
      return addresses;
    }
    function pinnedLookup(url, addresses) {
      const expectedHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
      return (hostname, options, callback) => {
        if (typeof options === "function") {
          callback = options;
          options = {};
        }
        const requestedHost = String(hostname).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
        if (requestedHost !== expectedHost) return callback(new Error("Unexpected image host lookup."));
        const selected = options.family ? addresses.filter((entry) => entry.family === options.family) : addresses;
        if (!selected.length) return callback(Object.assign(new Error("No pinned address for requested family."), { code: "EAI_ADDRFAMILY" }));
        if (options.all) return callback(null, selected);
        return callback(null, selected[0].address, selected[0].family);
      };
    }
    function requestPinnedImage(url, addresses) {
      const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
      const options = { agent: false, headers: { accept: "image/*" }, signal: AbortSignal.timeout(8e3) };
      if (!isIP(host)) {
        options.lookup = pinnedLookup(url, addresses);
        options.servername = host;
      }
      return new Promise((resolve, reject) => {
        const request = https.request(url, options, resolve);
        request.once("error", (error) => reject(/^egress:/.test(error?.message) ? new Problem(403, hostNotAllowed) : error));
        request.end();
      });
    }
    async function readImageBody(response) {
      const chunks = [];
      let size2 = 0;
      for await (const chunk of response) {
        size2 += chunk.length;
        if (size2 > maxImageBytes) {
          response.destroy();
          fail(415, "Image exceeds the size limit.");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size2);
    }
    async function fetchExternalImage(raw) {
      let url = externalUrl(raw);
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const addresses = await resolvePublicImageHost(url);
        const response = await requestPinnedImage(url, addresses);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location2 = response.headers.location;
          response.destroy();
          if (!location2 || redirects === 3) fail(502, "Image redirect limit reached.");
          url = externalUrl(new URL(location2, url).href);
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          fail(502, "Image could not be loaded.");
        }
        const type = String(response.headers["content-type"] || "").toLowerCase().split(";")[0];
        const length2 = Number(response.headers["content-length"] || 0);
        if (!allowedImageTypes.has(type) || length2 && length2 > maxImageBytes) {
          response.destroy();
          fail(415, "Unsupported image.");
        }
        const bytes = await readImageBody(response);
        return imageData({ mimetype: type, size: bytes.length, content_base64: bytes.toString("base64") });
      }
      fail(502, "Image could not be loaded.");
    }
    async function initialize2(ctx) {
      await ctx.db.migrate("001_notes", `CREATE TABLE notes (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, title TEXT NOT NULL,
    content TEXT NOT NULL, tags TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX notes_owner ON notes(owner_id, archived, updated_at);`);
      await ctx.db.migrate("002_note_visibility", "ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
      await ctx.db.migrate("003_snapshot_assets", `CREATE TABLE snapshot_assets (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, source TEXT NOT NULL,
    mimetype TEXT NOT NULL, size INTEGER NOT NULL, content_base64 TEXT NOT NULL,
    PRIMARY KEY (trip_id, note_id, source)
  );`);
      await ctx.db.migrate("004_note_collaborators", `CREATE TABLE note_collaborators (
    note_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_at TEXT NOT NULL, PRIMARY KEY (note_id, user_id)
  ); CREATE INDEX note_collaborators_user ON note_collaborators(user_id);`);
      await ctx.db.migrate("005_folders", `CREATE TABLE folders (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, parent_id TEXT, name TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX folders_parent ON folders(parent_id, archived, name);
  CREATE TABLE folder_collaborators (
    folder_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_at TEXT NOT NULL, PRIMARY KEY (folder_id, user_id)
  ); CREATE INDEX folder_collaborators_user ON folder_collaborators(user_id);
  ALTER TABLE notes ADD COLUMN folder_id TEXT;
  CREATE INDEX notes_folder ON notes(folder_id, archived, updated_at);`);
      await ctx.db.migrate("006_folder_icons", "ALTER TABLE folders ADD COLUMN icon TEXT");
      await ctx.db.migrate("007_trip_folders", `CREATE TABLE trip_folders (
    id TEXT PRIMARY KEY, trip_id INTEGER NOT NULL, parent_id TEXT, name TEXT NOT NULL, icon TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX trip_folders_trip ON trip_folders(trip_id, parent_id, archived, name);
  CREATE TABLE trip_note_folders (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, folder_id TEXT NOT NULL,
    PRIMARY KEY (trip_id, note_id)
  ); CREATE INDEX trip_note_folders_folder ON trip_note_folders(trip_id, folder_id);`);
      await ctx.db.migrate("008_trip_note_store", `CREATE TABLE IF NOT EXISTS trip_note_links (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, source_owner_id INTEGER NOT NULL, linked_by INTEGER,
    mode TEXT NOT NULL CHECK (mode IN ('live', 'snapshot')), day_id INTEGER, linked_at TEXT NOT NULL,
    legacy_actor_unknown INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (trip_id, note_id)
  ); CREATE INDEX IF NOT EXISTS trip_note_links_owner ON trip_note_links(source_owner_id, trip_id);
  CREATE INDEX IF NOT EXISTS trip_note_links_actor ON trip_note_links(linked_by, trip_id);
  CREATE TABLE IF NOT EXISTS trip_note_snapshots (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, visibility TEXT NOT NULL,
    captured_at TEXT NOT NULL, PRIMARY KEY (trip_id, note_id)
  ); CREATE INDEX IF NOT EXISTS trip_note_snapshots_captured ON trip_note_snapshots(trip_id, captured_at);
  CREATE INDEX IF NOT EXISTS snapshot_assets_note ON snapshot_assets(note_id, trip_id);`);
      await ctx.db.migrate("009_trip_note_intents", `CREATE TABLE trip_note_intents (
    owner_id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, trip_folder_id TEXT, created_at TEXT NOT NULL
  );`);
      await ctx.db.migrate("010_note_properties", `ALTER TABLE notes ADD COLUMN properties TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE trip_note_snapshots ADD COLUMN properties TEXT NOT NULL DEFAULT '[]';`);
      await ctx.db.migrate("011_note_collab", `CREATE TABLE note_crdt (note_id TEXT PRIMARY KEY, state TEXT NOT NULL, seq INTEGER NOT NULL);
  CREATE TABLE note_updates (note_id TEXT NOT NULL, seq INTEGER NOT NULL, client_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (note_id, seq));
  CREATE TABLE note_presence (note_id TEXT NOT NULL, client_id INTEGER NOT NULL, user_id INTEGER NOT NULL, cursor TEXT, seen_at INTEGER NOT NULL,
    PRIMARY KEY (note_id, client_id));`);
      await ctx.db.migrate("012_note_icons", "ALTER TABLE notes ADD COLUMN icon TEXT; ALTER TABLE trip_note_snapshots ADD COLUMN icon TEXT;");
      await ctx.db.migrate("013_note_assets", `CREATE TABLE note_assets (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, mimetype TEXT NOT NULL, size INTEGER NOT NULL,
    content_base64 TEXT NOT NULL, created_at TEXT NOT NULL, released_at TEXT
  ); CREATE INDEX note_assets_owner ON note_assets(owner_id);
  CREATE TABLE asset_uploads (
    id TEXT NOT NULL, owner_id INTEGER NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL,
    data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, part)
  ); CREATE INDEX asset_uploads_created ON asset_uploads(created_at);`);
    }
    var roleValue = (role) => {
      if (role === "editor") return 2;
      if (role === "viewer") return 1;
      return 0;
    };
    var roleName = (value) => {
      if (value >= 2) return "editor";
      if (value === 1) return "viewer";
      return null;
    };
    function folderAccessFromRows(userId, folderId, folders, collaborators2) {
      let currentId = folderId;
      const chain = [];
      const seen = /* @__PURE__ */ new Set();
      while (currentId) {
        if (seen.has(currentId) || chain.length > 64) fail(409, "Folder hierarchy is cyclic.");
        seen.add(currentId);
        const folder = folders.get(currentId);
        if (!folder) return null;
        chain.push(folder);
        currentId = folder.parent_id;
      }
      let role = 0;
      for (const folder of chain) role = Math.max(role, folder.owner_id === userId ? 2 : roleValue(collaborators2.get(folder.id)));
      const explicitRole = role;
      const publicPath = chain.every((folder) => folder.visibility === "public");
      const publicGrant = publicPath && explicitRole === 0;
      if (publicGrant) role = 1;
      return { folder: chain[0], chain, role: roleName(role), publicPath, publicGrant };
    }
    async function listAccessData(ctx, userId, includeNoteCollaborators = true) {
      const [folderRows, folderCollaboratorRows, noteCollaboratorRows] = await Promise.all([
        ctx.db.query(
          "SELECT id, owner_id, parent_id, name, icon, visibility, created_at, updated_at, archived FROM folders WHERE archived = 0"
        ),
        ctx.db.query("SELECT folder_id, role FROM folder_collaborators WHERE user_id = ?", userId),
        includeNoteCollaborators ? ctx.db.query("SELECT note_id, role FROM note_collaborators WHERE user_id = ?", userId) : []
      ]);
      return {
        folders: new Map(folderRows.map((folder) => [folder.id, folder])),
        folderCollaborators: new Map(folderCollaboratorRows.map((row) => [row.folder_id, row.role])),
        noteCollaborators: new Map(noteCollaboratorRows.map((row) => [row.note_id, row.role]))
      };
    }
    function noteAccessFromRows(userId, row, access) {
      const directRole = access.noteCollaborators.get(row.id) || null;
      const folder = row.folder_id ? folderAccessFromRows(userId, row.folder_id, access.folders, access.folderCollaborators) : null;
      const inheritedRole = folder?.publicGrant && row.visibility !== "public" ? 0 : roleValue(folder?.role);
      const publicReadable = row.visibility === "public" && (!folder || folder.publicPath);
      const canRead = row.owner_id === userId || Boolean(directRole) || inheritedRole > 0 || publicReadable;
      return {
        folder,
        directRole,
        inheritedRole,
        role: Math.max(roleValue(directRole), inheritedRole, row.owner_id === userId ? 2 : 0),
        canRead,
        publicReadable
      };
    }
    async function folderAccess(ctx, userId, folderId) {
      const access = await listAccessData(ctx, userId, false);
      return folderAccessFromRows(userId, id2(folderId), access.folders, access.folderCollaborators);
    }
    async function folderForWrite(ctx, userId, folderId) {
      if (folderId === null || folderId === void 0 || folderId === "") return null;
      const access = await folderAccess(ctx, userId, folderId);
      if (!access) fail(404, "Folder not found.");
      if (roleValue(access.role) < 2) fail(403, "Folder edit permission required.");
      return access.folder;
    }
    async function noteAccess(ctx, userId, row) {
      return noteAccessFromRows(userId, row, await listAccessData(ctx, userId));
    }
    async function owned(ctx, userId, noteId) {
      const [row] = await ctx.db.query("SELECT * FROM notes WHERE id = ? AND owner_id = ? AND archived = 0", id2(noteId), userId);
      if (!row) fail(404, "Note not found.");
      return { ...decode(row), can_edit: true };
    }
    async function readable(ctx, userId, noteId) {
      const [row] = await ctx.db.query("SELECT * FROM notes WHERE id = ? AND archived = 0", id2(noteId));
      const access = row ? await noteAccess(ctx, userId, row) : null;
      if (!row || !access?.canRead) fail(404, "Note not found.");
      return { ...decode(row), can_edit: access.role >= 2 };
    }
    async function editable(ctx, userId, noteId) {
      const note = await readable(ctx, userId, noteId);
      if (!note.can_edit) fail(403, "Edit permission required.");
      return note;
    }
    async function checkTrip(ctx, tripId) {
      const trip = await ctx.trips.getById(number(tripId));
      if (!trip) fail(404, "Trip not found.");
      return trip;
    }
    async function requireTripEdit(ctx, tripId) {
      await ctx.meta.delete("trip", tripId, `fieldnotes:edit-check:${randomUUID()}`);
    }
    async function checkDay(ctx, tripId, dayId) {
      if (dayId === null || dayId === void 0 || dayId === "") return null;
      const n = number(dayId);
      const days = await ctx.trips.getDays(number(tripId));
      if (!days.some((day) => day.id === n)) fail(400, "The day does not belong to this trip.");
      return n;
    }
    async function tripFolderList(ctx, tripId) {
      const trip = await checkTrip(ctx, tripId);
      const rows = await ctx.db.query(`SELECT id, trip_id, parent_id, name, icon, created_at, updated_at FROM trip_folders
    WHERE trip_id = ? AND archived = 0 ORDER BY parent_id, name, id`, trip.id);
      return rows.map((row) => ({
        id: row.id,
        trip_id: row.trip_id,
        parent_id: row.parent_id,
        name: row.name,
        icon: row.icon || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        visibility: "private",
        role: "editor",
        public_path: true,
        can_manage: true
      }));
    }
    async function checkReparent(ctx, table, folder, parentId, scope = {}) {
      const where = Object.keys(scope).map((column) => ` AND ${column} = ?`).join("");
      let current = parentId;
      while (current) {
        if (current === folder.id) fail(409, "A folder cannot be moved into itself.");
        const [row] = await ctx.db.query(`SELECT parent_id FROM ${table} WHERE id = ?${where}`, current, ...Object.values(scope));
        current = row?.parent_id || null;
      }
      const duplicate = await ctx.db.query(`SELECT id FROM ${table} WHERE id != ? AND archived = 0 AND name = ?${where} AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))`, folder.id, folder.name, ...Object.values(scope), parentId, parentId);
      if (duplicate.length) fail(409, "A folder with this name already exists here.");
    }
    async function tripFolderAction(input, ctx) {
      const tripId = number(input.trip_id);
      await checkTrip(ctx, tripId);
      if (input.action === "folders") return tripFolderList(ctx, tripId);
      if (["folder_create", "folder_move", "folder_parent", "folder_icon", "folder_archive"].includes(input.action))
        await requireTripEdit(ctx, tripId);
      if (input.action === "folder_create") {
        const name = text(input.name, 80, "folder name").trim();
        if (!name) fail(400, "Folder name is required.");
        const parentId = input.parent_id ? id2(input.parent_id) : null;
        if (parentId) {
          const [parent] = await ctx.db.query("SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0", parentId, tripId);
          if (!parent) fail(404, "Folder not found.");
        }
        const duplicate = parentId ? await ctx.db.query(
          "SELECT id FROM trip_folders WHERE trip_id = ? AND parent_id = ? AND name = ? AND archived = 0",
          tripId,
          parentId,
          name
        ) : await ctx.db.query(
          "SELECT id FROM trip_folders WHERE trip_id = ? AND parent_id IS NULL AND name = ? AND archived = 0",
          tripId,
          name
        );
        if (duplicate.length) fail(409, "A folder with this name already exists here.");
        const folderId2 = randomUUID();
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const icon = input.icon ? text(input.icon, 8, "folder icon").trim() : null;
        await ctx.db.exec(`INSERT INTO trip_folders (id, trip_id, parent_id, name, icon, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, folderId2, tripId, parentId, name, icon, now, now);
        return (await tripFolderList(ctx, tripId)).find((folder2) => folder2.id === folderId2);
      }
      if (input.action === "folder_move") {
        const noteId = id2(input.note_id);
        const [link] = await ctx.db.query("SELECT note_id FROM trip_note_links WHERE trip_id = ? AND note_id = ?", tripId, noteId);
        if (!link) fail(404, "Linked note not found.");
        const targetId = input.folder_id ? id2(input.folder_id) : null;
        if (targetId) {
          const [target] = await ctx.db.query("SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0", targetId, tripId);
          if (!target) fail(404, "Folder not found.");
          await ctx.db.exec(
            "INSERT OR REPLACE INTO trip_note_folders (trip_id, note_id, folder_id) VALUES (?, ?, ?)",
            tripId,
            noteId,
            targetId
          );
        } else {
          await ctx.db.exec("DELETE FROM trip_note_folders WHERE trip_id = ? AND note_id = ?", tripId, noteId);
        }
        return { moved: true, folder_id: targetId };
      }
      const folderId = id2(input.folder_id);
      const [folder] = await ctx.db.query("SELECT * FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0", folderId, tripId);
      if (!folder) fail(404, "Folder not found.");
      if (input.action === "folder_parent") {
        const parentId = input.parent_id ? id2(input.parent_id) : null;
        if (parentId) {
          const [parent] = await ctx.db.query("SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0", parentId, tripId);
          if (!parent) fail(404, "Folder not found.");
        }
        await checkReparent(ctx, "trip_folders", folder, parentId, { trip_id: tripId });
        await ctx.db.exec("UPDATE trip_folders SET parent_id = ?, updated_at = ? WHERE id = ?", parentId, (/* @__PURE__ */ new Date()).toISOString(), folderId);
        return (await tripFolderList(ctx, tripId)).find((item) => item.id === folderId);
      }
      if (input.action === "folder_icon") {
        const icon = input.icon ? text(input.icon, 8, "folder icon").trim() : null;
        await ctx.db.exec("UPDATE trip_folders SET icon = ?, updated_at = ? WHERE id = ?", icon, (/* @__PURE__ */ new Date()).toISOString(), folderId);
        return (await tripFolderList(ctx, tripId)).find((item) => item.id === folderId);
      }
      if (input.action === "folder_archive") {
        const [child] = await ctx.db.query(
          "SELECT id FROM trip_folders WHERE trip_id = ? AND parent_id = ? AND archived = 0 LIMIT 1",
          tripId,
          folderId
        );
        const [assignment] = await ctx.db.query(
          "SELECT note_id FROM trip_note_folders WHERE trip_id = ? AND folder_id = ? LIMIT 1",
          tripId,
          folderId
        );
        if (child || assignment) fail(409, "Move child folders and notes before deleting this folder.");
        await ctx.db.exec("UPDATE trip_folders SET archived = 1, updated_at = ? WHERE id = ?", (/* @__PURE__ */ new Date()).toISOString(), folderId);
        return { archived: true };
      }
      fail(400, "Unknown trip folder action.");
    }
    async function tripNotes(ctx, tripId, folderId = null) {
      const trip = await checkTrip(ctx, tripId);
      const links = await ctx.db.query(
        "SELECT note_id, source_owner_id, mode, day_id, linked_at FROM trip_note_links WHERE trip_id = ? ORDER BY linked_at, note_id",
        trip.id
      );
      if (!links.length) return { trip, notes: [] };
      const assignments = new Map((await ctx.db.query("SELECT note_id, folder_id FROM trip_note_folders WHERE trip_id = ?", trip.id)).map((row) => [row.note_id, row.folder_id]));
      const visibleLinks = folderId ? links.filter((link) => assignments.get(link.note_id) === folderId) : links;
      if (!visibleLinks.length) return { trip, notes: [] };
      const members = await ctx.trips.members(trip.id);
      const memberIds = /* @__PURE__ */ new Set([trip.user_id, ...members.map((member) => member.id)]);
      const ids = visibleLinks.map((link) => link.note_id);
      const [rows, snapshots] = await Promise.all([
        ctx.db.query("SELECT * FROM notes WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)),
        ctx.db.query("SELECT * FROM trip_note_snapshots WHERE trip_id = ?", trip.id)
      ]);
      const notesById = new Map(rows.map((row) => [row.id, decode(row)]));
      const snapshotsById = new Map(snapshots.map((row) => [row.note_id, decode(row)]));
      const notes = visibleLinks.map((link) => {
        const noteId = link.note_id;
        const folder_id = assignments.get(noteId) || null;
        if (link.mode === "snapshot") {
          const snapshot2 = snapshotsById.get(noteId);
          return snapshot2 ? { ...snapshot2, id: noteId, mode: "snapshot", day_id: link.day_id, folder_id } : { id: noteId, unavailable: true, mode: "snapshot", day_id: link.day_id, folder_id };
        }
        const note = notesById.get(noteId);
        if (!note || note.archived || note.visibility !== "public" && !memberIds.has(note.owner_id)) {
          return { id: noteId, unavailable: true, mode: "live", day_id: link.day_id, folder_id };
        }
        return { ...note, mode: "live", day_id: link.day_id, folder_id };
      });
      return { trip, notes };
    }
    var userNumber = (value) => {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1) fail(400, "Invalid user identifier.");
      return n;
    };
    function roleChanges(input) {
      if (!Array.isArray(input.changes) || input.changes.length > 100) fail(400, "Invalid collaborator changes.");
      const seen = /* @__PURE__ */ new Set();
      return input.changes.map((change) => {
        const userId = userNumber(change?.user_id);
        if (seen.has(userId) || !["editor", "viewer"].includes(change?.role)) fail(400, "Invalid collaborator changes.");
        seen.add(userId);
        return { userId, role: change.role };
      });
    }
    async function listFolders(ctx, userId) {
      const access = await listAccessData(ctx, userId, false);
      return [...access.folders.values()].sort((a, b) => String(a.parent_id || "").localeCompare(String(b.parent_id || "")) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).flatMap((row) => {
        const folderAccess2 = folderAccessFromRows(userId, row.id, access.folders, access.folderCollaborators);
        if (!folderAccess2?.role) return [];
        return [{
          id: row.id,
          owner_id: row.owner_id,
          parent_id: row.parent_id,
          name: row.name,
          icon: row.icon || null,
          visibility: row.visibility,
          role: folderAccess2.role,
          created_at: row.created_at,
          updated_at: row.updated_at,
          public_path: folderAccess2.publicPath,
          can_manage: row.owner_id === userId
        }];
      });
    }
    async function folderCollaborators(ctx, userId, folderId) {
      const [folder] = await ctx.db.query("SELECT * FROM folders WHERE id = ? AND archived = 0", id2(folderId));
      if (!folder || folder.owner_id !== userId) fail(404, "Folder not found.");
      const rows = await ctx.db.query(
        "SELECT user_id, role, created_at FROM folder_collaborators WHERE folder_id = ? ORDER BY created_at, user_id",
        folder.id
      );
      const candidates = await collaborationCandidates(ctx, userId);
      return {
        collaborators: rows.map((row) => ({ ...row, user: candidates.get(row.user_id) || { id: row.user_id } })),
        candidates: [...candidates.values()]
      };
    }
    async function folderAction(input, ctx, userId) {
      if (input.action === "list") return listFolders(ctx, userId);
      if (input.action === "create") {
        const name = text(input.name, 80, "folder name").trim();
        if (!name) fail(400, "Folder name is required.");
        if (!["private", "public"].includes(input.visibility || "private")) fail(400, "Invalid folder visibility.");
        const parentId = input.parent_id ? id2(input.parent_id) : null;
        if (parentId) await folderForWrite(ctx, userId, parentId);
        const duplicate = parentId ? await ctx.db.query("SELECT id FROM folders WHERE parent_id = ? AND name = ? AND archived = 0", parentId, name) : await ctx.db.query("SELECT id FROM folders WHERE parent_id IS NULL AND owner_id = ? AND name = ? AND archived = 0", userId, name);
        if (duplicate.length) fail(409, "A folder with this name already exists here.");
        const folderId2 = randomUUID();
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const icon = input.icon ? text(input.icon, 8, "folder icon").trim() : null;
        await ctx.db.exec(`INSERT INTO folders (id, owner_id, parent_id, name, icon, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, folderId2, userId, parentId, name, icon, input.visibility || "private", now, now);
        return (await listFolders(ctx, userId)).find((folder2) => folder2.id === folderId2);
      }
      if (input.action === "move_note") {
        const noteId = id2(input.note_id);
        if ((await editable(ctx, userId, noteId)).owner_id !== userId) fail(403, "Only the owner can move a note.");
        const target = await folderForWrite(ctx, userId, input.folder_id);
        await ctx.db.exec("UPDATE notes SET folder_id = ?, updated_at = ? WHERE id = ?", target?.id || null, (/* @__PURE__ */ new Date()).toISOString(), noteId);
        return readable(ctx, userId, noteId);
      }
      const folderId = id2(input.folder_id);
      const [folder] = await ctx.db.query("SELECT * FROM folders WHERE id = ? AND archived = 0", folderId);
      if (!folder || folder.owner_id !== userId) fail(404, "Folder not found.");
      if (input.action === "rename") {
        const name = text(input.name, 80, "folder name").trim();
        if (!name) fail(400, "Folder name is required.");
        const duplicate = await ctx.db.query("SELECT id FROM folders WHERE id != ? AND archived = 0 AND name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL AND owner_id = ?))", folderId, name, folder.parent_id, folder.parent_id, userId);
        if (duplicate.length) fail(409, "A folder with this name already exists here.");
        await ctx.db.exec("UPDATE folders SET name = ?, updated_at = ? WHERE id = ?", name, (/* @__PURE__ */ new Date()).toISOString(), folderId);
        return (await listFolders(ctx, userId)).find((item) => item.id === folderId);
      }
      if (input.action === "move") {
        const parentId = input.parent_id ? id2(input.parent_id) : null;
        if (parentId) await folderForWrite(ctx, userId, parentId);
        await checkReparent(ctx, "folders", folder, parentId, parentId ? {} : { owner_id: userId });
        await ctx.db.exec("UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?", parentId, (/* @__PURE__ */ new Date()).toISOString(), folderId);
        return (await listFolders(ctx, userId)).find((item) => item.id === folderId);
      }
      if (input.action === "visibility") {
        if (!["private", "public"].includes(input.visibility)) fail(400, "Invalid folder visibility.");
        await ctx.db.exec(
          "UPDATE folders SET visibility = ?, updated_at = ? WHERE id = ?",
          input.visibility,
          (/* @__PURE__ */ new Date()).toISOString(),
          folderId
        );
        return (await listFolders(ctx, userId)).find((item) => item.id === folderId);
      }
      if (input.action === "icon") {
        const icon = input.icon ? text(input.icon, 8, "folder icon").trim() : null;
        await ctx.db.exec("UPDATE folders SET icon = ?, updated_at = ? WHERE id = ?", icon, (/* @__PURE__ */ new Date()).toISOString(), folderId);
        return (await listFolders(ctx, userId)).find((item) => item.id === folderId);
      }
      if (input.action === "archive") {
        const [child] = await ctx.db.query("SELECT id FROM folders WHERE parent_id = ? AND archived = 0 LIMIT 1", folderId);
        const [note] = await ctx.db.query("SELECT id FROM notes WHERE folder_id = ? AND archived = 0 LIMIT 1", folderId);
        if (child || note) fail(409, "Move child folders and notes before deleting this folder.");
        await ctx.db.exec("UPDATE folders SET archived = 1, updated_at = ? WHERE id = ?", (/* @__PURE__ */ new Date()).toISOString(), folderId);
        return { archived: true };
      }
      if (input.action === "collaborators") return folderCollaborators(ctx, userId, folderId);
      if (input.action === "bulk_roles") {
        const changes = roleChanges(input);
        const candidates = await collaborationCandidates(ctx, userId);
        for (const change of changes) {
          if (change.userId === userId) fail(400, "The folder owner is always an editor.");
          if (!candidates.has(change.userId)) fail(403, "This user is not available for collaboration.");
        }
        await ctx.db.tx(changes.map((change) => ({
          sql: `INSERT INTO folder_collaborators (folder_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(folder_id, user_id) DO UPDATE SET role = excluded.role`,
          args: [folderId, change.userId, change.role, (/* @__PURE__ */ new Date()).toISOString()]
        })));
        return { saved: changes.length };
      }
      if (input.action === "collaborator") {
        const targetId = userNumber(input.user_id);
        if (targetId === userId) fail(400, "The folder owner is always an editor.");
        if (input.action !== "collaborator" || !["editor", "viewer"].includes(input.role)) fail(400, "Choose a valid collaborator role.");
        const candidates = await collaborationCandidates(ctx, userId);
        if (!candidates.has(targetId)) fail(403, "This user is not available for collaboration.");
        await ctx.db.exec(`INSERT INTO folder_collaborators (folder_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(folder_id, user_id) DO UPDATE SET role = excluded.role`, folderId, targetId, input.role, (/* @__PURE__ */ new Date()).toISOString());
        return { saved: true };
      }
      if (input.action === "remove_collaborator") {
        await ctx.db.exec("DELETE FROM folder_collaborators WHERE folder_id = ? AND user_id = ?", folderId, userNumber(input.user_id));
        return { removed: true };
      }
      fail(400, "Unknown folder action.");
    }
    async function collaborationCandidates(ctx, userId) {
      const candidates = /* @__PURE__ */ new Map();
      for (const trip of await ctx.trips.listMine()) {
        for (const member of await ctx.trips.members(Number(trip.id))) {
          if (member.id !== userId) candidates.set(member.id, member);
        }
      }
      return candidates;
    }
    async function collaborators(ctx, userId, noteId) {
      await owned(ctx, userId, noteId);
      const rows = await ctx.db.query(
        "SELECT user_id, role, created_at FROM note_collaborators WHERE note_id = ? ORDER BY created_at, user_id",
        id2(noteId)
      );
      const candidates = await collaborationCandidates(ctx, userId);
      return {
        collaborators: rows.map((row) => ({ ...row, user: candidates.get(row.user_id) || { id: row.user_id } })),
        candidates: [...candidates.values()]
      };
    }
    async function collaboratorAction(input, ctx, userId) {
      const noteId = id2(input.note_id);
      await owned(ctx, userId, noteId);
      if (input.action === "bulk_roles") {
        const changes = roleChanges(input);
        const candidates2 = await collaborationCandidates(ctx, userId);
        for (const change of changes) {
          if (change.userId === userId) fail(400, "The note owner is always an editor.");
          if (!candidates2.has(change.userId)) fail(403, "This user is not available for collaboration.");
        }
        await ctx.db.tx(changes.map((change) => ({
          sql: `INSERT INTO note_collaborators (note_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(note_id, user_id) DO UPDATE SET role = excluded.role`,
          args: [noteId, change.userId, change.role, (/* @__PURE__ */ new Date()).toISOString()]
        })));
        return { saved: changes.length };
      }
      const targetId = userNumber(input.user_id);
      if (targetId === userId) fail(400, "The note owner is always an editor.");
      if (input.action === "remove") {
        await ctx.db.exec("DELETE FROM note_collaborators WHERE note_id = ? AND user_id = ?", noteId, targetId);
        collab.forget(noteId);
        return { removed: true };
      }
      if (input.action !== "add" || !["editor", "viewer"].includes(input.role)) fail(400, "Choose a valid collaborator role.");
      const candidates = await collaborationCandidates(ctx, userId);
      if (!candidates.has(targetId)) fail(403, "This user is not available for collaboration.");
      await ctx.db.exec(`INSERT INTO note_collaborators (note_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(note_id, user_id) DO UPDATE SET role = excluded.role`, noteId, targetId, input.role, (/* @__PURE__ */ new Date()).toISOString());
      return { saved: true };
    }
    async function noteForAsset(ctx, userId, noteId, tripId, source) {
      const note = tripId === null ? await readable(ctx, userId, noteId) : (await tripNotes(ctx, number(tripId))).notes.find((item) => item.id === id2(noteId) && !item.unavailable);
      if (!note || !imageSources(note.content).includes(source)) fail(404, "Image not found.");
      return note;
    }
    async function asset(ctx, userId, input) {
      const noteId = id2(input.note_id);
      const source = text(input.source, 2048, "image source");
      const tripId = input.trip_id === void 0 || input.trip_id === null || input.trip_id === "" ? null : number(input.trip_id);
      await noteForAsset(ctx, userId, noteId, tripId, source);
      if (tripId !== null) {
        const [snapshot2] = await ctx.db.query(
          "SELECT mimetype, size, content_base64 FROM snapshot_assets WHERE trip_id = ? AND note_id = ? AND source = ?",
          tripId,
          noteId,
          source
        );
        if (snapshot2) return { source, ...imageData(snapshot2) };
      }
      const uploaded = await uploads.read(ctx, source);
      if (uploaded) return { source, ...imageData(uploaded, "uploaded image") };
      const file = tripFileSource(source);
      if (file) return { source, ...imageData(await ctx.files.getContent(file.tripId, file.fileId), "trip file") };
      if (/^https:\/\//i.test(source)) return { source, ...await fetchExternalImage(source) };
      fail(400, "Unsupported image source.");
    }
    async function captureSnapshotAssets(ctx, note) {
      const sources = imageSources(note.content);
      if (sources.length > maxSnapshotAssets) fail(400, "A snapshot can include at most {count} images.", { count: maxSnapshotAssets });
      const assets = [];
      let totalBytes = 0;
      for (const source of sources) {
        const file = tripFileSource(source);
        let image;
        try {
          let content = file ? await ctx.files.getContent(file.tripId, file.fileId) : await uploads.read(ctx, source);
          if (!content && /^https:\/\//i.test(source)) content = await fetchExternalImage(source);
          if (!content) continue;
          image = imageData(content, file ? "trip file" : "image");
        } catch (error) {
          if (error instanceof Problem) continue;
          throw error;
        }
        totalBytes += image.size;
        if (totalBytes > maxSnapshotAssetsBytes) fail(400, "Snapshot images exceed the 32 MB limit.");
        assets.push({ source, ...image });
      }
      return assets;
    }
    async function beginTripNote(ctx, input) {
      const trip = await checkTrip(ctx, input.trip_id);
      await requireTripEdit(ctx, trip.id);
      const ownerId = number(input.actor_id);
      const members = await ctx.trips.members(trip.id);
      if (Number(trip.user_id) !== ownerId && !members.some((member) => Number(member.id) === ownerId)) fail(403, "Trip member not found.");
      const tripFolderId = input.trip_folder_id ? id2(input.trip_folder_id) : null;
      if (tripFolderId) {
        const [folder] = await ctx.db.query("SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0", tripFolderId, trip.id);
        if (!folder) fail(404, "Folder not found.");
      }
      await ctx.db.exec(`INSERT OR REPLACE INTO trip_note_intents (owner_id, trip_id, trip_folder_id, created_at)
    VALUES (?, ?, ?, ?)`, ownerId, trip.id, tripFolderId, (/* @__PURE__ */ new Date()).toISOString());
      return { staged: true };
    }
    async function takeTripNoteIntent(ctx, userId) {
      const [intent] = await ctx.db.query("SELECT trip_id, trip_folder_id, created_at FROM trip_note_intents WHERE owner_id = ?", userId);
      if (!intent) return null;
      await ctx.db.exec("DELETE FROM trip_note_intents WHERE owner_id = ?", userId);
      if (Date.now() - Date.parse(intent.created_at) > 10 * 60 * 1e3) return null;
      try {
        const trip = await checkTrip(ctx, intent.trip_id);
        await requireTripEdit(ctx, trip.id);
        return { tripId: trip.id, tripFolderId: intent.trip_folder_id || null, title: trip.title };
      } catch (error) {
        if (error instanceof Problem && [403, 404].includes(error.status)) return null;
        throw error;
      }
    }
    async function createTripNote(ctx, userId, input) {
      const trip = await checkTrip(ctx, input.trip_id);
      await requireTripEdit(ctx, trip.id);
      const { title, content, tags } = noteFields(input);
      const properties = input.properties === void 0 ? "[]" : propertyFields(input.properties);
      const icon = noteIcon(input.icon);
      const libraryFolderId = input.library_folder_id ? id2(input.library_folder_id) : null;
      if (libraryFolderId) await folderForWrite(ctx, userId, libraryFolderId);
      const tripFolderId = input.trip_folder_id ? id2(input.trip_folder_id) : null;
      if (tripFolderId) {
        const [folder] = await ctx.db.query("SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0", tripFolderId, trip.id);
        if (!folder) fail(404, "Folder not found.");
      }
      const noteId = randomUUID();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const ops = [
        {
          sql: `INSERT INTO notes (id, owner_id, title, content, tags, properties, icon, visibility, folder_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?)`,
          args: [noteId, userId, title, content, tags ?? "[]", properties, icon, libraryFolderId, now, now]
        },
        {
          sql: `INSERT INTO trip_note_links (trip_id, note_id, source_owner_id, linked_by, mode, day_id, linked_at)
        VALUES (?, ?, ?, ?, 'live', NULL, ?)`,
          args: [trip.id, noteId, userId, userId, now]
        }
      ];
      if (tripFolderId) ops.push({
        sql: "INSERT INTO trip_note_folders (trip_id, note_id, folder_id) VALUES (?, ?, ?)",
        args: [trip.id, noteId, tripFolderId]
      });
      await ctx.db.tx([...ops, ...uploads.referenceOps("", content)]);
      return owned(ctx, userId, noteId);
    }
    async function createTripLink(ctx, userId, input) {
      const note = await readable(ctx, userId, input.note_id);
      const trip = await checkTrip(ctx, input.trip_id);
      const dayId = await checkDay(ctx, trip.id, input.day_id);
      if (!["live", "snapshot"].includes(input.mode)) fail(400, "Choose live reference or snapshot.");
      if (input.mode === "live" && note.owner_id !== userId && !(await noteAccess(ctx, userId, note)).publicReadable)
        fail(403, "Only the owner can share a private note live. Import a snapshot instead.");
      await requireTripEdit(ctx, trip.id);
      const [existing] = await ctx.db.query("SELECT note_id FROM trip_note_links WHERE trip_id = ? AND note_id = ?", trip.id, note.id);
      if (existing) fail(409, "Already linked. Remove the existing link before replacing it.");
      const linkedAt = (/* @__PURE__ */ new Date()).toISOString();
      const assets = input.mode === "snapshot" ? await captureSnapshotAssets(ctx, note) : [];
      const ops = [{
        sql: `INSERT INTO trip_note_links (trip_id, note_id, source_owner_id, linked_by, mode, day_id, linked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [trip.id, note.id, note.owner_id, userId, input.mode, dayId, linkedAt]
      }];
      if (input.mode === "snapshot") {
        ops.push({
          sql: `INSERT INTO trip_note_snapshots (trip_id, note_id, title, content, tags, properties, icon, version,
        updated_at, visibility, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            trip.id,
            note.id,
            note.title,
            note.content,
            JSON.stringify(note.tags),
            JSON.stringify(note.properties),
            note.icon ?? null,
            note.version,
            note.updated_at,
            note.visibility,
            linkedAt
          ]
        });
        for (const asset2 of assets) {
          ops.push({
            sql: `INSERT INTO snapshot_assets (trip_id, note_id, source, mimetype, size, content_base64)
          VALUES (?, ?, ?, ?, ?, ?)`,
            args: [trip.id, note.id, asset2.source, asset2.mimetype, asset2.size, asset2.content_base64]
          });
        }
      }
      try {
        await ctx.db.tx(ops);
      } catch (error) {
        if (/UNIQUE constraint failed: trip_note_links\.trip_id, trip_note_links\.note_id/.test(error.message)) {
          fail(409, "Already linked. Remove the existing link before replacing it.");
        }
        throw error;
      }
      return { linked: true };
    }
    async function tripAction2(input, ctx, authenticatedUserId = null) {
      if (input.action === "links") {
        if (!Number.isSafeInteger(authenticatedUserId) || authenticatedUserId < 1) fail(401, "Sign in first.");
        const noteId = id2(input.note_id);
        await owned(ctx, authenticatedUserId, noteId);
        const accessibleTrips = await ctx.trips.listMine();
        const tripById = new Map(accessibleTrips.map((trip) => [Number(trip.id), trip]));
        const links = await ctx.db.query("SELECT trip_id, mode, day_id FROM trip_note_links WHERE note_id = ? ORDER BY trip_id", noteId);
        return links.flatMap((link) => {
          const trip = tripById.get(link.trip_id);
          return trip ? [{ id: link.trip_id, title: trip.title, mode: link.mode, day_id: link.day_id }] : [];
        });
      }
      const tripId = number(input.trip_id);
      if (["folders", "folder_create", "folder_icon", "folder_archive", "folder_move", "folder_parent"].includes(input.action)) {
        return tripFolderAction(input, ctx);
      }
      if (input.action === "list") return tripNotes(ctx, tripId, input.folder_id ? id2(input.folder_id) : null);
      if (input.action === "asset") return asset(ctx, null, input);
      if (input.action === "begin_note") return beginTripNote(ctx, input);
      await checkTrip(ctx, tripId);
      if (input.action === "days") return ctx.trips.getDays(tripId);
      if (input.action === "can_edit") {
        await requireTripEdit(ctx, tripId);
        return { can_edit: true };
      }
      if (input.action === "unlink") {
        const noteId = id2(input.note_id);
        await requireTripEdit(ctx, tripId);
        await ctx.db.tx([
          { sql: "DELETE FROM trip_note_folders WHERE trip_id = ? AND note_id = ?", args: [tripId, noteId] },
          { sql: "DELETE FROM snapshot_assets WHERE trip_id = ? AND note_id = ?", args: [tripId, noteId] },
          { sql: "DELETE FROM trip_note_snapshots WHERE trip_id = ? AND note_id = ?", args: [tripId, noteId] },
          { sql: "DELETE FROM trip_note_links WHERE trip_id = ? AND note_id = ?", args: [tripId, noteId] }
        ]);
        return { removed: true };
      }
      if (input.action === "excerpt") {
        const { notes } = await tripNotes(ctx, tripId);
        const note = notes.find((item) => item.id === id2(input.note_id) && !item.unavailable);
        if (!note) fail(404, "Linked note not found.");
        const dayId = await checkDay(ctx, tripId, input.day_id);
        if (!dayId) fail(400, "Choose a day.");
        const excerpt = text(input.text, 500, "excerpt").trim();
        if (!excerpt) fail(400, "An excerpt is required.");
        return ctx.daynotes.create(tripId, dayId, { text: excerpt });
      }
      fail(400, "Unknown action.");
    }
    async function folderPath(ctx, folderId) {
      const names = [];
      const seen = /* @__PURE__ */ new Set();
      let currentId = folderId;
      while (currentId) {
        if (seen.has(currentId) || names.length > 64) fail(409, "Folder hierarchy is cyclic.");
        seen.add(currentId);
        const [folder] = await ctx.db.query("SELECT name, parent_id FROM folders WHERE id = ? AND archived = 0", currentId);
        if (!folder) return "";
        names.unshift(folder.name);
        currentId = folder.parent_id;
      }
      return names.join("/");
    }
    async function resolveReference(ctx, userId, reference, tripId = null) {
      const raw = text(reference, 300, "reference").trim();
      const notePattern = /^fieldnotes:\/\/note\/([0-9a-f-]{36})$/i;
      if (tripId !== null) {
        const notes = (await tripNotes(ctx, number(tripId))).notes.filter((item) => !item.unavailable);
        const found = notes.find((item) => item.id === (raw.match(notePattern)?.[1] || raw) || item.title === raw || `${item.title}` === raw.split("/").at(-1));
        return found ? { reference: raw, id: found.id, title: found.title } : { reference: raw, unavailable: true };
      }
      if (notePattern.test(raw)) {
        try {
          const note = await readable(ctx, userId, raw.match(notePattern)[1]);
          return { reference: raw, id: note.id, title: note.title };
        } catch {
          return { reference: raw, unavailable: true };
        }
      }
      const title = raw.split("/").at(-1);
      const [rows, access] = await Promise.all([
        ctx.db.query("SELECT * FROM notes WHERE archived = 0 AND title = ? ORDER BY updated_at DESC, id", title),
        listAccessData(ctx, userId)
      ]);
      for (const row of rows) {
        if (!noteAccessFromRows(userId, row, access).canRead) continue;
        if (raw.includes("/")) {
          const path = row.folder_id ? await folderPath(ctx, row.folder_id) : "";
          if (`${path ? `${path}/` : ""}${row.title}` !== raw) continue;
        }
        return { reference: raw, id: row.id, title: row.title };
      }
      return { reference: raw, unavailable: true };
    }
    async function listNotes(ctx, userId, {
      search = "",
      offset = 0,
      publicOnly = false,
      folderId = null,
      sort = "updated",
      order = "desc",
      locale
    }) {
      const needle = search.toLocaleLowerCase();
      const matches = (note) => !needle || [note.title, note.content, note.tags.join("\n"), propertyText(note.properties)].some((value) => value.toLocaleLowerCase().includes(needle));
      const [rows, access] = await Promise.all([
        ctx.db.query(`SELECT id, owner_id, title, content, tags, properties, icon, version,
      created_at, updated_at, visibility, folder_id FROM notes
      WHERE archived = 0 ORDER BY updated_at DESC, id`),
        listAccessData(ctx, userId, !publicOnly)
      ]);
      const visible = [];
      let skippedCount = 0;
      for (const row of rows) {
        if (folderId !== null && row.folder_id !== folderId) continue;
        if (!matches(decode(row))) continue;
        try {
          const noteAccess2 = noteAccessFromRows(userId, row, access);
          const listed = publicOnly ? row.visibility === "public" && noteAccess2.publicReadable : row.owner_id === userId || Boolean(noteAccess2.directRole) || noteAccess2.inheritedRole > 0;
          if (listed) visible.push(decode(row));
        } catch {
          skippedCount += 1;
        }
      }
      const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
      const direction = order === "asc" ? 1 : -1;
      visible.sort((a, b) => direction * noteSorts[sort](a, b, collator) || a.id.localeCompare(b.id));
      return { notes: visible.slice(offset, offset + pageSize), has_more: visible.length > offset + pageSize, skipped_count: skippedCount };
    }
    var uploads = createAssets({ fail });
    var collab = createCollab({
      fail,
      id: id2,
      editable,
      noteFields,
      propertyFields,
      noteIcon,
      referenceOps: uploads.referenceOps,
      sweep: uploads.sweep
    });
    async function handle2(action, req, ctx) {
      const userId = actor(req);
      const body = req.body || {};
      const query = req.query || {};
      if (action === "trips") return ctx.trips.listMine();
      if (action === "folders") return listFolders(ctx, userId);
      if (action === "folder") return folderAction({ ...body, ...query }, ctx, userId);
      if (action === "reference") return resolveReference(ctx, userId, query.ref, query.trip_id || null);
      if (action === "asset") return asset(ctx, userId, query);
      if (action === "upload") return uploads.upload(ctx, userId, body);
      if (action === "collaborators") return collaborators(ctx, userId, query.note_id);
      if (action === "collaborator") return collaboratorAction(body, ctx, userId);
      if (action === "trip") {
        if (body.action === "begin_note") fail(400, "Trip note intents must come from the companion plugin.");
        return tripAction2({ ...body, ...query }, ctx, userId);
      }
      if (action === "collab") return collab.action(body, ctx, userId);
      if (action === "note_settings") {
        const note = await owned(ctx, userId, body.id);
        if (!["private", "public"].includes(body.visibility)) fail(400, "Invalid visibility.");
        await ctx.db.exec("UPDATE notes SET visibility = ? WHERE id = ?", body.visibility, note.id);
        return owned(ctx, userId, note.id);
      }
      if (action === "trip_intent") return takeTripNoteIntent(ctx, userId);
      if (action === "trip_note") return createTripNote(ctx, userId, body);
      if (action === "list" || action === "public") {
        const search = text(query.q || "", 120, "search");
        const offset = Number(query.offset || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) fail(400, "Invalid page.");
        const folderId = query.folder_id ? id2(query.folder_id) : null;
        const sort = query.sort || "updated";
        const order = query.order || "desc";
        if (!Object.hasOwn(noteSorts, sort) || !["asc", "desc"].includes(order)) fail(400, "Invalid sort order.");
        let locale;
        try {
          [locale] = Intl.Collator.supportedLocalesOf(text(query.locale || "en", 35, "locale"));
        } catch {
          fail(400, "Invalid locale.");
        }
        return listNotes(ctx, userId, { search, offset, folderId, sort, order, locale, publicOnly: action === "public" });
      }
      if (action === "read") return readable(ctx, userId, query.id);
      if (action === "save") {
        const { title, content, tags } = noteFields(body);
        const properties = body.properties === void 0 ? void 0 : propertyFields(body.properties);
        const icon = body.icon === void 0 ? void 0 : noteIcon(body.icon);
        if (body.visibility !== void 0 && !["private", "public"].includes(body.visibility)) fail(400, "Invalid visibility.");
        const now = (/* @__PURE__ */ new Date()).toISOString();
        if (body.id) {
          const current = await editable(ctx, userId, body.id);
          if (body.version !== current.version) fail(409, "This note changed. Reload before saving.");
          if (body.visibility && body.visibility !== current.visibility && current.owner_id !== userId)
            fail(403, "Only the owner can change visibility.");
          const folderId2 = body.folder_id === void 0 ? current.folder_id : body.folder_id || null;
          if (folderId2 !== current.folder_id && current.owner_id !== userId) fail(403, "Only the owner can move a note.");
          if (folderId2 && folderId2 !== current.folder_id) await folderForWrite(ctx, userId, folderId2);
          const visibility2 = body.visibility || current.visibility;
          const result = await ctx.db.exec(
            `UPDATE notes SET title = ?, content = ?, tags = COALESCE(?, tags),
        properties = COALESCE(?, properties),
        icon = CASE WHEN ? THEN ? ELSE icon END, visibility = ?, folder_id = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND archived = 0`,
            title,
            content,
            tags ?? null,
            properties ?? null,
            icon !== void 0 ? 1 : 0,
            icon ?? null,
            visibility2,
            folderId2,
            now,
            current.id,
            body.version
          );
          if (result.changes !== 1) fail(409, "This note changed. Reload before saving.");
          await uploads.track(ctx, current.content, content);
          await uploads.sweep(ctx);
          const saved = await readable(ctx, userId, current.id);
          await collab.external(ctx, saved);
          return saved;
        }
        const noteId = randomUUID();
        const visibility = body.visibility || "private";
        const folderId = body.folder_id || null;
        if (folderId) await folderForWrite(ctx, userId, folderId);
        await ctx.db.exec(
          `INSERT INTO notes (id, owner_id, title, content, tags, properties, icon, visibility, folder_id, created_at,
      updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          noteId,
          userId,
          title,
          content,
          tags ?? "[]",
          properties ?? "[]",
          icon ?? null,
          visibility,
          folderId,
          now,
          now
        );
        await uploads.track(ctx, "", content);
        return owned(ctx, userId, noteId);
      }
      if (action === "archive") {
        const current = await owned(ctx, userId, body.id);
        const result = await ctx.db.exec(
          "UPDATE notes SET archived = 1, version = version + 1 WHERE id = ? AND owner_id = ? AND version = ?",
          body.id,
          userId,
          body.version
        );
        if (result.changes !== 1) fail(409, "This note changed. Reload before deleting.");
        collab.forget(body.id);
        await uploads.track(ctx, current.content, "");
        await uploads.sweep(ctx);
        return { archived: true };
      }
      if (action === "link") return createTripLink(ctx, userId, body);
      fail(404, "Unknown route.");
    }
    async function deleteUserData2(ctx, userId) {
      await ctx.db.tx([
        { sql: "DELETE FROM trip_note_intents WHERE owner_id = ?", args: [userId] },
        { sql: "DELETE FROM asset_uploads WHERE owner_id = ?", args: [userId] },
        { sql: "DELETE FROM note_assets WHERE owner_id = ?", args: [userId] },
        { sql: "DELETE FROM note_presence WHERE user_id = ? OR note_id IN (SELECT id FROM notes WHERE owner_id = ?)", args: [userId, userId] },
        { sql: "DELETE FROM note_updates WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)", args: [userId] },
        { sql: "DELETE FROM note_crdt WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)", args: [userId] },
        { sql: `DELETE FROM trip_note_folders WHERE EXISTS (
      SELECT 1 FROM trip_note_links l WHERE l.trip_id = trip_note_folders.trip_id AND l.note_id = trip_note_folders.note_id
      AND (l.source_owner_id = ? OR l.linked_by = ?))`, args: [userId, userId] },
        { sql: `DELETE FROM snapshot_assets WHERE EXISTS (
      SELECT 1 FROM trip_note_links l WHERE l.trip_id = snapshot_assets.trip_id AND l.note_id = snapshot_assets.note_id
      AND (l.source_owner_id = ? OR l.linked_by = ?))`, args: [userId, userId] },
        { sql: `DELETE FROM snapshot_assets WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)`, args: [userId] },
        { sql: `DELETE FROM trip_note_folders WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)`, args: [userId] },
        { sql: `DELETE FROM trip_note_snapshots WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)`, args: [userId] },
        { sql: `DELETE FROM trip_note_snapshots WHERE EXISTS (
      SELECT 1 FROM trip_note_links l WHERE l.trip_id = trip_note_snapshots.trip_id AND l.note_id = trip_note_snapshots.note_id
      AND (l.source_owner_id = ? OR l.linked_by = ?))`, args: [userId, userId] },
        { sql: "DELETE FROM trip_note_links WHERE source_owner_id = ? OR linked_by = ?", args: [userId, userId] },
        {
          sql: "DELETE FROM note_collaborators WHERE user_id = ? OR note_id IN (SELECT id FROM notes WHERE owner_id = ?)",
          args: [userId, userId]
        },
        {
          sql: "DELETE FROM folder_collaborators WHERE user_id = ? OR folder_id IN (SELECT id FROM folders WHERE owner_id = ?)",
          args: [userId, userId]
        },
        { sql: "UPDATE notes SET folder_id = NULL WHERE folder_id IN (SELECT id FROM folders WHERE owner_id = ?)", args: [userId] },
        { sql: "UPDATE folders SET parent_id = NULL WHERE parent_id IN (SELECT id FROM folders WHERE owner_id = ?)", args: [userId] },
        { sql: "DELETE FROM folders WHERE owner_id = ?", args: [userId] },
        { sql: "DELETE FROM notes WHERE owner_id = ?", args: [userId] }
      ]);
    }
    async function exportUserData2(ctx, userId) {
      const [
        notes,
        noteAssets,
        folders,
        noteCollaborators,
        folderCollaborators2,
        tripLinks,
        tripSnapshots,
        tripSnapshotAssets
      ] = await Promise.all([
        ctx.db.query("SELECT * FROM notes WHERE owner_id = ?", userId),
        ctx.db.query("SELECT * FROM note_assets WHERE owner_id = ?", userId),
        ctx.db.query("SELECT * FROM folders WHERE owner_id = ?", userId),
        ctx.db.query(
          "SELECT * FROM note_collaborators WHERE user_id = ? OR note_id IN (SELECT id FROM notes WHERE owner_id = ?)",
          userId,
          userId
        ),
        ctx.db.query(
          "SELECT * FROM folder_collaborators WHERE user_id = ? OR folder_id IN (SELECT id FROM folders WHERE owner_id = ?)",
          userId,
          userId
        ),
        ctx.db.query("SELECT * FROM trip_note_links WHERE source_owner_id = ? OR linked_by = ?", userId, userId),
        ctx.db.query(`SELECT s.* FROM trip_note_snapshots s JOIN trip_note_links l USING (trip_id, note_id)
      WHERE l.source_owner_id = ? OR l.linked_by = ?`, userId, userId),
        ctx.db.query(`SELECT a.* FROM snapshot_assets a JOIN trip_note_links l USING (trip_id, note_id)
      WHERE l.source_owner_id = ? OR l.linked_by = ?`, userId, userId)
      ]);
      return { notes, noteAssets, folders, noteCollaborators, folderCollaborators: folderCollaborators2, tripLinks, tripSnapshots, tripSnapshotAssets };
    }
    var json = (status, value) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    async function respond2(fn) {
      try {
        return json(200, await fn());
      } catch (error) {
        console.error("[Fieldnotes] request failed:", error instanceof Error ? error.stack : String(error));
        const problem = error instanceof Problem ? error : /RESOURCE_FORBIDDEN|PERMISSION_DENIED/.test(error?.message) ? new Problem(403, "You do not have permission to do this.") : error?.status >= 400 && error.status < 500 ? new Problem(error.status, String(error.message)) : null;
        if (!problem) return json(500, { error: "Request failed. Try again or check the plugin logs." });
        return json(200, { error: problem.message, status: problem.status, template: problem.template, params: problem.params });
      }
    }
    module2.exports = { initialize: initialize2, handle: handle2, tripAction: tripAction2, respond: respond2, deleteUserData: deleteUserData2, exportUserData: exportUserData2 };
  }
});

// server/index.js
var { definePlugin } = require("trek-plugin-sdk");
var { initialize, handle, tripAction, respond, deleteUserData, exportUserData } = require_service();
var endpoints = [
  ["GET", "/notes", "list"],
  ["GET", "/folders", "folders"],
  ["GET", "/reference", "reference"],
  ["GET", "/note", "read"],
  ["POST", "/save", "save"],
  ["POST", "/trip-intent", "trip_intent"],
  ["POST", "/trip-note", "trip_note"],
  ["POST", "/archive", "archive"],
  ["POST", "/link", "link"],
  ["GET", "/public", "public"],
  ["GET", "/asset", "asset"],
  ["POST", "/upload", "upload"],
  ["GET", "/collaborators", "collaborators"],
  ["POST", "/collaborator", "collaborator"],
  ["GET", "/trips", "trips"],
  ["POST", "/folder", "folder"],
  ["POST", "/trip", "trip"],
  ["POST", "/collab", "collab"],
  ["POST", "/note-settings", "note_settings"]
];
module.exports = definePlugin({
  onLoad: initialize,
  routes: endpoints.map(([method, path, action]) => ({
    method,
    path,
    auth: true,
    handler: (req, ctx) => respond(() => handle(action, req, ctx))
  })),
  exports: {
    // Only trip-scoped operations are exposed. No caller-supplied user identity is trusted.
    trip: (args2, ctx) => respond(() => tripAction(args2, ctx))
  },
  hooks: {
    mcpToolProvider: {
      tools: ["list_trip_notes"],
      callTool: ({ args: args2 }, ctx) => tripAction({ trip_id: args2.trip_id, action: "list" }, ctx)
    }
  },
  deleteUserData: ({ userId }, ctx) => deleteUserData(ctx, userId),
  exportUserData: ({ userId }, ctx) => exportUserData(ctx, userId)
});
