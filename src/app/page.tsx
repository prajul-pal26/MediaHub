import { createServerSupabaseClient } from "@/lib/supabase/server";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { Hero } from "@/components/landing/Hero";
import ServicesSection from "@/components/landing/ServicesSection";
import Showcase from "@/components/landing/Showcase";
import Testimonials from "@/components/landing/Testimonials";
import CTASection from "@/components/landing/CTASection";
import Footer from "@/components/landing/Footer";

export default async function LandingPage() {
  // Adaptive header: logged-in visitors get "Open Studio" instead of "Sign in".
  let authed = false;
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    authed = Boolean(user);
  } catch {
    authed = false;
  }

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-white text-zinc-900">
      <LandingHeader authed={authed} />
      <main>
        <Hero />
        <ServicesSection />
        <Showcase />
        <Testimonials />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}
