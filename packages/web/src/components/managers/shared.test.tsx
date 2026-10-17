import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useInternalLinks } from "./shared";

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.hash}</output>;
}

function Body({ href }: { href: string }) {
  const onClick = useInternalLinks();
  return (
    <div onClick={onClick}>
      <a href={href}>link</a>
      <Where />
    </div>
  );
}

/** Click the link; report whether the handler took it over and where the router is. */
function click(href: string) {
  const { unmount } = render(
    <MemoryRouter initialEntries={["/start"]}>
      <Body href={href} />
    </MemoryRouter>,
  );
  const notPrevented = fireEvent.click(screen.getByText("link"));
  const where = screen.getByTestId("where").textContent;
  unmount();
  return { prevented: !notPrevented, where };
}

describe("useInternalLinks", () => {
  it("navigates a root-relative link in-app", () => {
    expect(click("/projects/acme/tasks#t-1")).toEqual({ prevented: true, where: "/projects/acme/tasks#t-1" });
  });

  it("leaves protocol-relative and absolute links to the browser", () => {
    for (const href of ["//evil.example/x", "https://evil.example/x"]) {
      expect(click(href)).toEqual({ prevented: false, where: "/start" });
    }
  });

  // GHSA-wrjc-x8rr-h8h6 (react-router < 7.18, no v6 fix): a URL parser reads
  // `/\host` as `//host`, so a Markdown link an agent wrote could pass the
  // "starts with one slash" test and reach navigate() as an external URL.
  it("does not hand a backslash authority to the router", () => {
    for (const href of ["/\\evil.example/x", "/\\/evil.example", "/\t/evil.example"]) {
      expect(click(href)).toEqual({ prevented: false, where: "/start" });
    }
  });
});
