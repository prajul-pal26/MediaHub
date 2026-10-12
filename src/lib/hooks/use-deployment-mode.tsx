"use client";

import * as React from "react";
import {
  BUILD_MODE,
  CAN_PREVIEW_MODES,
  can as canInMode,
  type Capability,
  type DeploymentMode,
} from "@/lib/deployment";

/**
 * The active deployment mode for the dashboard.
 *
 * On a live (Vercel) build this is hard-locked to "live" and the setter is a
 * no-op — the toggle is not rendered there, but locking it here too means a
 * console call or a stale localStorage value still cannot unlock local-only UI
 * for a Vercel visitor.
 *
 * On a local build the choice is remembered per browser so the preview survives
 * a reload.
 */

const STORAGE_KEY = "mediahub.deployment-mode";

interface DeploymentContextValue {
  mode: DeploymentMode;
  setMode: (mode: DeploymentMode) => void;
  /** True only on a local build — gates the header toggle itself. */
  canSwitch: boolean;
  /** Is this capability usable in the current mode? */
  can: (capability: Capability) => boolean;
}

const DeploymentContext = React.createContext<DeploymentContextValue>({
  mode: BUILD_MODE,
  setMode: () => {},
  canSwitch: false,
  can: () => true,
});

export function DeploymentModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = React.useState<DeploymentMode>(BUILD_MODE);

  // Read the saved preview AFTER mount: server and client must render the same
  // thing on the first pass or React logs a hydration mismatch.
  React.useEffect(() => {
    if (!CAN_PREVIEW_MODES) return;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "live" || saved === "local") setModeState(saved);
    } catch {
      // Private browsing or blocked storage — stay on the build default.
    }
  }, []);

  const setMode = React.useCallback((next: DeploymentMode) => {
    if (!CAN_PREVIEW_MODES) return; // live builds cannot be switched
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* non-fatal */
    }
  }, []);

  const value = React.useMemo<DeploymentContextValue>(
    () => ({
      mode,
      setMode,
      canSwitch: CAN_PREVIEW_MODES,
      can: (capability: Capability) => canInMode(capability, mode),
    }),
    [mode, setMode]
  );

  return <DeploymentContext.Provider value={value}>{children}</DeploymentContext.Provider>;
}

export function useDeploymentMode(): DeploymentContextValue {
  return React.useContext(DeploymentContext);
}
