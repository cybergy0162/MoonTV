/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 跳过不需要认证的路径
  if (shouldSkipAuth(pathname)) {
    return NextResponse.next();
  }

  if (!process.env.PASSWORD) {
    // 如果没有设置密码，重定向到警告页面
    const warningUrl = new URL('/warning', request.url);
    return NextResponse.redirect(warningUrl);
  }

  // 从cookie获取认证信息
  const authInfo = getAuthInfoFromCookie(request);

  if (!authInfo) {
    return handleAuthFailure(request, pathname);
  }

  // 这里不依据 NEXT_PUBLIC_STORAGE_TYPE 判断模式，而是看 cookie 形态：
  //   localStorage 模式登录时 includePassword=true，cookie 里带 password；
  //   redis / d1 / upstash 模式的 cookie 只有 username + signature，不带 password。
  // 原因：部分平台（如 EdgeOne）的边缘中间件拿不到 NEXT_PUBLIC_STORAGE_TYPE，
  // 按环境变量判断会错误回退成 localstorage，导致非 localstorage 模式请求全部 401。
  if (authInfo.password !== undefined) {
    // localstorage 模式：cookie 内含密码，直接与 PASSWORD 比对
    if (!authInfo.password || authInfo.password !== process.env.PASSWORD) {
      return handleAuthFailure(request, pathname);
    }
    return NextResponse.next();
  }

  // 其他模式：只验证签名
  // 检查是否有用户名（非localStorage模式下密码不存储在cookie中）
  if (!authInfo.username || !authInfo.signature) {
    return handleAuthFailure(request, pathname);
  }

  // 验证签名（如果存在）
  if (authInfo.signature) {
    // 签名密钥优先用独立的 COOKIE_SIGNATURE_KEY。
    // 原因：部分平台（如 EdgeOne）的 env 链路会把 PASSWORD 末尾的 '#' 当注释截断，
    // 导致边缘中间件与 Node API route 拿到的密钥不一致（长度差 1），签名永远校验失败。
    // 站点密码可以继续带 '#'，只要签名密钥本身不含 '#' 等特殊字符。
    const signingSecret =
      process.env.COOKIE_SIGNATURE_KEY || process.env.PASSWORD || '';

    const isValidSignature = await verifySignature(
      authInfo.username,
      authInfo.signature,
      signingSecret
    );

    // 签名验证通过即可
    if (isValidSignature) {
      return NextResponse.next();
    }
  }

  // 签名验证失败或不存在签名
  return handleAuthFailure(request, pathname);
}

// 验证签名
async function verifySignature(
  data: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  try {
    // 导入密钥
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // 将十六进制字符串转换为Uint8Array
    const signatureBuffer = new Uint8Array(
      signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
    );

    // 验证签名
    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBuffer,
      messageData
    );
  } catch (error) {
    console.error('签名验证失败:', error);
    return false;
  }
}

// 处理认证失败的情况
function handleAuthFailure(
  request: NextRequest,
  pathname: string
): NextResponse {
  // 如果是 API 路由，返回 401 状态码
  if (pathname.startsWith('/api')) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // 否则重定向到登录页面
  const loginUrl = new URL('/login', request.url);
  // 保留完整的URL，包括查询参数
  const fullUrl = `${pathname}${request.nextUrl.search}`;
  loginUrl.searchParams.set('redirect', fullUrl);
  return NextResponse.redirect(loginUrl);
}

// 判断是否需要跳过认证的路径
function shouldSkipAuth(pathname: string): boolean {
  const skipPaths = [
    '/_next',
    '/favicon.ico',
    '/robots.txt',
    '/manifest.json',
    '/icons/',
    '/logo.png',
    '/screenshot.png',
    '/login',
    '/warning',
    // Public auth & utility API routes must be reachable without a session.
    // EdgeOne does not honor the `config.matcher` exclusions, so these are
    // handled here explicitly to avoid 401/redirect loops.
    '/api/login',
    '/api/register',
    '/api/logout',
    '/api/cron',
    '/api/server-config',
    // Proxy routes (skip auth for these)
    '/douban-proxy',
    '/api/image-proxy',
    // Standalone Netlify Functions are served outside the Next.js runtime and
    // must be reachable without a session, otherwise <img> requests 307 to /login.
    '/.netlify',

  ];

  return skipPaths.some((path) => pathname.startsWith(path));
}

// 配置middleware匹配规则
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|warning|api/login|api/register|api/logout|api/cron|api/server-config|douban-proxy|api/image-proxy|\\.netlify).*)',
  ],
};
