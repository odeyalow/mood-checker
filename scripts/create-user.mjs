import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function readArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const login = readArg("login");
const password = readArg("password");

if (!login || !password) {
  console.error("Usage: npm run create-user -- --login <login> --password <password>");
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 10);

try {
  const user = await prisma.user.create({
    data: { login, passwordHash },
  });
  console.log(`User created: ${user.login}`);
} catch (error) {
  console.error("Failed to create user:", error.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
