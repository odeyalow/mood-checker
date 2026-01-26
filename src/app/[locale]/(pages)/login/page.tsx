"use client";

import { use } from "react";
import Link from "next/link";
import { Button, Form, Input, Typography, Divider, Space } from "antd";
import {
  EyeInvisibleOutlined,
  EyeOutlined,
  LoginOutlined,
  LockOutlined,
  UserOutlined,
} from "@ant-design/icons";
import LocaleSelect from "@/components/ui/LocaleSelect";

const { Title, Text } = Typography;

export default function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  return (
    <div className="auth-split">
      <section className="auth-hero">
        <div>
          <Text style={{ color: "rgba(248,250,252,0.85)" }}>
            Mood Checker Platform
          </Text>
          <h1 className="page-title">Пульс настроений аудитории</h1>
          <p style={{ fontSize: 16, maxWidth: 420 }}>
            Отслеживайте эмоциональный фон студентов, фиксируйте колебания и
            вовремя реагируйте на тревожные сигналы.
          </p>
        </div>
        <div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div>
              <Text style={{ color: "rgba(248,250,252,0.75)" }}>
                Камеры онлайн
              </Text>
              <Title level={2} style={{ color: "#fff", margin: 0 }}>
                12
              </Title>
            </div>
            <div>
              <Text style={{ color: "rgba(248,250,252,0.75)" }}>
                Негатив за сегодня
              </Text>
              <Title level={2} style={{ color: "#fff", margin: 0 }}>
                18%
              </Title>
            </div>
          </div>
        </div>
      </section>

      <section className="auth-card">
        <Space orientation="vertical" size={12}>
          <Text type="secondary">Добро пожаловать</Text>
          <Title level={3} style={{ margin: 0 }}>
            Вход в систему
          </Title>
        </Space>

        <Form layout="vertical">
          <Form.Item label="Логин">
            <Input prefix={<UserOutlined />} placeholder="Введите логин" />
          </Form.Item>
          <Form.Item label="Пароль">
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Введите пароль"
              iconRender={(visible) =>
                visible ? <EyeOutlined /> : <EyeInvisibleOutlined />
              }
            />
          </Form.Item>
          <Button type="primary" icon={<LoginOutlined />} block>
            Войти
          </Button>
        </Form>

        <Divider />
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <LocaleSelect size="large" value={locale === "kz" ? "kz" : "ru"} />
          <Link href={`/${locale}/dashboard`}>Перейти в демо</Link>
        </Space>
      </section>
    </div>
  );
}
