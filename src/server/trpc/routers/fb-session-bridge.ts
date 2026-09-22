import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, adminProcedure } from '../index';

export const fbSessionBridgeRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.db.from('fb_session_bridges')
      .select('session_id,expected_user,enabled,status,last_attempt_at,last_success_at,last_contact_at,lease_until,expires_at')
      .eq('org_id', ctx.profile.org_id);
    if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Session bridge status is unavailable.' });
    return (data ?? []) as Array<{
      session_id: string; expected_user: string; enabled: boolean; status: string;
      last_attempt_at: string | null; last_success_at: string | null; last_contact_at: string | null; lease_until: string | null; expires_at: string;
    }>;
  }),
  pair: adminProcedure.input(z.object({ sessionId: z.string().uuid(), expectedUser: z.string().regex(/^\d{1,40}$/) }))
    .mutation(async ({ ctx, input }) => {
      const { data: session, error } = await ctx.db.from('fb_sessions').select('id,c_user')
        .eq('id', input.sessionId).eq('org_id', ctx.profile.org_id).single();
      if (error || session?.c_user !== input.expectedUser) throw new TRPCError({ code: 'BAD_REQUEST', message: 'The selected session must match the expected Facebook account ID.' });
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      const { error: saveError } = await ctx.db.from('fb_session_bridges').upsert({
        session_id: session.id, org_id: ctx.profile.org_id, user_id: ctx.profile.id,
        expected_user: input.expectedUser, token_hash: createHash('sha256').update(token).digest('hex'),
        enabled: true, expires_at: expiresAt, status: 'waiting', run_id: null, lease_until: null,
        last_attempt_at: null, last_success_at: null,
      }, { onConflict: 'session_id' });
      if (saveError) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Could not pair the session bridge.' });
      // Passed directly to the installed extension; never rendered or persisted by the page.
      return { token, sessionId: session.id as string, expectedUser: input.expectedUser, expiresAt };
    }),
  stop: adminProcedure.input(z.object({ sessionId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const { error } = await ctx.db.from('fb_session_bridges').update({ enabled: false, status: 'stopped', run_id: null, lease_until: null })
      .eq('session_id', input.sessionId).eq('org_id', ctx.profile.org_id);
    if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Could not stop the session bridge.' });
    return { ok: true };
  }),
});
