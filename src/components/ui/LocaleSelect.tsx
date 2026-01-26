"use client";

import { Select } from "antd";

export default function LocaleSelect({
  size = "middle",
  value = "ru",
}: Readonly<{
  size?: "large" | "middle" | "small";
  value?: "ru" | "kz";
}>) {
  return (
    <Select
      size={size}
      defaultValue={value}
      options={[
        { label: "Русский", value: "ru" },
        { label: "Қазақша", value: "kz" },
      ]}
      style={{ width: 140 }}
    />
  );
}
