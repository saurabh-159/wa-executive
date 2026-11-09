import { Inter, Newsreader } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { ToastProvider } from "@/components/ui/ToastProvider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
});

export const metadata = {
  title: "Perisclaw Executive AI",
  description: "WhatsApp executive desk for commitments, deadlines, and contact intelligence.",
};

export const viewport = {
  themeColor: "#F1F3F5",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable} h-full`}>
      <body
        suppressHydrationWarning
        className={`${inter.className} h-full overflow-hidden bg-[#F1F3F5] text-slate-900 antialiased`}
      >
        <ToastProvider>
          <AuthGuard>
            <AppShell>{children}</AppShell>
          </AuthGuard>
        </ToastProvider>
      </body>
    </html>
  );
}