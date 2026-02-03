"use client";

import { Select } from "antd";
import { usePathname, useRouter } from "next/navigation";

type AppLocale = "ru" | "kz" | "en";

export default function LocaleSelect({
  size = "middle",
  value = "ru",
}: Readonly<{
  size?: "large" | "middle" | "small";
  value?: AppLocale;
}>) {
  const router = useRouter();
  const pathname = usePathname();

  function switchLocale(nextLocale: AppLocale) {
    if (!pathname) return;
    const segments = pathname.split("/");
    if (segments.length > 1 && (segments[1] === "ru" || segments[1] === "kz" || segments[1] === "en")) {
      segments[1] = nextLocale;
      router.push(segments.join("/") || "/");
      return;
    }
    router.push(`/${nextLocale}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  }

  return (
    <Select<AppLocale>
      size={size}
      value={value}
      onChange={switchLocale}
      options={[
        { label: "Русский", value: "ru" },
        { label: "Қазақша", value: "kz" },
        { label: "English", value: "en" },
      ]}
      style={{ width: 140 }}
    />
  );
}
