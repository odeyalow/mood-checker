"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Form, Input, Typography, Divider, Space } from "antd";
import { EyeInvisibleOutlined, EyeOutlined, LoginOutlined, LockOutlined, UserOutlined } from "@ant-design/icons";
import LocaleSelect from "@/components/ui/LocaleSelect";

const { Title, Text } = Typography;

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    heroTitle: "Пульс настроений аудитории",
    heroText:
      "Отслеживайте эмоциональный фон студентов, фиксируйте колебания и вовремя реагируйте на тревожные сигналы.",
    camerasOnline: "Камеры онлайн",
    todayNegative: "Негатив за сегодня",
    welcome: "Добро пожаловать",
    signIn: "Вход в систему",
    login: "Логин",
    password: "Пароль",
    enterLogin: "Введите логин",
    enterPassword: "Введите пароль",
    loginRequired: "Введите логин",
    passwordRequired: "Введите пароль",
    loginButton: "Войти",
    invalidCredentials: "Неверный логин или пароль.",
    connectionError: "Ошибка соединения. Повторите попытку.",
  },
  kz: {
    heroTitle: "Аудитория көңіл-күй пульсі",
    heroText:
      "Студенттердің эмоциялық фонын бақылап, өзгерістерді тіркеп, алаңдататын сигналдарға дер кезінде әрекет етіңіз.",
    camerasOnline: "Камералар онлайн",
    todayNegative: "Бүгінгі негатив",
    welcome: "Қош келдіңіз",
    signIn: "Жүйеге кіру",
    login: "Логин",
    password: "Құпиясөз",
    enterLogin: "Логинді енгізіңіз",
    enterPassword: "Құпиясөзді енгізіңіз",
    loginRequired: "Логинді енгізіңіз",
    passwordRequired: "Құпиясөзді енгізіңіз",
    loginButton: "Кіру",
    invalidCredentials: "Логин немесе құпиясөз қате.",
    connectionError: "Байланыс қатесі. Қайталап көріңіз.",
  },
  en: {
    heroTitle: "Audience Mood Pulse",
    heroText:
      "Track students' emotional background, capture shifts, and react to alarming signals in time.",
    camerasOnline: "Cameras online",
    todayNegative: "Negative today",
    welcome: "Welcome",
    signIn: "Sign in",
    login: "Login",
    password: "Password",
    enterLogin: "Enter login",
    enterPassword: "Enter password",
    loginRequired: "Enter login",
    passwordRequired: "Enter password",
    loginButton: "Sign in",
    invalidCredentials: "Invalid login or password.",
    connectionError: "Connection error. Please try again.",
  },
} as const;

export default function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];

  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    async function checkAuth() {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (response.ok && active) {
          router.replace(`/${safeLocale}/dashboard`);
          return;
        }
      } catch {
        // ignore
      } finally {
        if (active) setChecking(false);
      }
    }
    void checkAuth();
    return () => {
      active = false;
    };
  }, [router, safeLocale]);

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
        setError(t.invalidCredentials);
        return;
      }

      router.push(`/${safeLocale}/dashboard`);
    } catch {
      setError(t.connectionError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-split">
      <section className="auth-hero">
        <div>
          <Text style={{ color: "rgba(248,250,252,0.85)" }}>Mood Checker Platform</Text>
          <h1 className="page-title">{t.heroTitle}</h1>
          <p style={{ fontSize: 16, maxWidth: 420 }}>{t.heroText}</p>
        </div>
        <div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div>
              <Text style={{ color: "rgba(248,250,252,0.75)" }}>{t.camerasOnline}</Text>
              <Title level={2} style={{ color: "#fff", margin: 0 }}>
                12
              </Title>
            </div>
            <div>
              <Text style={{ color: "rgba(248,250,252,0.75)" }}>{t.todayNegative}</Text>
              <Title level={2} style={{ color: "#fff", margin: 0 }}>
                18%
              </Title>
            </div>
          </div>
        </div>
      </section>

      <section className="auth-card">
        <Space direction="vertical" size={12}>
          <Text type="secondary">{t.welcome}</Text>
          <Title level={3} style={{ margin: 0 }}>
            {t.signIn}
          </Title>
        </Space>

        <Form layout="vertical" onFinish={handleSubmit}>
          <Form.Item label={t.login} name="login" rules={[{ required: true, message: t.loginRequired }]}>
            <Input prefix={<UserOutlined />} placeholder={t.enterLogin} />
          </Form.Item>
          <Form.Item
            label={t.password}
            name="password"
            rules={[{ required: true, message: t.passwordRequired }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder={t.enterPassword}
              iconRender={(visible) => (visible ? <EyeOutlined /> : <EyeInvisibleOutlined />)}
            />
          </Form.Item>
          {error ? (
            <Text type="danger" style={{ display: "block", marginBottom: 8 }}>
              {error}
            </Text>
          ) : null}
          <Button type="primary" icon={<LoginOutlined />} block htmlType="submit" loading={submitting || checking}>
            {t.loginButton}
          </Button>
        </Form>

        <Divider />
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <LocaleSelect size="large" value={safeLocale} />
        </Space>
      </section>
    </div>
  );
}
