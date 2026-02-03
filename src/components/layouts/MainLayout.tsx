"use client";

import Link from "next/link";
import { Layout, Menu, Typography, Select, Button, Space } from "antd";
import {
  DashboardOutlined,
  VideoCameraOutlined,
  TrophyOutlined,
  CalendarOutlined,
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
      dashboard: "Дэшборд",
      cameras: "Камеры",
      top: "Топ негативных",
      byDate: "По дате",
    },
    brandSub: "Campus Insight",
    logout: "Выйти",
    updatedToday: "Обновлено: сегодня",
    searchPlaceholder: "Поиск студента",
    searching: "Поиск...",
    nothingFound: "Ничего не найдено",
  },
  kz: {
    menu: {
      dashboard: "Басқару панелі",
      cameras: "Камералар",
      top: "Негатив топ",
      byDate: "Күні бойынша",
    },
    brandSub: "Campus Insight",
    logout: "Шығу",
    updatedToday: "Жаңартылды: бүгін",
    searchPlaceholder: "Студентті іздеу",
    searching: "Ізделуде...",
    nothingFound: "Ештеңе табылмады",
  },
  en: {
    menu: {
      dashboard: "Dashboard",
      cameras: "Cameras",
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

  const selectedKey = pathname?.includes("/students/")
    ? "top"
    : pathname?.includes("/by-date")
      ? "by-date"
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
        }))
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
              onSelect={(id) => router.push(`/${safeLocale}/students/${id}`)}
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
