import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { verifyAuthToken } from "@/lib/auth";

export default async function LocaleIndex({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const cookieStore = await cookies();
  const token = cookieStore.get("mc_auth")?.value;

  if (token) {
    try {
      await verifyAuthToken(token);
      redirect(`/${locale}/dashboard`);
    } catch {
      // fall through to login
    }
  }

  redirect(`/${locale}/login`);
}
