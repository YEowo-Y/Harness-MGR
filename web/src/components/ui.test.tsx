import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderWithLang } from "@/test/utils";
import { Badge, Loading, ErrorBox, Empty, Panel } from "@/components/ui";

// EN source-of-truth strings (copied verbatim from src/lib/i18n.tsx)
// common.loading  = "Loading…"
// common.errorTitle = "Could not reach the engine"
// common.errorHintBefore = "Is the API server running? Start it with"

describe("Badge", () => {
  it("renders its children", () => {
    const { container } = render(<Badge>hello</Badge>);
    expect(container.querySelector("span")).toHaveTextContent("hello");
  });

  it('tone="ok" gives the span the text-ok class', () => {
    const { container } = render(<Badge tone="ok">ok</Badge>);
    expect(container.querySelector("span")).toHaveClass("text-ok");
  });

  it("default (no tone) gives the span the text-i60 class", () => {
    const { container } = render(<Badge>neutral</Badge>);
    expect(container.querySelector("span")).toHaveClass("text-i60");
  });
});

describe("Loading", () => {
  it('renders an element with role="status" and the default Loading… text', () => {
    renderWithLang(<Loading />);
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    // EN common.loading = "Loading…"
    expect(status).toHaveTextContent("Loading…");
  });

  it("shows a custom label when provided", () => {
    renderWithLang(<Loading label="Fetching" />);
    expect(screen.getByRole("status")).toHaveTextContent("Fetching");
  });
});

describe("ErrorBox", () => {
  it("shows the error message passed in", () => {
    renderWithLang(<ErrorBox message="boom" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it('shows the errorTitle "Could not reach the engine"', () => {
    renderWithLang(<ErrorBox message="boom" />);
    // EN common.errorTitle = "Could not reach the engine"
    expect(screen.getByText("Could not reach the engine")).toBeInTheDocument();
  });

  it('shows a hint containing "Is the API server running"', () => {
    renderWithLang(<ErrorBox message="boom" />);
    // EN common.errorHintBefore = "Is the API server running? Start it with"
    expect(screen.getByText(/Is the API server running/)).toBeInTheDocument();
  });

  it('renders a <code> element containing "npm run dev"', () => {
    const { container } = renderWithLang(<ErrorBox message="boom" />);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent("npm run dev");
  });
});

describe("Empty", () => {
  it("shows the label text", () => {
    render(<Empty label="nothing here" />);
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });
});

describe("Panel", () => {
  it("renders title, action button, and children when all provided", () => {
    const { container } = render(
      <Panel title="My Title" action={<button>Act</button>}>
        BODY
      </Panel>,
    );
    expect(screen.getByText("My Title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Act" })).toBeInTheDocument();
    expect(screen.getByText("BODY")).toBeInTheDocument();
    // The title bar is the uppercase header div. Asserting it IS here anchors the
    // selector that the omitted-title case below relies on — so that test fails
    // (not passes vacuously) if the `title !== undefined` guard ever regresses.
    expect(container.querySelector("div.uppercase")).not.toBeNull();
  });

  it("renders children and NO title bar when the title prop is omitted", () => {
    const { container } = render(<Panel>BODY2</Panel>);
    expect(screen.getByText("BODY2")).toBeInTheDocument();
    // Structural assertion: the title-bar div is absent. (Querying for a string
    // that was never passed in would pass no matter what Panel rendered.)
    expect(container.querySelector("div.uppercase")).toBeNull();
  });
});
