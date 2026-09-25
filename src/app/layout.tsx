import type { Metadata } from "next";
import { Geist, Geist_Mono, Bebas_Neue } from "next/font/google";
import { TRPCProvider } from "@/lib/trpc/provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Cinema-marquee display face for the Hollywood-style hero + headings.
const displayFont = Bebas_Neue({
  variable: "--display-font",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "MEDIA HUB — We Produce Your Social Presence",
  description:
    "MEDIA HUB is the media agency that automates every social platform — Instagram intelligence, Facebook intelligence, and full media automation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${displayFont.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <TRPCProvider>
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </TRPCProvider>
      </body>
    </html>
  );
}
