export const metadata = {
  title: "Interactive demo",
  description:
    "Sign in with any credentials, then explore a sample WireGuard Console: peers, servers, departments, security rules, backups, configuration and profile.",
  alternates: { canonical: "/demo" },
  robots: { index: false, follow: true },
};

export default function DemoLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div id="main" tabIndex={-1} className="min-h-[100dvh]">
      {children}
    </div>
  );
}