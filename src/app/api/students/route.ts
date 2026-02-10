import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const items = await prisma.recognition.findMany({
    distinct: ["name"],
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({
    students: items.map((item) => ({ id: item.name, name: item.name })),
  });
}
