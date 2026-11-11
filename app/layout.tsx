import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GALIA Control",
  description: "Contrôle des boîtes de coiffes : étiquette GALIA, coiffes, résultat OK / NON OK.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
