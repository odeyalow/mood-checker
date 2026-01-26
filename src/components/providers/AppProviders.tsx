"use client";

import { ConfigProvider, theme } from "antd";

export default function AppProviders({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#3B6EF5",
          borderRadius: 12,
          fontFamily: "var(--font-sans)",
          colorBgLayout: "#F4F6FB",
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
