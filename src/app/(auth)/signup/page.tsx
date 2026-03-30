"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Mail } from "lucide-react";

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [inviteValid, setInviteValid] = useState<boolean | null>(null);
  const [inviteChecking, setInviteChecking] = useState(false);

  const inviteToken = searchParams.get("invite");
  const isInvited = !!inviteToken;

  // Validate invite token on mount
  useEffect(() => {
    if (!inviteToken) return;

    setInviteChecking(true);
    fetch(`/api/invite-check?token=${encodeURIComponent(inviteToken)}`)
      .then((res) => res.json())
      .then((data) => {
        setInviteValid(data.valid);
        if (data.valid && data.email) {
          setEmail(data.email);
        }
        if (!data.valid) {
          setError(data.error || "Invalid invitation link");
        }
      })
      .catch(() => {
        setInviteValid(false);
        setError("Failed to validate invitation");
      })
      .finally(() => setInviteChecking(false));
  }, [inviteToken]);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Block signup without a valid invitation
    if (!inviteToken || inviteValid === false) {
      setError("Signup requires an invitation. Contact your admin to get an invite link.");
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name },
        emailRedirectTo: `${window.location.origin}/callback/auth`,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // The handle_new_user() DB trigger checks for pending invitations by email
    // and automatically assigns the correct org, role, and brand
    router.push("/library");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">
            {isInvited ? "Accept Invitation" : "Create Account"}
          </CardTitle>
          <CardDescription>
            {isInvited ? (
              <span className="flex items-center justify-center gap-2 mt-1">
                <Mail className="h-4 w-4" />
                You&apos;ve been invited to join an organization
              </span>
            ) : (
              "Signup is invite-only. Contact your admin to get an invite link."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!isInvited && (
            <div className="p-4 bg-amber-50 text-amber-800 rounded-lg text-sm text-center">
              <p className="font-medium">Invite-only access</p>
              <p className="mt-1">You need an invitation link from an admin to sign up.</p>
              <Link href="/login" className="mt-3 inline-block text-primary underline text-sm">
                Already have an account? Log in
              </Link>
            </div>
          )}

          {isInvited && inviteChecking && (
            <div className="mb-4 p-3 bg-gray-50 text-gray-600 rounded-lg text-sm text-center">
              Validating invitation...
            </div>
          )}

          {isInvited && inviteValid === false && (
            <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm text-center">
              This invitation link is invalid or has expired. Please request a new invitation.
            </div>
          )}

          {isInvited && inviteValid && (
            <div className="mb-4 p-3 bg-blue-50 text-blue-700 rounded-lg text-sm text-center">
              Sign up with the email your invitation was sent to. You&apos;ll automatically join the organization with the assigned role.
            </div>
          )}

          {isInvited && <form onSubmit={handleSignup} className="space-y-4">
            {error && (
              <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md">{error}</div>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="John Doe"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                minLength={6}
                required
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading || inviteChecking || (isInvited && inviteValid === false)}>
              {inviteChecking
                ? "Validating invitation..."
                : loading
                  ? "Creating account..."
                  : isInvited
                    ? "Accept & Create Account"
                    : "Create account"}
            </Button>
          </form>}

          {isInvited && <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="text-primary hover:underline font-medium">
              Sign in
            </Link>
          </p>}
        </CardContent>
      </Card>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      }
    >
      <SignupForm />
    </Suspense>
  );
}
