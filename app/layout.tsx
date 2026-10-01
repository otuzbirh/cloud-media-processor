import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cloud Media Processor",
  description: "Batch obrada i optimizacija fotografija sa skalabilnim workerima.",
  other: {
    "application-name": "Cloud Media Processor",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="bs">
      <body className="antialiased">{children}</body>
    </html>
  );
}
