/**
 * Test harnesses (scripts/test-save-paths.mjs) run a second bridge next to the
 * user's own. SN_SCRIPTSYNC_TEST_PORTS="<agent>,<browser>" moves both ports so
 * that bridge never binds, probes or asks to take over 1977/1978. The harness
 * also gives it its own HOME, so port files and the owner lease stay apart.
 * Unset in normal use; a malformed value is ignored.
 */
export function parseTestPorts(value: string | undefined): { agent: number; browser: number } | null {
	const match = /^\s*(\d{4,5})\s*,\s*(\d{4,5})\s*$/.exec(value || '');
	if (!match) return null;
	const [agent, browser] = [Number(match[1]), Number(match[2])];
	const usable = (port: number) => port >= 1024 && port <= 65535 && port !== 1977 && port !== 1978;
	return usable(agent) && usable(browser) && agent !== browser ? { agent, browser } : null;
}
