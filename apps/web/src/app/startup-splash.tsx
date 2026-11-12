"use client";

import { useEffect, useRef, useState } from "react";

type StartupSplashProps = {
  ready: boolean;
};

export function StartupSplash({ ready }: StartupSplashProps) {
  const [dismissed, setDismissed] = useState(false);
  const [introComplete, setIntroComplete] = useState(false);
  const descriptorRef = useRef<HTMLSpanElement>(null);
  const canDismiss = ready && introComplete;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIntroComplete(true);
      return;
    }

    const introAnimation = descriptorRef.current?.getAnimations()[0];
    if (!introAnimation) {
      setIntroComplete(true);
      return;
    }

    let mounted = true;
    void introAnimation.finished.then(() => {
      if (mounted) setIntroComplete(true);
    }).catch(() => undefined);

    return () => { mounted = false; };
  }, []);

  if (dismissed) return null;

  return (
    <div
      className={`startup-splash${ready ? " has-data" : ""}${canDismiss ? " is-ready" : ""}`}
      role={canDismiss ? undefined : "status"}
      aria-label={canDismiss ? undefined : "Inicializando o NEXUS"}
      aria-live="polite"
      aria-hidden={canDismiss || undefined}
      onTransitionEnd={(event) => {
        if (canDismiss && event.target === event.currentTarget && event.propertyName === "opacity") {
          setDismissed(true);
        }
      }}
    >
      <div className="startup-lockup">
        <svg className="startup-mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id="startup-nexus-gradient" x1="11" y1="51" x2="52" y2="12" gradientUnits="userSpaceOnUse">
              <stop stopColor="#8B3DFF" />
              <stop offset="1" stopColor="#28A9FF" />
            </linearGradient>
          </defs>
          <path className="startup-mark-glow" d="M13 51V17c0-3.8 4.5-5.6 7.1-2.7L51 51V13" stroke="url(#startup-nexus-gradient)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          <path className="startup-mark-line" d="M13 51V17c0-3.8 4.5-5.6 7.1-2.7L51 51V13" stroke="url(#startup-nexus-gradient)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="startup-wordmark">NEXUS</span>
        <span ref={descriptorRef} className="startup-descriptor" onAnimationEnd={(event) => {
          if (event.animationName === "startup-reveal") setIntroComplete(true);
        }}>INTELLIGENT OPERATIONS PLATFORM</span>
        <div className="startup-progress-track" role="progressbar" aria-label="Inicializando o NEXUS" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ready ? 100 : undefined}>
          <span className="startup-progress-scan" />
          <span className="startup-progress-fill" />
        </div>
      </div>
    </div>
  );
}
