"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { motion } from "framer-motion";
import { createSupabaseBrowserClient } from "@/lib/supabase-client";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    async function redirect() {
      const supabase = createSupabaseBrowserClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        router.replace("/studio/login");
        return;
      }

      const { data: staff } = await supabase
        .from("staff")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();

      router.replace(staff?.role === "admin" ? "/studio/admin" : "/studio/designer");
    }
    redirect();
  }, [router]);

  return (
    <main className="min-h-[100dvh] bg-bg flex flex-col items-center justify-center px-5 relative overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg,#c9a84c 0px,#c9a84c 1px,transparent 1px,transparent 60px),repeating-linear-gradient(90deg,#c9a84c 0px,#c9a84c 1px,transparent 1px,transparent 60px)",
        }}
      />
      {[
        "top-6 left-6 border-t-2 border-l-2 rounded-tl",
        "top-6 right-6 border-t-2 border-r-2 rounded-tr",
        "bottom-6 left-6 border-b-2 border-l-2 rounded-bl",
        "bottom-6 right-6 border-b-2 border-r-2 rounded-br",
      ].map((cls) => (
        <div key={cls} className={`absolute w-10 h-10 border-gold/20 ${cls}`} />
      ))}

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="flex flex-col items-center gap-6 z-10"
      >
        <div className="w-40 h-40 sm:w-56 sm:h-56 relative drop-shadow-2xl">
          <Image
            src="/cleopatra-logo.svg"
            alt="Cleopatra Ink Studio"
            fill
            className="object-contain"
            priority
          />
        </div>

        <div className="text-center flex flex-col gap-1">
          <h1 className="font-cinzel text-4xl sm:text-5xl font-black tracking-[0.12em] text-ink uppercase leading-none">
            Cleopatra
          </h1>
          <h2 className="font-cinzel text-xl sm:text-2xl font-bold tracking-[0.22em] text-gold uppercase">
            Ink Studio
          </h2>
          <div className="flex items-center gap-3 my-2">
            <div className="flex-1 h-px bg-gradient-to-r from-transparent to-gold/40" />
            <div className="w-1 h-1 rounded-full bg-gold rotate-45" />
            <div className="flex-1 h-px bg-gradient-to-l from-transparent to-gold/40" />
          </div>
          <p className="text-muted text-xs tracking-[0.18em] uppercase font-cinzel">
            Custom Tattoo Design
          </p>
        </div>

        <div className="flex items-center gap-2 mt-2">
          <div className="w-4 h-4 border-2 border-gold/40 border-t-gold rounded-full animate-spin" />
          <span className="text-muted text-xs font-mono tracking-widest">Loading…</span>
        </div>
      </motion.div>

      <p className="absolute bottom-6 text-muted text-[10px] font-mono tracking-widest z-10">
        CLEOPATRA INK STUDIO © 2026
      </p>
    </main>
  );
}
