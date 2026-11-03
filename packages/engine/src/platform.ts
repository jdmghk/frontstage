// True on Safari and WKWebView. Chromium's user agent also contains AppleWebKit, so it's excluded by name.
export function isWebKitEngine(ua: string | undefined = typeof navigator !== "undefined" ? navigator.userAgent : undefined): boolean {
  return ua !== undefined && /AppleWebKit/.test(ua) && !/Chrome\//.test(ua);
}
