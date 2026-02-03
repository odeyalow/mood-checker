import { NextResponse } from "next/server";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { studentIdFromName } from "@/lib/students";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 50);
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

async function loadKnownStudents() {
  const knownDir = path.join(process.cwd(), "public", "known");
  const entries = await readdir(knownDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name))
    .map((name) => name.replace(/\.[^/.]+$/, ""));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();
  const qNormalized = normalizeName(q);
  const limit = parseLimit(searchParams.get("limit"), 10);

  const [rows, knownStudents] = await Promise.all([
    prisma.recognition.findMany({
      orderBy: { detectedAt: "desc" },
      distinct: ["name"],
      take: 300,
      select: {
        name: true,
        detectedAt: true,
      },
    }),
    loadKnownStudents().catch(() => []),
  ]);

  const byName = new Map<string, { name: string; lastDetectedAt: Date | null }>();

  for (const row of rows) {
    if (!byName.has(row.name)) {
      byName.set(row.name, { name: row.name, lastDetectedAt: row.detectedAt });
    }
  }

  for (const name of knownStudents) {
    if (!byName.has(name)) {
      byName.set(name, { name, lastDetectedAt: null });
    }
  }

  const items = Array.from(byName.values())
    .filter((row) => !qNormalized || normalizeName(row.name).includes(qNormalized))
    .sort((a, b) => {
      if (a.lastDetectedAt && b.lastDetectedAt) {
        return b.lastDetectedAt.getTime() - a.lastDetectedAt.getTime();
      }
      if (a.lastDetectedAt) return -1;
      if (b.lastDetectedAt) return 1;
      return a.name.localeCompare(b.name, "ru");
    })
    .slice(0, limit)
    .map((row) => ({
      id: studentIdFromName(row.name),
      name: row.name,
      totalRecognitions: 0,
      lastDetectedAt: row.lastDetectedAt?.toISOString() ?? null,
    }));

  return NextResponse.json({ items });
}
