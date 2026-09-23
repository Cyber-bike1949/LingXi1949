export function feedbackLink(base: string, version: string, language: string): string {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('HTTPS_REQUIRED');
  url.search = ''; url.hash = '';
  url.searchParams.set('pluginVersion',version);
  url.searchParams.set('lang',language);
  return url.href;
}
