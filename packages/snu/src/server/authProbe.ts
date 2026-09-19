/**
 * Turns the outcome of the bounded auth probe into a state an agent can act on.
 *
 * The helper tab reports several failures without an HTTP status: no token for
 * the instance, a hostname it has not approved, or a request the browser never
 * got out. All of those used to collapse into AUTH_UNKNOWN with "retry", which
 * sends an agent in circles when the real fix is a /token on the right
 * hostname (reported by Tyler Hodges: an instance reached through both its
 * service-now.com name and a load balancer hostname).
 */

export type ProbeState = 'AUTH_OK' | 'AUTH_EXPIRED' | 'AUTH_MISSING' | 'AUTH_UNKNOWN';

export interface ProbeOutcome {
  /** HTTP status the helper tab saw, when the request got that far. */
  status?: number;
  /** Error text from the helper tab or the bridge. */
  error?: string;
  /** Origin the probe targeted, e.g. https://dev12345.service-now.com */
  origin?: string | null;
  /** True when this bridge received a /token for that origin since it started. */
  hasLiveSession: boolean;
}

export interface ProbeVerdict {
  state: ProbeState;
  message: string;
}

const SERVICENOW_HOST = /(^|\.)(service-now\.com|servicenowservices\.com)$/i;

function hostOf(origin?: string | null): string {
  try { return origin ? new URL(origin).hostname : ''; } catch { return ''; }
}

/** Extra guidance for helper-tab failures that carry no HTTP status. Empty when there is nothing to add. */
export function helperFailureHint(error: string | undefined, origin?: string | null): string {
  const text = String(error || '');
  const where = origin || 'that instance';
  if (/Missing instance URL or authentication token/i.test(text)) {
    return `No session token is known for ${where}. Open exactly that hostname in the browser and run /token.`;
  }
  if (/unapproved instance URL/i.test(text)) {
    return `The SN Utils helper tab has not approved ${where}. Open exactly that hostname in the browser, run /token and allow the instance when asked.`;
  }
  if (/Failed to fetch|NetworkError|Load failed|net::ERR_/i.test(text)) {
    const host = hostOf(origin);
    return host && !SERVICENOW_HOST.test(host)
      ? `The browser could not reach ${where}. ${host} is not a service-now.com hostname, which the regular SN Utils build cannot connect to: use the instance's service-now.com address, or the SN Utils OnPrem build.`
      : `The browser could not reach ${where}. Check that the instance is reachable from the browser (VPN, network) and that you are logged in on that hostname.`;
  }
  return '';
}

export function classifyProbe(outcome: ProbeOutcome): ProbeVerdict {
  const { status, error, origin, hasLiveSession } = outcome;
  if (status === 401) {
    return { state: 'AUTH_EXPIRED', message: 'ServiceNow rejected the session (401). Open the instance in the browser and run /token to refresh it.' };
  }
  if (status === 403 || (status !== undefined && status >= 200 && status < 300)) {
    return { state: 'AUTH_OK', message: 'ServiceNow accepted the session.' };
  }

  const hint = helperFailureHint(error, origin);
  if (/Missing instance URL or authentication token|unapproved instance URL/i.test(String(error || ''))) {
    return { state: 'AUTH_MISSING', message: hint };
  }
  if (hint) {
    return { state: 'AUTH_UNKNOWN', message: hint };
  }
  // Same rule as the VS Code host: a failure with no session ever received
  // for this origin reads as missing, not as unknown.
  if (!hasLiveSession) {
    return {
      state: 'AUTH_MISSING',
      message: `This bridge has not received a session for ${origin || 'this instance'} since it started. Open exactly that hostname in the browser and run /token. Sessions are per hostname: a /token on another address of the same instance does not count.`,
    };
  }
  return { state: 'AUTH_UNKNOWN', message: 'The session check could not complete. This is not a verdict: retry before acting on it.' };
}
