import { useEffect, useState, type ReactNode } from "react";
import { SignInLanding, type OnlineConfig } from "./SignInLanding";
import "./online.css";

interface Me {
  user: { id: string; name: string; email: string; image?: string | null };
}

type GateState =
  | { phase: "loading" }
  | { phase: "landing"; config: OnlineConfig; signedIn: boolean }
  | { phase: "app"; me: Me };

const FALLBACK_CONFIG: OnlineConfig = {
  demoQuota: false,
  providers: { google: false, github: false },
  devLogin: false,
};

/** Wraps the app for the hosted deployment. Two hosts share one bundle:
 * the landing origin (chamferonline.com) always renders the landing page -
 * signed-in visitors get an "Open Chamfer" shortcut to the app origin - while
 * the app origin renders the application and sends signed-out visitors to the
 * landing. Hosts without the split (localhost, workers.dev) do both in place. */
export function OnlineGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [meResponse, configResponse] = await Promise.all([
        fetch("/api/me"),
        fetch("/api/online/config"),
      ]);
      const config = configResponse.ok
        ? ((await configResponse.json()) as OnlineConfig)
        : FALLBACK_CONFIG;
      const signedIn = meResponse.ok;
      const origin = window.location.origin;
      const onLandingHost = Boolean(config.landingOrigin) && origin === config.landingOrigin;

      if (cancelled) return;
      if (onLandingHost) {
        setState({ phase: "landing", config, signedIn });
        return;
      }
      if (signedIn) {
        setState({ phase: "app", me: (await meResponse.json()) as Me });
        return;
      }
      if (config.landingOrigin && config.landingOrigin !== origin) {
        window.location.replace(config.landingOrigin);
        return;
      }
      setState({ phase: "landing", config, signedIn: false });
    })().catch(() => {
      if (!cancelled) setState({ phase: "landing", config: FALLBACK_CONFIG, signedIn: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return <div className="online-gate-loading" aria-label="Loading" />;
  }
  if (state.phase === "landing") {
    return <SignInLanding config={state.config} signedIn={state.signedIn} />;
  }
  return (
    <>
      {children}
      <AccountChip me={state.me} />
    </>
  );
}

function AccountChip({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const signOut = async () => {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
    window.location.reload();
  };
  const initial = (me.user.name || me.user.email || "?").slice(0, 1).toUpperCase();
  return (
    <div className="online-account-chip">
      <button
        type="button"
        className="online-account-chip-button"
        title={`${me.user.name} (${me.user.email})`}
        onClick={() => setOpen((value) => !value)}
      >
        {me.user.image ? <img src={me.user.image} alt="" referrerPolicy="no-referrer" /> : initial}
      </button>
      {open && (
        <div className="online-account-chip-menu">
          <div className="online-account-chip-identity">
            <strong>{me.user.name}</strong>
            <span>{me.user.email}</span>
          </div>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
