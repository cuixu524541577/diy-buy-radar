/** Shared low-friction public fetch: honest UA, timeout, no login/captcha bypass. */

export const HONEST_UA =
  'DIY-Buy-Radar/0.1 (research; once-daily public snapshot; contact: local-dev)';

function scoreDecoded(text: string): number {
  if (!text || text.includes('\u0000')) return -1e9;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const yen = (text.match(/[￥¥]/g) || []).length;
  return cjk * 3 + yen * 5 - replacement * 20;
}

function decodeBody(buf: ArrayBuffer, contentType: string | null): string {
  const bytes = Buffer.from(buf);
  const ct = (contentType || '').toLowerCase();
  const declared = ct.match(/charset\s*=\s*([\w-]+)/i)?.[1]?.toLowerCase().replace('utf8', 'utf-8');
  const candidates = [...new Set([declared, 'utf-8', 'gb18030', 'gbk'].filter(Boolean))] as string[];
  let best = '';
  let bestScore = -1e12;
  for (const enc of candidates) {
    try {
      const text = new TextDecoder(enc).decode(bytes);
      const s = scoreDecoded(text);
      if (s > bestScore) {
        bestScore = s;
        best = text;
      }
    } catch {
      /* try next */
    }
  }
  return best || bytes.toString('utf8');
}

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
    const buf = await res.arrayBuffer();
    const text = decodeBody(buf, res.headers.get('content-type'));
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
