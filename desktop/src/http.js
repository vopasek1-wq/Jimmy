// HTTP klient: slušné hlavičky, pauzy mezi požadavky, opakování a rozpoznání blokace.
// Chyby mají česká uživatelská hlášení – zobrazují se přímo v aplikaci.
"use strict";

const config = require("./config");

class SourceError extends Error {
  constructor(message) { super(message); this.name = "SourceError"; }
}
/** Není spojení / server neodpovídá. `offline` = nejspíš chybí internet. */
class NetworkError extends SourceError {
  constructor(message, offline = false) { super(message); this.name = "NetworkError"; this.offline = offline; }
}
/** Server nás pustil jen ke kontrole robota (Cloudflare, CAPTCHA, 403/429). */
class BlockedError extends SourceError {
  constructor(message) { super(message); this.name = "BlockedError"; }
}

const BLOCK_TITLE = /<title>\s*(just a moment|attention required|access denied|are you a robot)/i;
const BLOCK_BODY = ["cf-browser-verification", "cf-chl-", "challenges.cloudflare.com/turnstile"];

/** True, pokud odpověď není skutečný obsah, ale stránka kontroly robota. */
function looksBlocked(status, text) {
  if (BLOCK_TITLE.test(text.slice(0, 4000))) return true;
  if ([403, 429, 503].includes(status)) {
    const low = text.slice(0, 20000).toLowerCase();
    return BLOCK_BODY.some((m) => low.includes(m)) || status === 403 || status === 429;
  }
  return false;
}

const OFFLINE_RE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ERR_NETWORK_CHANGED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|fetch failed/i;
const TIMEOUT_RE = /abort|timeout|ETIMEDOUT|ERR_TIMED_OUT/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class HttpClient {
  /**
   * @param {object} opts
   * @param {Function} opts.fetchFn  fetch-kompatibilní funkce (v Electronu net.fetch → síťový stack Chromia)
   */
  constructor({
    fetchFn = (...a) => globalThis.fetch(...a), delayMs = config.REQUEST_DELAY_MS, retries = config.REQUEST_RETRIES,
    timeoutMs = config.REQUEST_TIMEOUT_MS, sleep = defaultSleep, userAgent = null,
  } = {}) {
    this.fetchFn = fetchFn;
    this.delayMs = delayMs;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.userAgent = userAgent;
    this.lastRequest = new Map();
  }

  /** Mezi dvěma požadavky na stejný server počká náhodnou dobu – nezatěžujeme ho. */
  async waitTurn(host) {
    const last = this.lastRequest.get(host);
    if (last !== undefined) {
      const [lo, hi] = this.delayMs;
      const wanted = lo + Math.random() * (hi - lo);
      const remaining = wanted - (Date.now() - last);
      if (remaining > 0) await this.sleep(remaining);
    }
    this.lastRequest.set(host, Date.now());
  }

  async request(url, { headers = {} } = {}) {
    const host = new URL(url).host;
    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.waitTurn(host);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await this.fetchFn(url, {
          headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
            "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
            ...(this.userAgent ? { "User-Agent": this.userAgent } : {}),
            ...headers,
          },
          signal: controller.signal,
        });
        const text = await resp.text();
        if (looksBlocked(resp.status, text)) {
          throw new BlockedError(`${host} požaduje ověření (ochrana proti robotům, HTTP ${resp.status}).`);
        }
        if (resp.status >= 500) {
          lastError = new SourceError(`${host} vrací chybu serveru (HTTP ${resp.status}).`);
        } else if (resp.status >= 400) {
          const err = new SourceError(`${host} vrací HTTP ${resp.status} pro ${new URL(url).pathname}.`);
          err.status = resp.status;
          throw err;
        } else {
          return { status: resp.status, text };
        }
      } catch (err) {
        if (err instanceof SourceError && !(err instanceof NetworkError)) {
          if (err instanceof BlockedError || !String(err.message).includes("chybu serveru")) throw err;
          lastError = err;
        } else {
          const msg = String(err && (err.cause && err.cause.code ? `${err.message} ${err.cause.code}` : err.message));
          lastError = TIMEOUT_RE.test(msg) && !OFFLINE_RE.test(msg)
            ? new NetworkError(`${host} neodpovídá (vypršel časový limit).`)
            : new NetworkError(`Nelze se připojit k ${host}. Zkontrolujte připojení k internetu.`, OFFLINE_RE.test(msg));
        }
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.retries) await this.sleep(1500 * (attempt + 1));
    }
    throw lastError;
  }

  async getText(url, opts) {
    return (await this.request(url, opts)).text;
  }

  async getJson(url, opts) {
    const { text } = await this.request(url, opts);
    try {
      return JSON.parse(text);
    } catch {
      throw new SourceError(`${new URL(url).host} nevrátil platná data (JSON).`);
    }
  }
}

module.exports = { HttpClient, SourceError, NetworkError, BlockedError, looksBlocked };
