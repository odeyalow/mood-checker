"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    async function checkAuth() {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (response.ok) {
          if (active) {
            router.replace(`/${locale}/dashboard`);
          }
          return;
        }
      } catch {
        // ignore
      } finally {
        if (active) {
          setChecking(false);
        }
      }
    }
    checkAuth();
    return () => {
      active = false;
    };
  }, [locale, router]);

  async function handleSubmit(values: { login: string; password: string }) {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (!response.ok) {
        setError("Неверный логин или пароль.");
        return;
      }

      router.push(`/${locale}/dashboard`);
    } catch {
      setError("Ошибка соединения. Повторите попытку.");
    } finally {
      setSubmitting(false);
    }
  }
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

        <Form layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            label="Логин"
            name="login"
            rules={[{ required: true, message: "Введите логин" }]}
          >
            <Input prefix={<UserOutlined />} placeholder="Введите логин" />
          </Form.Item>
          <Form.Item
            label="Пароль"
            name="password"
            rules={[{ required: true, message: "Введите пароль" }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Введите пароль"
              iconRender={(visible) =>
                visible ? <EyeOutlined /> : <EyeInvisibleOutlined />
              }
            />
          </Form.Item>
          {error ? (
            <Text type="danger" style={{ display: "block", marginBottom: 8 }}>
              {error}
            </Text>
          ) : null}
          <Button
            type="primary"
            icon={<LoginOutlined />}
            block
            htmlType="submit"
            loading={submitting || checking}
          >
            Войти
          </Button>
        </Form>

        <Divider />
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <LocaleSelect size="large" value={locale === "kz" ? "kz" : "ru"} />
=        </Space>
      </section>
    </div>
  );
}
