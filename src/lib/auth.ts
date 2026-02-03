import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";

const secret = process.env.AUTH_SECRET;
if (!secret) {
  throw new Error("AUTH_SECRET is not set");
}

const secretKey = new TextEncoder().encode(secret);

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function signAuthToken(payload: { sub: string; login: string }) {
  return new SignJWT({ login: payload.login })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secretKey);
}

export async function verifyAuthToken(token: string) {
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ["HS256"],
  });
  return payload;
}
