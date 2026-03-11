"use client";

import Link from "next/link";
import { Layout, Menu, Typography, Select, Button, Space } from "antd";
import {
  DashboardOutlined,
  VideoCameraOutlined,
  TrophyOutlined,
  CalendarOutlined,
  UserOutlined,
  LogoutOutlined,
} from "@ant-design/icons";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import LocaleSelect from "@/components/ui/LocaleSelect";

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;

type AppLocale = "ru" | "kz" | "en";

type StudentOption = {
  value: string;
  label: string;
};

const L10N = {
  ru: {
    menu: {
      dashboard: "\u0414\u044d\u0448\u0431\u043e\u0440\u0434",
      cameras: "\u041a\u0430\u043c\u0435\u0440\u044b",
      faces: "\u041b\u0438\u0446\u0430",
      dedup: "\u0416\u0443\u0440\u043d\u0430\u043b \u043c\u0430\u0442\u0447\u0438\u043d\u0433\u0430",
      top: "\u0422\u043e\u043f \u043d\u0435\u0433\u0430\u0442\u0438\u0432\u043d\u044b\u0445",
      byDate: "\u041f\u043e \u0434\u0430\u0442\u0435",
    },
    brandSub: "Campus Insight",
    logout: "\u0412\u044b\u0439\u0442\u0438",
    updatedToday: "\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u043e: \u0441\u0435\u0433\u043e\u0434\u043d\u044f",
    searchPlaceholder: "\u041f\u043e\u0438\u0441\u043a \u0441\u0442\u0443\u0434\u0435\u043d\u0442\u0430",
    searching: "\u041f\u043e\u0438\u0441\u043a...",
    nothingFound: "\u041d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e",
  },
  kz: {
    menu: {
      dashboard: "\u0411\u0430\u0441\u049b\u0430\u0440\u0443 \u043f\u0430\u043d\u0435\u043b\u0456",
      cameras: "\u041a\u0430\u043c\u0435\u0440\u0430\u043b\u0430\u0440",
      faces: "\u0422\u04b1\u043b\u0493\u0430\u043b\u0430\u0440",
      dedup: "\u041c\u0430\u0442\u0447\u0438\u043d\u0433 \u0436\u0443\u0440\u043d\u0430\u043b\u044b",
      top: "\u041d\u0435\u0433\u0430\u0442\u0438\u0432 \u0442\u043e\u043f",
      byDate: "\u041a\u04af\u043d\u0456 \u0431\u043e\u0439\u044b\u043d\u0448\u0430",
    },
    brandSub: "Campus Insight",
    logout: "\u0428\u044b\u0493\u0443",
    updatedToday: "\u0416\u0430\u04a3\u0430\u0440\u0442\u044b\u043b\u0434\u044b: \u0431\u04af\u0433\u0456\u043d",
    searchPlaceholder: "\u0421\u0442\u0443\u0434\u0435\u043d\u0442\u0442\u0456 \u0456\u0437\u0434\u0435\u0443",
    searching: "\u0406\u0437\u0434\u0435\u043b\u0443\u0434\u0435...",
    nothingFound: "\u0415\u0448\u0442\u0435\u04a3\u0435 \u0442\u0430\u0431\u044b\u043b\u043c\u0430\u0434\u044b",
  },
  en: {
    menu: {
      dashboard: "Dashboard",
      cameras: "Cameras",
      faces: "Faces",
      dedup: "Matching Journal",
      top: "Top Negative",
      byDate: "By Date",
    },
    brandSub: "Campus Insight",
    logout: "Log out",
    updatedToday: "Updated: today",
    searchPlaceholder: "Search student",
    searching: "Searching...",
    nothingFound: "Nothing found",
  },
} as const;

export default function MainLayout({
  children,
  title,
  locale,
}: Readonly<{
  children: React.ReactNode;
  title: string;
  locale: string;
}>) {
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];

  const pathname = usePathname();
  const router = useRouter();
  const [searchLoading, setSearchLoading] = useState(false);
  const [studentOptions, setStudentOptions] = useState<StudentOption[]>([]);

  const selectedKey = pathname?.includes("/faces/dedup")
    ? "dedup"
    : pathname?.includes("/students/")
    ? "top"
    : pathname?.includes("/by-date")
      ? "by-date"
      : pathname?.includes("/faces")
        ? "faces"
        : pathname?.includes("/cameras")
          ? "cameras"
          : "dashboard";

  const localizedMenuItems = [
    {
      key: "dashboard",
      icon: <DashboardOutlined />,
      label: <Link href={`/${safeLocale}/dashboard`}>{t.menu.dashboard}</Link>,
    },
    {
      key: "cameras",
      icon: <VideoCameraOutlined />,
      label: <Link href={`/${safeLocale}/cameras`}>{t.menu.cameras}</Link>,
    },
    {
      key: "faces",
      icon: <UserOutlined />,
      label: <Link href={`/${safeLocale}/faces`}>{t.menu.faces}</Link>,
    },
    {
      key: "dedup",
      icon: <UserOutlined />,
      label: <Link href={`/${safeLocale}/faces/dedup`}>{t.menu.dedup}</Link>,
    },
    {
      key: "top",
      icon: <TrophyOutlined />,
      label: <Link href={`/${safeLocale}/students/top`}>{t.menu.top}</Link>,
    },
    {
      key: "by-date",
      icon: <CalendarOutlined />,
      label: <Link href={`/${safeLocale}/by-date`}>{t.menu.byDate}</Link>,
    },
  ];

  async function handleStudentSearch(value: string) {
    const q = value.trim();
    if (!q) {
      setStudentOptions([]);
      return;
    }

    setSearchLoading(true);
    try {
      const response = await fetch(`/api/students?q=${encodeURIComponent(q)}&limit=8`, {
        cache: "no-store",
      });
      if (!response.ok) return;

      const data = await response.json();
      if (!Array.isArray(data.items)) return;

      setStudentOptions(
        data.items.map((item: { id: string; name: string }) => ({
          value: item.id,
          label: item.name,
        })),
      );
    } finally {
      setSearchLoading(false);
    }
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        width={240}
        theme="light"
        style={{
          background: "rgba(255,255,255,0.9)",
          borderRight: "1px solid #e2e8f0",
          padding: "24px 12px",
        }}
      >
        <div style={{ padding: "0 12px 24px" }}>
          <Title level={4} style={{ margin: 0 }}>
            Mood Checker
          </Title>
          <Text type="secondary">{t.brandSub}</Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={localizedMenuItems}
          style={{ background: "transparent", border: "none" }}
        />
        <div style={{ marginTop: "auto", padding: "24px 12px" }}>
          <Button
            icon={<LogoutOutlined />}
            block
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              router.push(`/${safeLocale}/login`);
            }}
          >
            {t.logout}
          </Button>
        </div>
      </Sider>
      <Layout>
        <Header
          style={{
            background: "transparent",
            padding: "20px 24px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            height: "auto",
            lineHeight: "normal",
          }}
        >
          <div>
            <Title level={3} style={{ margin: 0 }}>
              {title}
            </Title>
            <Text type="secondary">{t.updatedToday}</Text>
          </div>
          <Space size="middle" wrap>
            <Select
              showSearch
              placeholder={t.searchPlaceholder}
              filterOption={false}
              onSearch={handleStudentSearch}
              onSelect={(id) => router.push(`/${safeLocale}/students/${encodeURIComponent(id)}`)}
              options={studentOptions}
              loading={searchLoading}
              style={{ width: 240 }}
              allowClear
              notFoundContent={searchLoading ? t.searching : t.nothingFound}
            />
            <LocaleSelect value={safeLocale} />
          </Space>
        </Header>
        <Content style={{ padding: "12px 24px 32px" }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
