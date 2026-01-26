"use client";

import Link from "next/link";
import { Layout, Menu, Typography, Input, Select, Button, Space } from "antd";
import {
  DashboardOutlined,
  VideoCameraOutlined,
  TrophyOutlined,
  UserOutlined,
  SearchOutlined,
  LogoutOutlined,
} from "@ant-design/icons";
import { usePathname } from "next/navigation";
import LocaleSelect from "@/components/ui/LocaleSelect";

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;

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
    key: "student",
    icon: <UserOutlined />,
    label: "Студент",
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
  const selectedKey =
    pathname?.includes("/students/top")
      ? "top"
      : pathname?.includes("/students/")
        ? "student"
        : "dashboard";

  const localizedMenuItems = menuItems.map((item) => ({
    ...item,
    label:
      item.key === "dashboard" || item.key === "cameras" ? (
        <Link href={`/${locale}/dashboard`}>{item.label}</Link>
      ) : item.key === "top" ? (
        <Link href={`/${locale}/students/top`}>{item.label}</Link>
      ) : (
        <Link href={`/${locale}/students/123`}>{item.label}</Link>
      ),
  }));

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
          <Button icon={<LogoutOutlined />} block>
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
            <Input
              placeholder="Поиск студента"
              prefix={<SearchOutlined />}
              style={{ width: 220 }}
            />
            <Select
              defaultValue="7d"
              options={[
                { label: "Сегодня", value: "1d" },
                { label: "7 дней", value: "7d" },
                { label: "30 дней", value: "30d" },
              ]}
              style={{ width: 140 }}
            />
            <LocaleSelect value={locale === "kz" ? "kz" : "ru"} />
          </Space>
        </Header>
        <Content style={{ padding: "12px 24px 32px" }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
