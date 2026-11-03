/** Shared low-friction public fetch: honest UA, timeout, no login/captcha bypass. */

export const HONEST_UA =
  'DIY-Buy-Radar/0.1 (research; once-daily public snapshot; contact: local-dev)';

export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; accept?: string } = {},
): Promise<{ ok: boolean; status: number; text: string; finalUrl: string }> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': HONEST_UA,
        Accept: opts.accept || 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url || url };
  } finally {
    clearTimeout(t);
  }
}

export function looksGated(text: string): boolean {
  return /验证码|登录后|captcha|access denied|checking\?backurl|service\.zol\.com\.cn\/checking/i.test(
    text,
  );
}
