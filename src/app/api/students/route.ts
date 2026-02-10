import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "node:fs/promises";
import path from "node:path";

type StudentItem = { id: string; name: string };

function toNameFromFile(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, "").trim();
}

function dedupeByLowercase(list: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of list) {
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;

  const [recognizedNames, knownList] = await Promise.all([
    prisma.recognition.findMany({
      distinct: ["name"],
      select: { name: true },
      orderBy: { name: "asc" },
    }),
    (async () => {
      try {
        const knownListFile =
          process.env.WORKER_KNOWN_LIST_FILE || path.join(process.cwd(), "public", "known", "images.json");
        const raw = await fs.readFile(knownListFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [] as string[];
        return parsed
          .map((item) => toNameFromFile(String(item ?? "").trim()))
          .filter(Boolean);
      } catch {
        return [] as string[];
      }
    })(),
  ]);

  const allNames = dedupeByLowercase([
    ...knownList,
    ...recognizedNames.map((item) => String(item.name ?? "").trim()).filter(Boolean),
  ]);

  const filtered = q
    ? allNames.filter((name) => name.toLocaleLowerCase().includes(q))
    : allNames;

  const items: StudentItem[] = filtered.slice(0, limit).map((name) => ({
    id: name,
    name,
  }));

  return NextResponse.json({
    items,
    students: items,
  });
}
