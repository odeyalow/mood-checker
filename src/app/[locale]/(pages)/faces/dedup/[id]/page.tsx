import { redirect } from "next/navigation";

export default async function LegacyDedupDetailsRedirect({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const safeLocale = locale === "kz" || locale === "en" || locale === "ru" ? locale : "ru";
  redirect(`/${safeLocale}/matching-journal/${encodeURIComponent(id)}`);
}

