import nodemailer from "nodemailer";
import { getDb } from "@/lib/supabase/db";
import { decrypt } from "@/lib/encryption";

// ─── Types ───

export interface EmailConfig {
  configured: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass?: string;
  fromEmail: string;
  fromName: string;
}

export interface SendResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

// ─── Config ───

/**
 * Load SMTP email config from platform_credentials (platform = 'email_smtp').
 * Credentials stored as:
 *   client_id_encrypted = Gmail email address
 *   client_secret_encrypted = Gmail App Password
 *   metadata = { from_name, smtp_host, smtp_port }
 */
export async function getEmailConfig(orgId?: string): Promise<EmailConfig> {
  const fallback: EmailConfig = {
    configured: false,
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpUser: "",
    fromEmail: "",
    fromName: "MediaHub",
  };

  try {
    const db = getDb();
    let query = db
      .from("platform_credentials")
      .select("client_id_encrypted, client_secret_encrypted, metadata")
      .eq("platform", "email_smtp");

    if (orgId) {
      query = query.eq("org_id", orgId);
    }

    const { data, error } = await query.limit(1).single();

    if (error || !data?.client_id_encrypted || !data?.client_secret_encrypted) {
      return fallback;
    }

    const email = decrypt(data.client_id_encrypted);
    const password = decrypt(data.client_secret_encrypted);

    if (!email || !password || password === "none") {
      return fallback;
    }

    const meta = (data.metadata || {}) as Record<string, string>;
    return {
      configured: true,
      smtpHost: meta.smtp_host || "smtp.gmail.com",
      smtpPort: parseInt(meta.smtp_port || "587", 10),
      smtpUser: email,
      smtpPass: password,
      fromEmail: email,
      fromName: meta.from_name || "MediaHub",
    };
  } catch (e: any) {
    console.error("[email] Failed to load config:", e.message);
    return fallback;
  }
}

// ─── Core send function ───

async function send(params: {
  config: EmailConfig;
  to: string;
  subject: string;
  html: string;
}): Promise<SendResult> {
  if (!params.config.configured || !params.config.smtpPass) {
    return { success: false, error: "Email service not configured" };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: params.config.smtpHost,
      port: params.config.smtpPort,
      secure: params.config.smtpPort === 465,
      auth: {
        user: params.config.smtpUser,
        pass: params.config.smtpPass,
      },
    });

    const info = await transporter.sendMail({
      from: `"${params.config.fromName}" <${params.config.fromEmail}>`,
      to: params.to,
      subject: params.subject,
      html: params.html,
    });

    console.log("[email] Sent to", params.to, "messageId:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (e: any) {
    console.error("[email] Send failed:", e.message);
    return { success: false, error: e.message };
  }
}

// ─── HTML helpers ───

function emailLayout(body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f5; margin: 0; padding: 40px 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
    ${body}
  </div>
  <p style="text-align: center; color: #a1a1aa; font-size: 11px; margin-top: 24px;">Sent by MediaHub</p>
</body>
</html>`;
}

function button(text: string, href: string): string {
  return `<a href="${href}" style="display: inline-block; background: #18181b; color: #ffffff; text-decoration: none; padding: 12px 32px; border-radius: 8px; font-size: 14px; font-weight: 600; margin: 8px 0;">${text}</a>`;
}

// ─── Public email functions ───

export async function sendInviteEmail(params: {
  to: string;
  inviterName: string;
  role: string;
  brandName?: string;
  inviteLink: string;
  orgId?: string;
}): Promise<SendResult> {
  const config = await getEmailConfig(params.orgId);
  const roleLabel = params.role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const brandLine = params.brandName ? ` for <strong>${params.brandName}</strong>` : "";

  return send({
    config,
    to: params.to,
    subject: `${params.inviterName} invited you to join MediaHub`,
    html: emailLayout(`
      <h1 style="font-size: 20px; color: #18181b; margin: 0 0 8px;">You're invited!</h1>
      <p style="color: #52525b; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
        <strong>${params.inviterName}</strong> invited you to join${brandLine} on MediaHub as <strong>${roleLabel}</strong>.
      </p>
      ${button("Accept Invitation", params.inviteLink)}
      <p style="color: #a1a1aa; font-size: 12px; margin: 24px 0 0; border-top: 1px solid #f4f4f5; padding-top: 16px;">
        This invitation expires in 7 days. Click the button above to create your account and set a password.
      </p>
    `),
  });
}

export async function sendWelcomeEmail(params: {
  to: string;
  name: string;
  role: string;
  inviteLink: string;
  orgId?: string;
}): Promise<SendResult> {
  const config = await getEmailConfig(params.orgId);
  const roleLabel = params.role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return send({
    config,
    to: params.to,
    subject: "Welcome to MediaHub — Set up your account",
    html: emailLayout(`
      <h1 style="font-size: 20px; color: #18181b; margin: 0 0 8px;">Welcome to MediaHub!</h1>
      <p style="color: #52525b; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
        Hi <strong>${params.name}</strong>, your account has been created with the role <strong>${roleLabel}</strong>.
        Click below to set your password and start using MediaHub.
      </p>
      ${button("Set Your Password", params.inviteLink)}
      <p style="color: #a1a1aa; font-size: 12px; margin: 24px 0 0; border-top: 1px solid #f4f4f5; padding-top: 16px;">
        If you didn't expect this email, you can safely ignore it.
      </p>
    `),
  });
}

export async function sendTestEmail(params: {
  to: string;
  orgId?: string;
}): Promise<SendResult> {
  const config = await getEmailConfig(params.orgId);

  return send({
    config,
    to: params.to,
    subject: "MediaHub — Email Configuration Test",
    html: emailLayout(`
      <h1 style="font-size: 20px; color: #16a34a; margin: 0 0 8px;">Email is working!</h1>
      <p style="color: #52525b; font-size: 14px; line-height: 1.6; margin: 0;">
        Your Gmail SMTP configuration for MediaHub is set up correctly.
        Invitation and notification emails will be delivered to your users.
      </p>
      <p style="color: #a1a1aa; font-size: 12px; margin: 24px 0 0; border-top: 1px solid #f4f4f5; padding-top: 16px;">
        Sent from: ${config.fromName} &lt;${config.fromEmail}&gt;
      </p>
    `),
  });
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
  orgId?: string;
}): Promise<SendResult> {
  const config = await getEmailConfig(params.orgId);
  return send({
    config,
    to: params.to,
    subject: params.subject,
    html: emailLayout(params.body),
  });
}
