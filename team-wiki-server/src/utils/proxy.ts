import { ProxyAgent, setGlobalDispatcher } from 'undici';

export function configureNodeProxyFromEnv(): string {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';

  if (!proxyUrl) return '';

  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  return proxyUrl;
}
