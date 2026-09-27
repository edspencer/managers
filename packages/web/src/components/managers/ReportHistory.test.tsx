import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { ApiError } from "../../lib/api";
import type { ReportDoc } from "../../lib/types";
import { ReportHistory } from "./ReportHistory";

const managersReport = vi.fn();
const managersDatedReport = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersReport: (...a: unknown[]) => managersReport(...a),
      managersDatedReport: (...a: unknown[]) => managersDatedReport(...a),
    },
  };
});

const dated = (date: string, text: string): ReportDoc => ({
  type: "status",
  date,
  file: `reports/status/${date}.md`,
  frontmatter: {},
  title: null,
  body: `# Status\n\n${text}`,
  updated: `${date}T07:10:00Z`,
  parseError: null,
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:slug/reports/:type" element={<ReportRoute />} />
        <Route path="/projects/:slug/reports/:type/:date" element={<ReportRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

function ReportRoute() {
  const p = useParams();
  return <ReportHistory slug="acme" base="/projects/acme" type={p.type!} date={p.date} />;
}

describe("ReportHistory (M12)", () => {
  beforeEach(() => {
    managersReport.mockReset();
    managersDatedReport.mockReset();
    managersReport.mockResolvedValue({ type: "status", current: null, dates: ["2026-09-26", "2026-09-25"] });
    managersDatedReport.mockImplementation(async (_s: string, _t: string, d: string) =>
      d === "2026-09-26" ? dated(d, "Newest report text.") : d === "2026-09-25" ? dated(d, "Older report text.") : Promise.reject(new ApiError("nope", 404)),
    );
  });

  it("lists the dates, shows the newest by default, and opens an older one", async () => {
    renderAt("/projects/acme/reports/status");
    expect(await screen.findByText("Newest report text.")).toBeInTheDocument();
    const dates = screen.getByTestId("report-dates");
    const links = within(dates).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("aria-current", "page");
    expect(links[1]).toHaveAttribute("href", "/projects/acme/reports/status/2026-09-25");
    await userEvent.click(links[1]!);
    expect(await screen.findByText("Older report text.")).toBeInTheDocument();
    expect(managersDatedReport).toHaveBeenLastCalledWith("acme", "status", "2026-09-25");
    expect(screen.getByText(/Needs you and Alerts are as they were then/)).toBeInTheDocument();
  });

  it("empty: no reports yet, with the way back", async () => {
    managersReport.mockResolvedValue({ type: "status", current: null, dates: [] });
    renderAt("/projects/acme/reports/status");
    expect(await screen.findByText("No status reports yet")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "← Back to Home" })[0]).toHaveAttribute("href", "/projects/acme/home");
  });

  it("a date with no report, an unknown type, and a load error", async () => {
    const { unmount } = renderAt("/projects/acme/reports/status/2020-01-01");
    expect(await screen.findByText("No report for that date")).toBeInTheDocument();
    unmount();
    managersReport.mockRejectedValueOnce(new ApiError("No such report type: digest", 404));
    const second = renderAt("/projects/acme/reports/digest");
    expect(await screen.findByText("No “digest” reports here")).toBeInTheDocument();
    second.unmount();
    managersReport.mockRejectedValueOnce(new ApiError("Internal Server Error", 500));
    renderAt("/projects/acme/reports/status");
    expect(await screen.findByText(/Couldn.t load the report history/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Newest report text.")).toBeInTheDocument();
  });
});
