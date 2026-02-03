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

type StudentOption = {
  value: string;
  label: string;
};

const menuItems = [
  {
    key: "dashboard",
    icon: <DashboardOutlined />,
    label: "Дэшборд",
  },
  {
    key: "cameras",
    icon: <VideoCameraOutlined />,
    label: "Камеры",
  },
  {
    key: "top",
    icon: <TrophyOutlined />,
    label: "Топ негативных",
  },
  {
    key: "by-date",
    icon: <CalendarOutlined />,
    label: "По дате",
  },
];

export default function MainLayout({
  children,
  title,
  locale,
}: Readonly<{
  children: React.ReactNode;
  title: string;
  locale: string;
}>) {
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

  const localizedMenuItems = menuItems.map((item) => ({
    ...item,
    label:
      item.key === "dashboard" ? (
        <Link href={`/${locale}/dashboard`}>{item.label}</Link>
      ) : item.key === "cameras" ? (
        <Link href={`/${locale}/cameras`}>{item.label}</Link>
      ) : item.key === "by-date" ? (
        <Link href={`/${locale}/by-date`}>{item.label}</Link>
      ) : (
        <Link href={`/${locale}/students/top`}>{item.label}</Link>
      ),
  }));

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
          <Text type="secondary">Campus Insight</Text>
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
              router.push(`/${locale}/login`);
            }}
          >
            Выйти
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
            <Text type="secondary">Обновлено: сегодня</Text>
          </div>
          <Space size="middle" wrap>
            <Select
              showSearch
              placeholder="Поиск студента по БД"
              filterOption={false}
              onSearch={handleStudentSearch}
              onSelect={(id) => router.push(`/${locale}/students/${id}`)}
              options={studentOptions}
              loading={searchLoading}
              style={{ width: 240 }}
              allowClear
              notFoundContent={searchLoading ? "Поиск..." : "Ничего не найдено"}
            />
            <LocaleSelect value={locale === "kz" ? "kz" : "ru"} />
          </Space>
        </Header>
        <Content style={{ padding: "12px 24px 32px" }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
