"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Shield, Eye, EyeOff, Save, CheckCircle2, XCircle, Loader2, Copy,
  ChevronDown, ChevronRight, HelpCircle,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

// ─── Real brand logos (filled SVGs matching official branding) ───

const InstagramLogo = () => (
  <svg className="h-11 w-11" viewBox="0 0 24 24" fill="url(#ig-gradient)">
    <defs>
      <radialGradient id="ig-gradient" cx="30%" cy="107%" r="150%">
        <stop offset="0%" stopColor="#fdf497" />
        <stop offset="5%" stopColor="#fdf497" />
        <stop offset="45%" stopColor="#fd5949" />
        <stop offset="60%" stopColor="#d6249f" />
        <stop offset="90%" stopColor="#285AEB" />
      </radialGradient>
    </defs>
    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
  </svg>
);

const YouTubeLogo = () => (
  <svg className="h-11 w-11" viewBox="0 0 24 24" fill="#FF0000">
    <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
  </svg>
);

const GoogleDriveLogo = () => (
  <svg className="h-11 w-11" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
    <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
    <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-20.4 35.3c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/>
    <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
    <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
    <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
    <path d="m73.4 26.5-10.1-17.5c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 23.8h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
  </svg>
);

const LinkedInLogo = () => (
  <svg className="h-11 w-11" viewBox="0 0 24 24" fill="#0A66C2">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
);

const GmailLogo = () => (
  <svg className="h-11 w-11" viewBox="52 42 88 66" xmlns="http://www.w3.org/2000/svg">
    <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6"/>
    <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15"/>
    <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2"/>
    <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92"/>
    <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.46-14.4-.22-14.4 7.2"/>
  </svg>
);

// ─── Platform configs ───

interface PlatformConfig {
  platform: string;
  label: string;
  shortLabel: string;
  icon: React.ReactNode;
  fields: { key: string; label: string; type: "id" | "secret" }[];
  showRedirectUri: boolean;
  callbackPath?: string;
  description?: string;
  extraFields?: { key: string; label: string; placeholder: string; defaultValue: string; options?: { value: string; label: string }[] }[];
  setupGuide: string[];
}

const platforms: PlatformConfig[] = [
  {
    platform: "instagram",
    label: "Instagram / Meta",
    shortLabel: "Instagram",
    icon: <InstagramLogo />,
    fields: [
      { key: "client_id", label: "Facebook App ID", type: "id" },
      { key: "client_secret", label: "Facebook App Secret", type: "secret" },
    ],
    showRedirectUri: true,
    callbackPath: "/api/callback/instagram",
    setupGuide: [
      "Go to developers.facebook.com and log in",
      "Click 'My Apps' → 'Create App' → select 'Business' type",
      "In App Dashboard → 'App Settings' → 'Basic' — copy App ID and App Secret",
      "Add products: 'Instagram Basic Display' and 'Instagram Graph API'",
      "In 'Instagram Basic Display' → Settings → add the Redirect URI shown below",
      "Go to 'App Review' → request: instagram_basic, instagram_content_publish, instagram_manage_insights, pages_show_list",
      "Users must have a Business/Creator Instagram account connected to a Facebook Page",
    ],
  },
  {
    platform: "youtube",
    label: "YouTube",
    shortLabel: "YouTube",
    icon: <YouTubeLogo />,
    fields: [
      { key: "client_id", label: "Google Client ID", type: "id" },
      { key: "client_secret", label: "Google Client Secret", type: "secret" },
    ],
    showRedirectUri: true,
    callbackPath: "/api/callback/youtube",
    setupGuide: [
      "Go to console.cloud.google.com → create project (or select existing)",
      "IMPORTANT: Go to 'APIs & Services' → 'Library' → search 'YouTube Data API v3' → click Enable. Without this, publishing to YouTube will fail.",
      "Go to 'Credentials' → 'Create Credentials' → 'OAuth Client ID' → 'Web application'",
      "Add the Redirect URI shown below to 'Authorized redirect URIs'",
      "Copy Client ID and Client Secret — paste them here",
      "Go to 'OAuth consent screen' → set to External → add app name and email",
      "Click 'Publish App' so any user can connect (not just test users)",
    ],
  },
  {
    platform: "google_drive",
    label: "Google Drive",
    shortLabel: "Drive",
    icon: <GoogleDriveLogo />,
    fields: [
      { key: "client_id", label: "Google Client ID", type: "id" },
      { key: "client_secret", label: "Google Client Secret", type: "secret" },
    ],
    showRedirectUri: true,
    callbackPath: "/api/callback/google-drive",
    description: "Same Google Cloud project as YouTube — just add the Drive redirect URI",
    setupGuide: [
      "Use the same Google Cloud project as YouTube",
      "IMPORTANT: Go to 'APIs & Services' → 'Library' → search 'Google Drive API' → click Enable. Without this, Drive connections will fail.",
      "Go to Credentials → click your existing OAuth Client",
      "Add the Redirect URI shown below (this is different from YouTube's redirect URI — both must be added)",
      "Client ID and Secret are the same as YouTube if using the same project",
    ],
  },
  {
    platform: "linkedin",
    label: "LinkedIn",
    shortLabel: "LinkedIn",
    icon: <LinkedInLogo />,
    fields: [
      { key: "client_id", label: "LinkedIn Client ID", type: "id" },
      { key: "client_secret", label: "LinkedIn Client Secret", type: "secret" },
    ],
    showRedirectUri: true,
    callbackPath: "/api/callback/linkedin",
    setupGuide: [
      "Go to developer.linkedin.com → 'Create App'",
      "Fill in app name, LinkedIn Page, logo",
      "Go to 'Auth' tab → copy Client ID and Primary Client Secret",
      "Add the Redirect URI shown below to 'Authorized redirect URLs'",
      "Go to 'Products' → request 'Share on LinkedIn' and 'Sign In with LinkedIn using OpenID Connect'",
    ],
  },
  {
    platform: "facebook",
    label: "Facebook",
    shortLabel: "Facebook",
    icon: <svg className="h-11 w-11" viewBox="0 0 24 24" fill="#1877F2"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"/></svg>,
    fields: [
      { key: "client_id", label: "Facebook App ID", type: "id" },
      { key: "client_secret", label: "Facebook App Secret", type: "secret" },
    ],
    showRedirectUri: true,
    callbackPath: "/api/callback/facebook",
    description: "Publish posts, reels, and stories to Facebook Pages",
    setupGuide: [
      "Go to developers.facebook.com and create a new app (Business type)",
      "In App Dashboard → Settings → Basic → copy App ID and App Secret",
      "Add 'Facebook Login' product to your app",
      "In Facebook Login → Settings → add the Redirect URI shown below",
      "Request permissions: pages_manage_posts, pages_read_engagement, pages_show_list",
    ],
  },
  {
    platform: "tiktok",
    label: "TikTok",
    shortLabel: "TikTok",
    icon: <svg className="h-11 w-11" viewBox="0 0 24 24" fill="#000000"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>,
    fields: [
      { key: "client_id", label: "Client Key", type: "id" },
      { key: "client_secret", label: "Client Secret", type: "secret" },
    ],
    showRedirectUri: true,
    callbackPath: "/api/callback/tiktok",
    description: "Publish videos to TikTok — requires TikTok for Developers account",
    setupGuide: [
      "Go to developers.tiktok.com and create a developer account",
      "Create a new app in the TikTok Developer Portal",
      "Add 'Login Kit' and 'Content Posting API' products",
      "Copy Client Key and Client Secret from your app settings",
      "Add the Redirect URI shown below to your app's redirect URLs",
      "Request scopes: user.info.basic, video.publish, video.upload",
    ],
  },
  {
    platform: "twitter",
    label: "X (Twitter)",
    shortLabel: "X",
    icon: <svg className="h-11 w-11" viewBox="0 0 24 24" fill="#000000"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>,
    fields: [
      { key: "client_id", label: "API Key", type: "id" },
      { key: "client_secret", label: "API Secret", type: "secret" },
    ],
    showRedirectUri: true,
    callbackPath: "/api/callback/twitter",
    description: "Post tweets with images and videos to X (Twitter)",
    setupGuide: [
      "Go to developer.x.com and sign up for a developer account",
      "Create a new project and app",
      "In your app settings → Keys and Tokens → copy API Key and API Secret",
      "Enable OAuth 2.0 in User Authentication settings",
      "Add the Redirect URI shown below",
      "Request scopes: tweet.read, tweet.write, users.read, offline.access",
    ],
  },
  {
    platform: "snapchat",
    label: "Snapchat",
    shortLabel: "Snapchat",
    icon: <svg className="h-11 w-11" viewBox="0 0 24 24"><path d="M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06" fill="#FFFC00" stroke="#000000" strokeWidth="0.5"/></svg>,
    fields: [
      { key: "client_id", label: "Client ID", type: "id" },
      { key: "client_secret", label: "Client Secret", type: "secret" },
    ],
    showRedirectUri: true,
    callbackPath: "/api/callback/snapchat",
    description: "Share content to Snapchat Stories",
    setupGuide: [
      "Go to kit.snapchat.com and create a developer account",
      "Create a new Snap Kit app",
      "Enable 'Login Kit' and 'Creative Kit'",
      "Copy Client ID and Client Secret",
      "Add the Redirect URI shown below",
      "Request scopes: snapchat-marketing-api",
    ],
  },
  {
    platform: "email_smtp",
    label: "Email (Gmail)",
    shortLabel: "Email",
    icon: <GmailLogo />,
    fields: [
      { key: "client_id", label: "Gmail Address", type: "id" },
      { key: "client_secret", label: "App Password", type: "secret" },
    ],
    showRedirectUri: false,
    description: "Send invitations and notifications from your Gmail",
    extraFields: [
      { key: "from_name", label: "From Name", placeholder: "MediaHub", defaultValue: "MediaHub" },
      { key: "smtp_host", label: "SMTP Host", placeholder: "smtp.gmail.com", defaultValue: "smtp.gmail.com" },
      { key: "smtp_port", label: "SMTP Port", placeholder: "587", defaultValue: "587" },
    ],
    setupGuide: [
      "Go to myaccount.google.com → Security → turn ON '2-Step Verification'",
      "Go to myaccount.google.com/apppasswords",
      "Select 'Other' → name it 'MediaHub' → click 'Generate'",
      "Copy the 16-character password WITHOUT spaces",
      "Paste it in 'App Password' here, enter your Gmail, Save then Test",
    ],
  },
  // ─── LLM Providers ───
  {
    platform: "llm_openrouter",
    label: "OpenRouter",
    shortLabel: "OpenRouter",
    icon: <svg className="h-11 w-11" viewBox="0 0 24 24" fill="#6366f1" xmlns="http://www.w3.org/2000/svg"><path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" /></svg>,
    fields: [
      { key: "client_id", label: "API Key", type: "id" as const },
    ],
    showRedirectUri: false,
    description: "Access 300+ models via a single API key — recommended for flexibility and cost control",
    extraFields: [
      { key: "default_model", label: "Default Model", placeholder: "anthropic/claude-sonnet-4-6", defaultValue: "anthropic/claude-sonnet-4-6", options: [
        { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (recommended)" },
        { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest Claude)" },
        { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
        { value: "deepseek/deepseek-chat-v3", label: "DeepSeek V3 (cheapest)" },
        { value: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick (open source)" },
      ]},
    ],
    setupGuide: [
      "Go to openrouter.ai and sign up or log in",
      "Navigate to Keys → Create Key",
      "Copy the key (starts with sk-or-...)",
      "Paste it here as the API Key",
      "Choose a default model — Claude Sonnet 4.6 is recommended",
    ],
  },
  {
    platform: "llm_anthropic",
    label: "Anthropic (Claude)",
    shortLabel: "Anthropic",
    icon: <svg className="h-11 w-11" viewBox="0 0 24 24" fill="#D97757" xmlns="http://www.w3.org/2000/svg"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" /></svg>,
    fields: [
      { key: "client_id", label: "API Key", type: "id" as const },
    ],
    showRedirectUri: false,
    description: "Direct access to Claude models — best quality for complex reasoning and coding tasks",
    extraFields: [
      { key: "default_model", label: "Default Model", placeholder: "claude-sonnet-4-6-20250514", defaultValue: "claude-sonnet-4-6-20250514", options: [
        { value: "claude-sonnet-4-6-20250514", label: "Claude Sonnet 4.6" },
        { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      ]},
    ],
    setupGuide: [
      "Go to console.anthropic.com and sign up or log in",
      "Navigate to API Keys → Create Key",
      "Copy the key (starts with sk-ant-...)",
      "Paste it here as the API Key",
      "Choose a default model",
    ],
  },
  {
    platform: "llm_openai",
    label: "OpenAI (GPT)",
    shortLabel: "OpenAI",
    icon: <svg className="h-11 w-11" viewBox="0 0 24 24" fill="#000000" xmlns="http://www.w3.org/2000/svg"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" /></svg>,
    fields: [
      { key: "client_id", label: "API Key", type: "id" as const },
    ],
    showRedirectUri: false,
    description: "Access GPT-4o and other OpenAI models directly",
    extraFields: [
      { key: "default_model", label: "Default Model", placeholder: "gpt-4o", defaultValue: "gpt-4o", options: [
        { value: "gpt-4o", label: "GPT-4o" },
        { value: "gpt-4o-mini", label: "GPT-4o Mini (cheaper)" },
        { value: "gpt-4.1", label: "GPT-4.1" },
      ]},
    ],
    setupGuide: [
      "Go to platform.openai.com and sign up or log in",
      "Navigate to API Keys → Create new secret key",
      "Copy the key (starts with sk-...)",
      "Paste it here as the API Key",
      "Choose a default model — GPT-4o is recommended",
    ],
  },
  {
    platform: "llm_google",
    label: "Google Gemini",
    shortLabel: "Gemini",
    icon: <svg className="h-11 w-11" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gemini-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#439DDF" /><stop offset="52%" stopColor="#4F87ED" /><stop offset="78%" stopColor="#9476C5" /><stop offset="89%" stopColor="#BC688E" /><stop offset="100%" stopColor="#D6645D" /></linearGradient></defs><path fill="url(#gemini-grad)" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" /></svg>,
    fields: [
      { key: "client_id", label: "API Key", type: "id" as const },
    ],
    showRedirectUri: false,
    description: "Access Gemini 2.5 Pro and Flash models from Google AI Studio",
    extraFields: [
      { key: "default_model", label: "Default Model", placeholder: "gemini-2.5-pro", defaultValue: "gemini-2.5-pro", options: [
        { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
        { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash (faster/cheaper)" },
      ]},
    ],
    setupGuide: [
      "Go to aistudio.google.com and sign in with your Google account",
      "Click 'Get API Key' → 'Create API Key'",
      "Select or create a Google Cloud project",
      "Copy the generated API key",
      "Paste it here as the API Key",
      "Choose a default model — Gemini 2.5 Pro is recommended",
    ],
  },
];

// ─── Tile ───

function PlatformTile({
  config,
  isConfigured,
  onClick,
}: {
  config: PlatformConfig;
  isConfigured: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex flex-col items-center justify-center gap-3 p-7 rounded-2xl border border-zinc-200 bg-gradient-to-b from-zinc-50 to-zinc-100/80 transition-all",
        "hover:shadow-lg hover:border-zinc-300 hover:from-white hover:to-zinc-50 active:scale-[0.98]",
      )}
    >
      {/* Status indicator */}
      <div className={cn(
        "absolute top-3 right-3 h-3 w-3 rounded-full ring-2",
        isConfigured ? "bg-green-500 ring-green-200" : "bg-zinc-300 ring-zinc-100"
      )} />

      {config.icon}

      <span className="text-sm font-semibold text-zinc-800">
        {config.shortLabel}
      </span>

      <span className={cn(
        "text-xs font-medium",
        isConfigured ? "text-green-600" : "text-zinc-400"
      )}>
        {isConfigured ? "Configured" : "Not set up"}
      </span>
    </button>
  );
}

// ─── Detail Modal ───

function PlatformDetailModal({
  config,
  open,
  onClose,
}: {
  config: PlatformConfig | null;
  open: boolean;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  const { data: allCreds, refetch } = trpc.credentials.list.useQuery();
  const upsertMutation = trpc.credentials.upsert.useMutation();
  const testMutation = trpc.credentials.test.useMutation();

  const existingCred = config ? allCreds?.find((c: any) => c.platform === config.platform) : null;
  const isConfigured = !!existingCred?.client_id;

  useEffect(() => {
    if (!config) return;
    const initial: Record<string, string> = {};
    if (existingCred) {
      for (const field of config.fields) {
        if (field.type === "id") initial[field.key] = existingCred.client_id || "";
      }
      if (config.extraFields && existingCred.metadata) {
        for (const ef of config.extraFields) {
          initial[ef.key] = existingCred.metadata[ef.key] || ef.defaultValue;
        }
      }
    } else if (config.extraFields) {
      for (const ef of config.extraFields) {
        initial[ef.key] = ef.defaultValue;
      }
    }
    setValues(initial);
    setTestResult(null);
    setShowGuide(false);
    setShowSecrets({});
  }, [config, existingCred]);

  if (!config) return null;
  const appUrl = typeof window !== "undefined" ? window.location.origin : "";

  async function handleSave() {
    if (!config) return;
    const clientId = values.client_id || "";
    const clientSecret = values.client_secret || "";

    if (!clientId) { toast.error(`${config.fields[0].label} is required`); return; }
    const hasSecretField = config.fields.some((f) => f.type === "secret" && f.key === "client_secret");
    if (hasSecretField && !clientSecret && !existingCred?.has_secret) {
      toast.error(`${config.fields.find((f) => f.key === "client_secret")?.label || "Secret"} is required`);
      return;
    }

    setSaving(true);
    try {
      const metadata: Record<string, string> = {};
      if (config.extraFields) {
        for (const ef of config.extraFields) metadata[ef.key] = values[ef.key] || ef.defaultValue;
      }
      await upsertMutation.mutateAsync({
        platform: config.platform as any,
        client_id: clientId,
        client_secret: clientSecret || undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
      toast.success(`${config.label} saved`);
      setTestResult(null);
      setValues((prev) => ({ ...prev, client_secret: "" }));
      refetch();
    } catch (e: any) { toast.error(e.message); }
    setSaving(false);
  }

  async function handleTest() {
    if (!config) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testMutation.mutateAsync({ platform: config.platform as any });
      setTestResult(result);
      if (result.success) toast.success(result.message || "Verified");
      else toast.error(result.error || "Failed");
      refetch();
    } catch (e: any) {
      setTestResult({ success: false, error: e.message });
      toast.error(e.message);
    }
    setTesting(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[90vh] overflow-y-auto p-8">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {config.icon}
            <div>
              <DialogTitle>{config.label}</DialogTitle>
              {config.description && (
                <DialogDescription className="text-xs">{config.description}</DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 pt-4">
          {/* Setup Guide */}
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            {showGuide ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <HelpCircle className="h-3.5 w-3.5" />
            How to get these credentials
          </button>
          {showGuide && (
            <ol className="ml-1 p-3 bg-muted/50 rounded-lg space-y-2 list-decimal list-inside">
              {config.setupGuide.map((step, i) => (
                <li key={i} className="text-xs text-muted-foreground pl-1">{step}</li>
              ))}
            </ol>
          )}

          {/* Fields */}
          {config.fields.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label className="text-base font-medium">{field.label}</Label>
              <div className="relative">
                <Input
                  className="h-11 text-base"
                  type={field.type === "secret" && !showSecrets[field.key] ? "password" : "text"}
                  value={values[field.key] || ""}
                  onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                  disabled={saving || testing}
                  placeholder={
                    field.type === "secret" && existingCred?.has_secret
                      ? existingCred.client_secret_masked
                      : `Enter ${field.label}`
                  }
                />
                {field.type === "secret" && (
                  <button
                    type="button"
                    onClick={() => setShowSecrets({ ...showSecrets, [field.key]: !showSecrets[field.key] })}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showSecrets[field.key] ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                )}
              </div>
            </div>
          ))}

          {config.extraFields?.map((ef) => (
            <div key={ef.key} className="space-y-2">
              <Label className="text-base font-medium">{ef.label}</Label>
              {ef.options ? (
                <Select
                  value={values[ef.key] || ef.defaultValue}
                  onValueChange={(v) => setValues({ ...values, [ef.key]: v || "" })}
                  disabled={saving || testing}
                >
                  <SelectTrigger className="h-11 text-base">
                    <SelectValue placeholder={ef.placeholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {ef.options.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="h-11 text-base"
                  value={values[ef.key] || ef.defaultValue}
                  onChange={(e) => setValues({ ...values, [ef.key]: e.target.value })}
                  disabled={saving || testing}
                  placeholder={ef.placeholder}
                />
              )}
            </div>
          ))}

          {config.showRedirectUri && config.callbackPath && (
            <div className="space-y-2">
              <Label className="text-base font-medium">Redirect URI</Label>
              <div className="flex items-center gap-3">
                <Input value={`${appUrl}${config.callbackPath}`} readOnly className="h-11 bg-muted text-muted-foreground text-sm font-mono" />
                <Button variant="outline" size="default" onClick={() => { navigator.clipboard.writeText(`${appUrl}${config.callbackPath}`); toast.success("Copied"); }}>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Add this exact URL to your app&apos;s authorized redirect URIs in the developer portal</p>
            </div>
          )}

          {testResult && !testResult.success && (
            <div className="flex items-start gap-3 p-4 bg-red-50 text-red-700 rounded-lg text-sm">
              <XCircle className="h-5 w-5 shrink-0 mt-0.5" /><span>{testResult.error}</span>
            </div>
          )}
          {testResult?.success && (
            <div className="flex items-start gap-3 p-4 bg-green-50 text-green-700 rounded-lg text-sm">
              <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" /><span>{testResult.message}</span>
            </div>
          )}

          <div className="flex gap-3 pt-3">
            <Button onClick={handleSave} disabled={saving} className="flex-1 h-11 text-base">
              {saving ? <Loader2 className="h-5 w-5 mr-2 animate-spin" /> : <Save className="h-5 w-5 mr-2" />}
              Save
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || !isConfigured} className="h-11 text-base px-6">
              {testing ? <Loader2 className="h-5 w-5 mr-2 animate-spin" /> : <CheckCircle2 className="h-5 w-5 mr-2" />}
              Test
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main ───

export function PlatformCredentials() {
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const { data: allCreds } = trpc.credentials.list.useQuery();

  const selectedConfig = selectedPlatform ? platforms.find((p) => p.platform === selectedPlatform) || null : null;
  const configuredCount = platforms.filter((p) => allCreds?.some((c: any) => c.platform === p.platform && c.client_id)).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Shield className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">Platform Credentials</h2>
          <p className="text-sm text-muted-foreground">
            {configuredCount} of {platforms.length} configured
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
        {platforms.map((config) => (
          <PlatformTile
            key={config.platform}
            config={config}
            isConfigured={!!allCreds?.some((c: any) => c.platform === config.platform && c.client_id)}
            onClick={() => setSelectedPlatform(config.platform)}
          />
        ))}
      </div>

      <PlatformDetailModal
        config={selectedConfig}
        open={!!selectedPlatform}
        onClose={() => setSelectedPlatform(null)}
      />

      {/* OpenRouter Key Pool */}
      <OpenRouterKeyPool />
    </div>
  );
}

// ─── OpenRouter Key Pool Management ───

function OpenRouterKeyPool() {
  const [newKey, setNewKey] = useState("");
  const [showInput, setShowInput] = useState(false);
  const utils = trpc.useUtils();

  const { data: pool } = trpc.credentials.getKeyPool.useQuery();

  const addMutation = trpc.credentials.addPoolKey.useMutation({
    onSuccess: (data) => {
      toast.success(`Key added (${data.count} total in pool)`);
      setNewKey("");
      setShowInput(false);
      utils.credentials.getKeyPool.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const removeMutation = trpc.credentials.removePoolKey.useMutation({
    onSuccess: () => {
      toast.success("Key removed");
      utils.credentials.getKeyPool.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (!pool) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">OpenRouter Key Pool</CardTitle>
            <CardDescription>
              Add multiple API keys for automatic failover when a key runs out of credits or hits rate limits.
              {pool.count > 0 && ` ${pool.count} backup key${pool.count !== 1 ? "s" : ""} configured.`}
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowInput(!showInput)}
          >
            {showInput ? "Cancel" : "Add Key"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {showInput && (
          <div className="flex gap-2 mb-4">
            <Input
              type="password"
              placeholder="sk-or-v1-..."
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              className="font-mono text-sm"
            />
            <Button
              onClick={() => newKey.trim() && addMutation.mutate({ apiKey: newKey.trim() })}
              disabled={!newKey.trim() || addMutation.isPending}
            >
              {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
            </Button>
          </div>
        )}

        {pool.count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No backup keys configured. The primary OpenRouter key will be used. Add backup keys for automatic failover.
          </p>
        ) : (
          <div className="space-y-2">
            {pool.keys.map((key: any) => (
              <div key={key.index} className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/30">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">#{key.index + 1}</Badge>
                  <code className="text-xs font-mono text-muted-foreground">{key.masked}</code>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600"
                  onClick={() => {
                    if (confirm("Remove this API key from the pool?")) {
                      removeMutation.mutate({ index: key.index });
                    }
                  }}
                  disabled={removeMutation.isPending}
                >
                  <XCircle className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-3">
          Keys are tried in order. If one gets 402 (out of credits) or 429 (rate limited), the next key is used automatically. Two full rotations are attempted before failing.
        </p>
      </CardContent>
    </Card>
  );
}
