import type { Metadata } from "next";
import { TRPCProvider } from "@/lib/trpc/provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

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
      className="h-full antialiased"
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
