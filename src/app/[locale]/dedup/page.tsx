import { redirect } from "next/navigation";

export default async function DedupAliasPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const safeLocale = locale === "kz" || locale === "en" || locale === "ru" ? locale : "ru";
  redirect(`/${safeLocale}/matching-journal`);
}
