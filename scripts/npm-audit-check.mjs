#!/usr/bin/env node
/**
 * Guard: fail on any HIGH or CRITICAL npm advisory that is not a documented
 * exception.
 *
 * `npm audit --audit-level=high` alone cannot be a CI gate here: the tree
 * carries high advisories that are triaged as unreachable (fastify 4, the
 * optional nodejs-whisper chain, …) and npm has no way to ignore one. So this
 * runs `npm audit --json`, takes every advisory of severity high or critical,
 * and fails unless its GHSA id is listed in
 * `docs/security/npm-audit-exceptions.json`, each with the reason it is safe.
 * `docs/security/npm-audit.md` is the human-readable triage of the same list.
 *
 * - A NEW high/critical advisory fails the build: fix it, or triage it into
 *   the exceptions file and the doc in the same PR.
 * - An exception that no longer matches anything is reported (not fatal), so
 *   the list shrinks as upstream fixes land.
 * - Moderate and low advisories are listed in the doc but never gate CI.
 * - If npm audit cannot produce a report (registry down), this fails rather
 *   than passing silently.
 *
 * `--include=dev` because `NODE_ENV=production` makes npm audit silently skip
 * devDependencies, which would let a local run pass where CI fails.
 *
 * Reads only package-lock.json, so it needs no `npm ci`. Run it locally with
 * `npm run audit:check`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exceptionsFile = path.join(root, "docs/security/npm-audit-exceptions.json");
const GATED = new Set(["high", "critical"]);

/** @type {{ id: string, package: string, reason: string }[]} */
const exceptions = JSON.parse(readFileSync(exceptionsFile, "utf8")).exceptions;
const excepted = new Map(exceptions.map((e) => [e.id, e]));

let raw;
try {
  raw = execFileSync("npm", ["audit", "--json", "--include=dev"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  // npm audit exits 1 whenever it finds anything; the report is still on stdout.
  raw = err.stdout;
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error("npm-audit-check: npm audit produced no JSON report:\n" + String(raw).slice(0, 2000));
  process.exit(2);
}
if (!report.vulnerabilities) {
  console.error("npm-audit-check: npm audit failed: " + JSON.stringify(report.error ?? report).slice(0, 2000));
  process.exit(2);
}

/** Every advisory, once per (id, package): `via` repeats them per dependent. */
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities)) {
  for (const via of vuln.via) {
    if (typeof via !== "object") continue;
    const id = via.url.split("/").pop();
    advisories.set(`${id} ${via.name}`, { id, name: via.name, severity: via.severity, title: via.title });
  }
}

const unexcepted = [...advisories.values()].filter((a) => GATED.has(a.severity) && !excepted.has(a.id));
const present = new Set([...advisories.values()].map((a) => a.id));
const stale = exceptions.filter((e) => !present.has(e.id));

const counts = report.metadata.vulnerabilities;
console.log(
  `npm audit: ${counts.total} vulnerable packages (critical ${counts.critical}, high ${counts.high}, ` +
    `moderate ${counts.moderate}, low ${counts.low}); ${advisories.size} advisories, ` +
    `${exceptions.length} documented exceptions.`,
);
for (const e of stale) {
  console.log(`note: exception ${e.id} (${e.package}) no longer matches any advisory; remove it and its doc row.`);
}
if (unexcepted.length > 0) {
  console.error(`\n${unexcepted.length} high/critical advisory(ies) with no documented exception:`);
  for (const a of unexcepted) console.error(`  ${a.severity.padEnd(8)} ${a.id}  ${a.name}: ${a.title}`);
  console.error(
    "\nFix them (bump / overrides), or triage each into docs/security/npm-audit-exceptions.json" +
      " and docs/security/npm-audit.md with the reason it is not reachable.",
  );
  process.exit(1);
}
console.log("npm-audit-check: no undocumented high/critical advisories.");
