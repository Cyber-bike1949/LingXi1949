export const FEEDBACK_URL = 'http://cyber-bike.duckdns.org:3000/feedback';

export function feedbackLink(base: string, version: string, language: string, platform?: string): string {
  const url = new URL(base);
  if ((url.protocol !== 'https:' && url.origin !== new URL(FEEDBACK_URL).origin) || url.username || url.password) throw new Error('HTTPS_REQUIRED');
  url.search = ''; url.hash = '';
  url.searchParams.set('pluginVersion',version);
  url.searchParams.set('lang',language);
  if (platform) url.searchParams.set('os', platform);
  return url.href;
}
