import type { Metadata } from "next";
import { Manrope, Bebas_Neue } from "next/font/google";
import AppProviders from "@/components/providers/AppProviders";

const manrope = Manrope({
  subsets: ["latin", "cyrillic"],
  variable: "--font-sans",
  display: "swap",
});

const bebas = Bebas_Neue({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

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
      <div className={`${manrope.variable} ${bebas.variable} app-shell`}>
        {children}
      </div>
    </AppProviders>
  );
}
