import { useState } from "react";

export interface OnlineConfig {
  demoQuota: boolean;
  providers: { google: boolean; github: boolean };
  devLogin: boolean;
  /** Origin of the application host; sign-in lands there when set. */
  appOrigin?: string;
  /** Origin of the landing host; identifies which host renders the landing. */
  landingOrigin?: string;
}

async function startSocialSignIn(provider: "google" | "github", callbackURL: string): Promise<void> {
  const response = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, callbackURL }),
  });
  if (!response.ok) throw new Error(`sign-in failed (${response.status})`);
  const body = (await response.json()) as { url?: string };
  if (!body.url) throw new Error("sign-in response had no redirect URL");
  window.location.href = body.url;
}

/** The logo mark drawn as a dimensioned engineering drawing: the part is the
 * brand, and the annotations are its real geometry from the SVG (64 x 64
 * outline, 12-unit chamfer at 45 degrees). */
function MeasuredMark() {
  return (
    <svg
      className="online-landing-drawing"
      viewBox="0 0 220 210"
      role="img"
      aria-label="Engineering drawing of the Chamfer logo: a 64 by 64 plate with a 12 by 45 degree chamfered corner"
    >
      <defs>
        <marker id="dim-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0.6 8 4 0 7.4z" fill="currentColor" />
        </marker>
      </defs>

      {/* part: the mark, scaled 1.5x, origin (52, 44) */}
      <g transform="translate(52 44) scale(1.5)">
        <path className="drawing-body" d="M0 0h52l12 12v52H0z" />
        <path d="M51 0l13 12H51z" fill="#22D3EE" />
        <path className="drawing-glyph" d="M47 14H25L14 25v14l11 11h22V39H30l-5-5v-4l5-5h17z" />
      </g>

      {/* dimensions (drawn in drafting hairlines) */}
      <g className="drawing-dims">
        {/* width 64 across the top */}
        <line x1="52" y1="36" x2="52" y2="24" />
        <line x1="148" y1="36" x2="148" y2="24" />
        <line x1="52" y1="28" x2="148" y2="28" markerStart="url(#dim-arrow)" markerEnd="url(#dim-arrow)" />
        <text x="100" y="22" textAnchor="middle">64</text>

        {/* height 64 on the left */}
        <line x1="44" y1="44" x2="32" y2="44" />
        <line x1="44" y1="140" x2="32" y2="140" />
        <line x1="36" y1="44" x2="36" y2="140" markerStart="url(#dim-arrow)" markerEnd="url(#dim-arrow)" />
        <text x="30" y="95" textAnchor="middle" transform="rotate(-90 30 95)">64</text>

        {/* chamfer leader to the cut corner */}
        <line x1="141" y1="47" x2="176" y2="68" />
        <text x="178" y="76" textAnchor="start">12 × 45°</text>
      </g>

      {/* the product's own verdict */}
      <g className="drawing-verdict" transform="translate(52 176)">
        <circle cx="7" cy="7" r="3.5" />
        <text x="16" y="11">Verified · 3/3 checks</text>
      </g>
    </svg>
  );
}

export function SignInLanding({
  config,
  signedIn = false,
}: {
  config: OnlineConfig;
  signedIn?: boolean;
}) {
  const [error, setError] = useState<string | undefined>();
  const anyProvider = config.providers.google || config.providers.github;
  const appHref = config.appOrigin ?? "/";

  const signIn = (provider: "google" | "github") => {
    setError(undefined);
    startSocialSignIn(provider, `${appHref}/`.replace(/\/+$/, "/")).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <div className="online-landing">
      <header className="online-landing-brand">
        <img src="/brand/chamfer-mark.svg" alt="" width={30} height={30} />
        <span>Chamfer</span>
        <a
          className="online-star-chip"
          href="https://github.com/SmartAI/Chamfer"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 .8l2.12 4.3 4.75.69-3.44 3.35.81 4.73L8 11.64l-4.24 2.23.81-4.73L1.13 5.79l4.75-.69z"
            />
          </svg>
          <span>Open source - star it if it's useful</span>
        </a>
      </header>

      <main className="online-landing-hero">
        <section className="online-landing-pitch">
          <h1>
            Describe it.
            <br />
            Watch it take shape.
          </h1>
          <p className="online-landing-tagline">
            Chamfer is an AI CAD designer in your browser. It writes build123d Python, executes it
            locally, and a geometry kernel verifies every dimension before you see it.
          </p>
          <ul className="online-landing-points">
            <li>CAD runs in your browser - geometry never leaves your machine.</li>
            {config.demoQuota ? (
              <li>Free design credits to get started, or bring your own API key for unlimited use.</li>
            ) : (
              <li>Bring your own Anthropic, OpenAI, or Google API key - add it in Settings.</li>
            )}
            <li>Conversations and designs are private to your account.</li>
          </ul>
          {signedIn ? (
            <div className="online-landing-signin">
              <a className="online-cta" href={appHref}>
                Open Chamfer
              </a>
            </div>
          ) : anyProvider ? (
            <div className="online-landing-signin">
              {config.providers.google && (
                <button type="button" className="online-cta" onClick={() => signIn("google")}>
                  {config.demoQuota ? "Try for free" : "Continue with Google"}
                </button>
              )}
              {config.providers.github && (
                <button
                  type="button"
                  className="online-cta online-cta-secondary"
                  onClick={() => signIn("github")}
                >
                  Continue with GitHub
                </button>
              )}
            </div>
          ) : (
            <p className="online-landing-unconfigured">
              Sign-in is not configured on this deployment yet.
            </p>
          )}
          {error && <p className="online-landing-error">{error}</p>}
          <p className="online-landing-footnote">
            Prefer local? <code>npx chamfer</code> runs the full app on your machine, including the
            Autodesk Fusion connector.
          </p>
        </section>

        <aside className="online-landing-sheet" aria-hidden="false">
          <MeasuredMark />
        </aside>
      </main>

      <section className="online-landing-demo">
        <p className="online-landing-eyebrow">In your browser · build123d</p>
        <figure className="online-landing-sheet online-landing-demo-sheet">
          <img
            src="/online/prompt-to-cad.gif"
            width={1120}
            height={700}
            alt="Animated demo: a mounting-plate prompt is sent, Chamfer streams and executes CAD code, the verify gate runs its checks, and the finished plate appears in the 3D viewer"
          />
          <figcaption>One prompt, checked and verified - about two minutes, compressed.</figcaption>
        </figure>
      </section>

      <section className="online-landing-fusion">
        <p className="online-landing-eyebrow">On your desktop · Autodesk Fusion</p>
        <h2>It drives Fusion, too.</h2>
        <p className="online-landing-fusion-lead">
          Chamfer builds native features in Autodesk Fusion, runs a compute, and visually verifies
          the result against your prompt - undoing and retrying until it matches. The Fusion
          connector talks to Fusion on your machine, so run <code>npx chamfer</code> locally and
          start a Fusion conversation.
        </p>
        <figure className="online-landing-sheet online-landing-fusion-sheet">
          <video
            controls
            preload="none"
            playsInline
            poster="/media/fusion-demo-0716-poster.jpg"
            width={1660}
            height={1080}
          >
            <source src="/media/fusion-demo-0716.mp4" type="video/mp4" />
          </video>
          <figcaption>
            A finned motor bearing housing, built and visually verified in Fusion from one prompt.
          </figcaption>
        </figure>
      </section>

      <footer className="online-landing-footer">
        <span>© {new Date().getFullYear()} Min Liu</span>
        <nav>
          <a href="https://github.com/SmartAI/Chamfer" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a
            href="https://www.linkedin.com/in/smartailm/"
            target="_blank"
            rel="noopener noreferrer"
          >
            LinkedIn
          </a>
          <a href="https://maxmliu.com/" target="_blank" rel="noopener noreferrer">
            maxmliu.com
          </a>
        </nav>
      </footer>
    </div>
  );
}
