import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./brand.css";
import "./startup-splash.css";
import "./api-scenarios.css";

export const metadata: Metadata = {
  title: "NEXUS — Monitor. Teste. Automatize. Resolva.",
  description: "Monitore APIs, valide cenários, automatize verificações e resolva incidentes.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
