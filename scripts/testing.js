import { createHash } from 'node:crypto';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

// What the tests of the scripts share: the SHA-256 of bytes, and writers of
// the archive files that the scripts read (a zip file, a `.tar.gz` file).

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// An extra field of a zip header: an id that no tool knows, and data of
// `length` bytes.
function zipExtraField(length) {
  const field = Buffer.alloc(4 + length, 0x2a);
  field.writeUInt16LE(0x6564, 0);
  field.writeUInt16LE(length, 2);
  return field;
}

// The bytes of a zip file with the given files, in the form that the `zip`
// program writes. Each file is `{ name, bytes }`, and can set `method` (8,
// deflated, when it is not given; 0 is stored) and `flags`.
//
// The header of a file before its data has a longer extra field than its
// entry in the list of the files, as in a zip file of the `zip` program (it
// puts more times there): a reader that takes the lengths of the list for
// the header reads from a wrong place.
export function zipFile(files) {
  const parts = [];
  const entries = [];
  let offset = 0;
  for (const { name, bytes, method = 8, flags = 0 } of files) {
    const nameBytes = Buffer.from(name);
    const packed = method === 8 ? deflateRawSync(bytes) : bytes;
    // The fields that the two headers share: the version to read the file,
    // the flags, the method, the time and date, the CRC-32, the two sizes,
    // and the lengths of the name and of the extra field.
    const shared = extraLength => {
      const fields = Buffer.alloc(26);
      fields.writeUInt16LE(20, 0);
      fields.writeUInt16LE(flags, 2);
      fields.writeUInt16LE(method, 4);
      fields.writeUInt32LE(crc32(bytes), 10);
      fields.writeUInt32LE(packed.length, 14);
      fields.writeUInt32LE(bytes.length, 18);
      fields.writeUInt16LE(nameBytes.length, 22);
      fields.writeUInt16LE(extraLength, 24);
      return fields;
    };
    const localExtra = zipExtraField(9);
    const entryExtra = zipExtraField(5);

    const localSignature = Buffer.alloc(4);
    localSignature.writeUInt32LE(0x04034b50);
    const local = Buffer.concat([localSignature, shared(localExtra.length), nameBytes, localExtra, packed]);

    // After the shared fields of an entry: the comment length, the disk, the
    // two attribute fields, and the place of the header of the file.
    const entryHead = Buffer.alloc(6);
    entryHead.writeUInt32LE(0x02014b50, 0);
    entryHead.writeUInt16LE(20, 4);
    const entryTail = Buffer.alloc(14);
    entryTail.writeUInt32LE(offset, 10);
    entries.push(Buffer.concat([entryHead, shared(entryExtra.length), entryTail, nameBytes, entryExtra]));

    parts.push(local);
    offset += local.length;
  }

  const list = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(list.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, list, end]);
}

// One 512-byte header of a tar file, in the GNU form that cargo writes. The
// name field has only the first 100 bytes of a name.
function tarHeader(name, size, type) {
  const header = Buffer.alloc(512);
  Buffer.from(name).copy(header, 0, 0, 100);
  header.write('0000644\0', 100);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write(type, 156);
  header.write('ustar  \0', 257);
  // The checksum is the sum of the header bytes, with spaces in its own
  // field.
  header.fill(' ', 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

// The header and the data of one entry of a tar file. The data is padded to
// whole blocks of 512 bytes.
function tarEntry(name, data, type) {
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length, type), data, padding]);
}

// The bytes of a `.tar.gz` file with the given files (`{ name, text }`), as
// cargo writes a crate file: a name of more than 100 bytes is in an entry
// of the type `L` before its file (the GNU long name), and the header of
// the file has only the start of the name. `type` sets the type of an entry
// that is not a file (`5` is a folder).
export function tarGzFile(files) {
  const entries = files.flatMap(({ name, text = '', type = '0' }) => {
    const entry = tarEntry(name, Buffer.from(text), type);
    return Buffer.byteLength(name) > 100 ? [tarEntry('././@LongLink', Buffer.from(`${name}\0`), 'L'), entry] : [entry];
  });
  // Two empty blocks end a tar file.
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}
