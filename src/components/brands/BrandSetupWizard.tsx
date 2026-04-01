"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Check,
  ChevronRight,
  Building2,
  HardDrive,
  Link2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";

const steps = [
  { id: 1, label: "Brand Name", icon: Building2 },
  { id: 2, label: "Connect Google Drive", icon: HardDrive },
  { id: 3, label: "Connect Social Accounts", icon: Link2 },
];

const InstagramIcon = ({ className }: { className?: string }) => (
  <svg className={className || "h-5 w-5"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
  </svg>
);

const YoutubeIcon = ({ className }: { className?: string }) => (
  <svg className={className || "h-5 w-5"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
    <path d="m10 15 5-3-5-3z" />
  </svg>
);

const LinkedInIcon = ({ className }: { className?: string }) => (
  <svg className={className || "h-5 w-5"} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
);

export function BrandSetupWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [currentStep, setCurrentStep] = useState(1);
  const [brandName, setBrandName] = useState("");
  const [brandId, setBrandId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Drive verification state
  const [driveConnected, setDriveConnected] = useState(false);
  const [driveVerified, setDriveVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyChecks, setVerifyChecks] = useState({
    folderCreate: false,
    fileUpload: false,
    fileRead: false,
  });
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveEmail, setDriveEmail] = useState<string | null>(null);

  // Handle OAuth redirect params
  useEffect(() => {
    const step = searchParams.get("step");
    const returnedBrandId = searchParams.get("brandId");
    const connected = searchParams.get("drive_connected");
    const error = searchParams.get("drive_error");

    if (returnedBrandId) {
      setBrandId(returnedBrandId);
    }

    if (step === "2" && returnedBrandId) {
      setCurrentStep(2);

      if (connected === "true") {
        setDriveConnected(true);
        // Auto-run verification
        runVerification(returnedBrandId);
      }

      if (error) {
        setDriveError(decodeURIComponent(error));
        toast.error(`Drive connection failed: ${decodeURIComponent(error)}`);
      }
    }
  }, [searchParams]);

  // Check existing Drive status when entering step 2
  const driveStatus = trpc.drive.status.useQuery(
    { brandId: brandId! },
    { enabled: !!brandId && currentStep === 2 }
  );

  useEffect(() => {
    if (driveStatus.data?.connected && driveStatus.data?.isActive) {
      setDriveConnected(true);
      setDriveEmail(driveStatus.data.email);
      if (!driveVerified && !verifying) {
        runVerification(brandId!);
      }
    }
  }, [driveStatus.data]);

  const createBrandMutation = trpc.brands.create.useMutation({
    onSuccess: (data) => {
      setBrandId(data.id);
      toast.success("Brand created");
      setSaving(false);
      setCurrentStep(2);
    },
    onError: (error) => {
      toast.error(error.message);
      setSaving(false);
    },
  });

  const connectDriveMutation = trpc.drive.connect.useMutation({
    onSuccess: (data) => {
      // Redirect to Google OAuth
      window.location.href = data.url;
    },
    onError: (error) => {
      toast.error(error.message);
      setDriveError(error.message);
    },
  });

  const verifyMutation = trpc.drive.verify.useMutation();

  const connectOAuthMutation = trpc.socialAccounts.initiateOAuth.useMutation({
    onSuccess: (data) => { window.location.href = data.url; },
    onError: (error) => toast.error(error.message),
  });

  const updateBrandMutation = trpc.brands.update.useMutation({
    onSuccess: () => {
      toast.success("Brand setup complete!");
      router.push("/brands");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  function handleCreateBrand() {
    if (!brandName.trim()) return;
    setSaving(true);
    createBrandMutation.mutate({ name: brandName.trim() });
  }

  function handleConnectDrive() {
    if (!brandId) return;
    setDriveError(null);
    connectDriveMutation.mutate({ brandId, from: "brand-setup" });
  }

  async function runVerification(bId: string) {
    setVerifying(true);
    setDriveError(null);
    setVerifyChecks({ folderCreate: false, fileUpload: false, fileRead: false });

    try {
      const result = await verifyMutation.mutateAsync({ brandId: bId });
      setVerifyChecks(result.checks);

      if (result.success) {
        setDriveVerified(true);
        toast.success("Drive verified successfully!");
      } else {
        setDriveError(result.errors.join("; "));
      }
    } catch (e: any) {
      setDriveError(e.message);
    } finally {
      setVerifying(false);
    }
  }

  function handleFinish() {
    if (brandId) {
      updateBrandMutation.mutate({ id: brandId, setup_status: "active" });
    } else {
      router.push("/brands");
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Add New Brand</h1>
        <p className="text-muted-foreground">Set up a new brand in 3 steps</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const Icon = step.icon;
          const isCompleted = currentStep > step.id;
          const isCurrent = currentStep === step.id;

          return (
            <div key={step.id} className="flex items-center flex-1">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "h-10 w-10 rounded-full flex items-center justify-center border-2 transition-colors",
                    isCompleted
                      ? "bg-primary border-primary text-primary-foreground"
                      : isCurrent
                        ? "border-primary text-primary"
                        : "border-muted text-muted-foreground"
                  )}
                >
                  {isCompleted ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                </div>
                <span
                  className={cn(
                    "text-sm font-medium hidden sm:inline",
                    isCurrent ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {step.label}
                </span>
              </div>
              {index < steps.length - 1 && (
                <ChevronRight className="h-5 w-5 mx-4 text-muted-foreground" />
              )}
            </div>
          );
        })}
      </div>

      {/* Step 1: Brand Name */}
      {currentStep === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Brand Name</CardTitle>
            <CardDescription>What is the name of this brand?</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              id="brandName"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              placeholder="e.g., Acme Corp"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreateBrand()}
            />
            <div className="flex justify-end">
              <Button onClick={handleCreateBrand} disabled={saving || !brandName.trim()}>
                {saving ? "Creating..." : "Create Brand & Continue"}
                <ChevronRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Connect Google Drive */}
      {currentStep === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Connect Google Drive</CardTitle>
            <CardDescription>
              All media is stored in the brand&apos;s own Google Drive. The platform stores zero files.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!driveConnected ? (
              /* Not connected — show connect button */
              <div className="flex items-center justify-center h-48 border-2 border-dashed rounded-lg">
                <div className="text-center">
                  <HardDrive className="h-12 w-12 mx-auto mb-3 text-muted-foreground" />
                  <p className="font-medium mb-2">Connect Google Drive</p>
                  <p className="text-sm text-muted-foreground mb-4">
                    Auto-creates MediaHub/Originals/ and MediaHub/Processed/ folders
                  </p>
                  <Button
                    onClick={handleConnectDrive}
                    disabled={connectDriveMutation.isPending}
                  >
                    {connectDriveMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <HardDrive className="h-4 w-4 mr-2" />
                    )}
                    Connect Drive
                  </Button>
                </div>
              </div>
            ) : (
              /* Connected — show verification */
              <div className="space-y-4">
                {driveEmail && (
                  <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    <span className="text-sm">Connected as <strong>{driveEmail}</strong></span>
                  </div>
                )}

                {/* Verification checks */}
                <div className="space-y-2">
                  <p className="text-sm font-medium">Verification checks:</p>
                  <VerifyCheckItem
                    label="Folder structure (MediaHub/Originals, Processed)"
                    checked={verifyChecks.folderCreate}
                    loading={verifying && !verifyChecks.folderCreate}
                  />
                  <VerifyCheckItem
                    label="Can upload files to Drive"
                    checked={verifyChecks.fileUpload}
                    loading={verifying && verifyChecks.folderCreate && !verifyChecks.fileUpload}
                  />
                  <VerifyCheckItem
                    label="Can read files from Drive"
                    checked={verifyChecks.fileRead}
                    loading={verifying && verifyChecks.fileUpload && !verifyChecks.fileRead}
                  />
                </div>

                {/* Success */}
                {driveVerified && (
                  <div className="flex items-center gap-2 p-3 bg-green-50 text-green-700 rounded-lg">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="text-sm font-medium">Drive connected and verified successfully!</span>
                  </div>
                )}

                {/* Error */}
                {driveError && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg">
                      <AlertCircle className="h-5 w-5 shrink-0" />
                      <span className="text-sm">{driveError}</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => runVerification(brandId!)}
                      disabled={verifying}
                    >
                      <RefreshCw className={cn("h-4 w-4 mr-2", verifying && "animate-spin")} />
                      Retry Verification
                    </Button>
                  </div>
                )}
              </div>
            )}

            <Separator />

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setCurrentStep(1)}>
                Back
              </Button>
              <div className="flex gap-2">
                {!driveVerified && (
                  <Button
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => {
                      toast.info("Brand created without Drive. The brand owner can connect their Drive later from the Accounts page.");
                      router.push("/brands");
                    }}
                  >
                    Skip &amp; finish
                  </Button>
                )}
                <Button
                  onClick={() => setCurrentStep(3)}
                  disabled={!driveVerified}
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Connect Social Accounts */}
      {currentStep === 3 && (
        <Card>
          <CardHeader>
            <CardTitle>Connect Social Accounts</CardTitle>
            <CardDescription>
              Connect Instagram, YouTube, and LinkedIn accounts for this brand.
              You can connect multiple accounts per platform.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4">
              {([
                { platform: "instagram" as const, label: "Connect Instagram", sub: "Via Facebook/Meta OAuth", icon: <InstagramIcon className="h-6 w-6 text-pink-500" /> },
                { platform: "youtube" as const, label: "Connect YouTube", sub: "Via Google OAuth", icon: <YoutubeIcon className="h-6 w-6 text-red-500" /> },
                { platform: "linkedin" as const, label: "Connect LinkedIn", sub: "Via LinkedIn OAuth", icon: <LinkedInIcon /> },
              ]).map((p) => (
                <Button
                  key={p.platform}
                  variant="outline"
                  className="h-16 justify-start gap-4"
                  disabled={!brandId || connectOAuthMutation.isPending}
                  onClick={() => brandId && connectOAuthMutation.mutate({ brandId, platform: p.platform })}
                >
                  {p.icon}
                  <div className="text-left">
                    <p className="font-medium">{p.label}</p>
                    <p className="text-xs text-muted-foreground">{p.sub}</p>
                  </div>
                  {connectOAuthMutation.isPending && <Loader2 className="h-4 w-4 animate-spin ml-auto" />}
                </Button>
              ))}
            </div>

            <p className="text-xs text-center text-muted-foreground">
              Make sure platform credentials are configured in Settings before connecting.
              You can also connect accounts later from the Accounts page.
            </p>

            <Separator />

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setCurrentStep(2)}>
                Back
              </Button>
              <Button onClick={handleFinish}>
                Finish Setup
                <Check className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function VerifyCheckItem({
  label,
  checked,
  loading,
}: {
  label: string;
  checked: boolean;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
      ) : checked ? (
        <CheckCircle2 className="h-4 w-4 text-green-500" />
      ) : (
        <div className="h-4 w-4 rounded-full border-2 border-muted" />
      )}
      <span className={checked ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </div>
  );
}
