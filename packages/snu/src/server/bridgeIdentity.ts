import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A stable identity for "the ScriptSync bridge of this user on this machine".
 *
 * The SN Utils helper tab re-sends ServiceNow session tokens on its own when it
 * reconnects, but only to a bridge the user has handed a token to before. This
 * id is how it recognises that bridge after a restart: it is created once,
 * kept private to the user under ~/.sn-scriptsync, and shared by the VS Code
 * host and the standalone snu bridge so switching hosts does not reset trust.
 *
 * Returns an empty string when the file cannot be read or created. The helper
 * then never refreshes automatically and a manual /token is needed, which is
 * the behaviour from before this existed.
 */
export function loadBridgeId(dir: string = path.join(os.homedir(), ".sn-scriptsync")): string {
	const file = path.join(dir, "bridge-id");
	const read = (): string => {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) return "";
		// Existing files need the same privacy as newly created ones.
		if (process.platform !== "win32") fs.chmodSync(file, 0o600);
		const id = fs.readFileSync(file, "utf8").trim();
		return /^[a-f0-9]{64}$/.test(id) ? id : "";
	};
	try { return read(); } catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "";
	}
	let temporary = "";
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const id = crypto.randomBytes(32).toString("hex");
		temporary = path.join(dir, `.bridge-id-${crypto.randomBytes(16).toString("hex")}`);
		fs.writeFileSync(temporary, id + "\n", { mode: 0o600, flag: "wx" });
		// Publish only a complete file, without replacing another host's identity.
		try { fs.linkSync(temporary, file); } catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return "";
		}
		return read();
	} catch {
		return "";
	} finally {
		if (temporary) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } }
	}
}

export type BridgeIdStatus = "ok" | "missing" | "invalid" | "not-a-file" | "unreadable";

/**
 * Read-only look at the identity file, for diagnostics. Unlike loadBridgeId it
 * never creates the file or changes its mode, and it never returns the id.
 */
export function inspectBridgeId(dir: string = path.join(os.homedir(), ".sn-scriptsync")): { status: BridgeIdStatus; private: boolean | null } {
	const file = path.join(dir, "bridge-id");
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) return { status: "not-a-file", private: null };
		const isPrivate = process.platform === "win32" ? null : (stat.mode & 0o077) === 0;
		const id = fs.readFileSync(file, "utf8").trim();
		return { status: /^[a-f0-9]{64}$/.test(id) ? "ok" : "invalid", private: isPrivate };
	} catch (err) {
		return { status: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", private: null };
	}
}
