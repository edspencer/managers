/**
 * SecurityBanner (Managers M14.5): a persistent strip for every dangerous setting
 * the instance was explicitly allowed to boot with (`GET /api/security`), e.g.
 * "No authentication: agents on this host can act as you". Not dismissible: the
 * danger lasts as long as the setting does. Renders nothing while loading, when
 * the read fails, and when there is nothing to warn about.
 */
import { useEffect, useState } from "react";
import { api, type SecurityWarning } from "../lib/api";
import { AlertIcon } from "./icons";

export function SecurityBanner() {
  const [warnings, setWarnings] = useState<SecurityWarning[]>([]);

  useEffect(() => {
    let live = true;
    try {
      api
        .security()
        .then((p) => live && setWarnings(Array.isArray(p?.warnings) ? p.warnings : []))
        .catch(() => undefined);
    } catch {
      /* an older server, or a test double without the route: no banner */
    }
    return () => {
      live = false;
    };
  }, []);

  if (warnings.length === 0) return null;
  return (
    <div role="region" aria-label="Security warning" className="shrink-0 border-b border-danger-edge bg-danger-soft" data-testid="security-banner">
      {warnings.map((w) => (
        <details key={w.code} className="group px-3 py-1.5 text-xs text-danger" data-testid={`security-banner-${w.code}`}>
          <summary className="flex cursor-pointer list-none items-start gap-2 focus-visible:focus-ring">
            <AlertIcon width={14} height={14} className="mt-px shrink-0" />
            <span className="min-w-0 break-words font-semibold">{w.title}</span>
            <span className="ml-auto shrink-0 text-fg-muted underline underline-offset-2 group-open:hidden">Why?</span>
          </summary>
          <p className="mt-1 break-words pl-[22px] text-fg-muted">{w.detail}</p>
        </details>
      ))}
    </div>
  );
}
