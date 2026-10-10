import { useEffect, useState } from "react";
import { Alert, Card, Layout, Spin, Typography } from "antd";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type Health = {
  status: string;
  service: string;
};

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiUrl}/api/health`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        return (await response.json()) as Health;
      })
      .then(setHealth)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "API unavailable");
      });
  }, []);

  return (
    <Layout className="app-layout">
      <main className="content">
        <Typography.Text className="eyebrow">REGCHECK UZ</Typography.Text>
        <Typography.Title level={1}>Application foundation</Typography.Title>
        <Typography.Paragraph className="intro">
          Frontend and API starter are running. Product workflows will be added
          in a later step.
        </Typography.Paragraph>

        <Card title="Backend connection" className="status-card">
          {health ? (
            <Alert
              type="success"
              showIcon
              message={`${health.service} is ${health.status}`}
            />
          ) : error ? (
            <Alert type="error" showIcon message="API connection failed" description={error} />
          ) : (
            <Spin />
          )}
        </Card>
      </main>
    </Layout>
  );
}
