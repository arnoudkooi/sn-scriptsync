import * as zlib from 'zlib';

/** A minimal zip writer: stored or deflated entries, as the instance produces. */
export function makeZip(entries: Array<{ name: string; content: string; deflate?: boolean }>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const raw = Buffer.from(e.content);
		const data = e.deflate ? zlib.deflateRawSync(raw) : raw;
		const name = Buffer.from(e.name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(e.deflate ? 8 : 0, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(e.deflate ? 8 : 0, 10);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, name, data);
		centrals.push(central, name);
		offset += local.length + name.length + data.length;
	}
	const centralSize = centrals.reduce((n, b) => n + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, ...centrals, eocd]);
}

