import type { Metadata } from "next";
import AppProviders from "@/components/providers/AppProviders";

export const metadata: Metadata = {
  title: "Mood Checker",
  description: "Student mood monitoring dashboard",
};

export default function LocaleLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AppProviders>
      <div className="app-shell">{children}</div>
    </AppProviders>
  );
}
