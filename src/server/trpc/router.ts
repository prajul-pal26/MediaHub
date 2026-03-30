import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/supabase/db";
import { router } from "./index";
import { brandsRouter } from "./routers/brands";
import { credentialsRouter } from "./routers/credentials";
import { usersRouter } from "./routers/users";
import { driveRouter } from "./routers/drive";
import { mediaRouter } from "./routers/media";
import { publishRouter } from "./routers/publish";
import { jobsRouter } from "./routers/jobs";
import { socialAccountsRouter } from "./routers/social-accounts";
import { invitationsRouter } from "./routers/invitations";
import { chatRouter } from "./routers/chat";
import { llmRouter } from "./routers/llm";

export async function createTRPCContext() {
  const supabase = await createServerSupabaseClient();
  const db = getDb();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let profile: any = null;
  if (user) {
    const { data, error } = await db
      .from("users")
      .select("*")
      .eq("id", user.id)
      .single();
    if (error) {
      console.error("Failed to fetch user profile:", error.message);
    }
    profile = data;
  }

  return {
    supabase,
    db,
    user,
    profile,
  };
}

export const appRouter = router({
  brands: brandsRouter,
  credentials: credentialsRouter,
  users: usersRouter,
  drive: driveRouter,
  media: mediaRouter,
  publish: publishRouter,
  jobs: jobsRouter,
  socialAccounts: socialAccountsRouter,
  invitations: invitationsRouter,
  chat: chatRouter,
  llm: llmRouter,
});

export type AppRouter = typeof appRouter;
