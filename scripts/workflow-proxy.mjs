// Herdr's background core can have a different environment from the local service.
export function loopbackProxy(env) {
  const selected = {};
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    try {
      const url = new URL(env[key]);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      ) {
        selected[key] = url.origin;
      }
    } catch {
      /* Missing, malformed or unsupported values stay in the initiating process. */
    }
  }
  return selected;
}
