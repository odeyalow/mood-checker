import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signAuthToken, verifyPassword } from "@/lib/auth";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const login = typeof body?.login === "string" ? body.login.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!login || !password) {
    return NextResponse.json(
      { error: "login_and_password_required" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { login } });
  if (!user) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const token = await signAuthToken({ sub: user.id, login: user.login });
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const isHttps =
    forwardedProto === "https" || new URL(request.url).protocol === "https:";
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const response = NextResponse.json({ ok: true, login: user.login });
  response.cookies.set("mc_auth", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: forceSecureCookie || isHttps,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}
